import assert from "node:assert/strict";
import { createServer, request, Agent } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

import {
  EXIT_DRAINED,
  EXIT_DRAIN_TIMEOUT,
  EXIT_HARD_DEADLINE,
  SHUTDOWN_HARD_EXIT_MS,
  createCollectorShutdown,
} from "../collector/shutdown.ts";
import { MonitoringController } from "../collector/monitoring.ts";

// Issue #47 regressions for the collector side of Quit. Before the fix the
// handler awaited an unbounded drain, then server.close(), which also waits
// for idle keep-alive sockets; nothing bounded the utility process lifetime.

function waitForExit() {
  let resolveExit!: (code: number) => void;
  // In the utility process parentPort keeps the event loop alive, which is
  // exactly when the (unref'd) hard deadline matters. Model that here.
  const parentPort = setInterval(() => undefined, 60_000);
  const exited = new Promise<number>((resolve) => { resolveExit = resolve; })
    .finally(() => clearInterval(parentPort));
  return { exited, exit: (code: number) => resolveExit(code) };
}

async function keepAliveServer() {
  const server = createServer((_req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end("{}");
  });
  server.keepAliveTimeout = 5_000; // the collector's production value
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  // A client that keeps its socket open after the response, as the Electron
  // main process and diagnostics clients do.
  const agent = new Agent({ keepAlive: true });
  await new Promise<void>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path: "/health", agent }, (res) => {
      res.resume();
      res.on("end", resolve);
    });
    req.on("error", reject);
    req.end();
  });
  return { server, port, agent };
}

test("shutdown completes while a provider collection never settles", async () => {
  const monitoring = new MonitoringController<number>(
    () => new Promise<number>(() => {}), // ignores cancellation entirely
    () => undefined,
  );
  monitoring.queueRefresh();
  const { server, agent } = await keepAliveServer();
  const { exited, exit } = waitForExit();
  let schedulingStopped = 0;
  const shutdown = createCollectorShutdown({
    monitoring,
    server,
    stopScheduling: () => { schedulingStopped++; },
    exit,
    drainMs: 100,
    hardExitMs: 5_000,
  });

  const started = Date.now();
  shutdown();
  shutdown(); // re-entrant shutdown requests are ignored
  const code = await exited;
  const elapsed = Date.now() - started;
  agent.destroy();

  assert.equal(code, EXIT_DRAIN_TIMEOUT);
  assert.equal(schedulingStopped, 1);
  assert.equal(server.listening, false, "loopback listener must be closed before exit");
  // Well below keepAliveTimeout: idle keep-alive sockets are closed actively.
  assert.ok(elapsed < 2_000, `shutdown took ${elapsed} ms`);
});

test("a cancellable collection drains cleanly and exits 0", async () => {
  const monitoring = new MonitoringController<number>(
    (_invalidated, signal) => new Promise<number>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
    }),
    () => undefined,
  );
  monitoring.queueRefresh();
  const { server, agent } = await keepAliveServer();
  const { exited, exit } = waitForExit();
  createCollectorShutdown({
    monitoring, server, stopScheduling: () => undefined, exit, drainMs: 2_000, hardExitMs: 5_000,
  })();
  assert.equal(await exited, EXIT_DRAINED);
  agent.destroy();
  assert.equal(server.listening, false);
});

test("the hard deadline exits even if closing the listener stalls", async () => {
  const { exited, exit } = waitForExit();
  const started = Date.now();
  createCollectorShutdown({
    monitoring: { stop: () => undefined, waitUntilIdle: async () => true },
    server: { close: () => undefined /* callback never runs */, closeAllConnections: () => undefined },
    stopScheduling: () => undefined,
    exit,
    drainMs: 50,
    hardExitMs: 150,
  })();
  assert.equal(await exited, EXIT_HARD_DEADLINE);
  assert.ok(Date.now() - started < 2_000);
});

test("the hard deadline also covers a drain promise that never resolves", async () => {
  const { exited, exit } = waitForExit();
  createCollectorShutdown({
    monitoring: { stop: () => undefined, waitUntilIdle: () => new Promise<boolean>(() => {}) },
    server: { close: () => undefined, closeAllConnections: () => undefined },
    stopScheduling: () => undefined,
    exit,
    drainMs: 50,
    hardExitMs: 120,
  })();
  assert.equal(await exited, EXIT_HARD_DEADLINE);
});

test("production bounds keep the collector inside the parent's Quit deadline", async () => {
  const { readFile } = await import("node:fs/promises");
  const main = await readFile(new URL("../desktop/electron-ipc/main.js", import.meta.url), "utf8");
  const match = /const COLLECTOR_QUIT_DEADLINE_MS = ([\d_]+);/.exec(main);
  assert.ok(match, "main.js must declare its collector Quit deadline");
  const parentDeadline = Number((match[1] ?? "").replaceAll("_", ""));
  assert.ok(SHUTDOWN_HARD_EXIT_MS + 5_000 <= parentDeadline,
    "the collector must finish on its own before the parent kills it");
  assert.ok(parentDeadline <= 30_000, "Quit must not wait the former 45 s");
  const service = await readFile(new URL("../collector/service.ts", import.meta.url), "utf8");
  assert.match(service, /createCollectorShutdown\(/);
  assert.match(service, /collectProviderUsage\(account, \{ signal, visible \}\)/);
});
