import assert from "node:assert/strict";
import { createServer, type Server as HttpServer } from "node:http";
import {
  connect,
  createServer as createTcpServer,
  type Server as TcpServer,
  type Socket,
} from "node:net";
import { networkInterfaces } from "node:os";
import { once } from "node:events";
import test, { afterEach } from "node:test";

import { applyDashboardBoundary } from "../lib/dashboard-boundary.ts";

/**
 * Risk C (C2) — what an OS-allocated port does and does not buy.
 *
 * A transparent relay connects to the dashboard from loopback on a remote
 * caller's behalf and adds no `X-Forwarded-*` header, so it is
 * indistinguishable from a local client at the HTTP layer. Moving off a fixed
 * port 3000 breaks a relay that was configured in advance. It does **not**
 * break a relay aimed at the port currently in use.
 *
 * Both halves are asserted here so neither can be quietly misread as the
 * other. A passing suite is not evidence that transparent relays are blocked.
 */

const MARKER = "relay-test-marker-value";

const httpServers: HttpServer[] = [];
const tcpServers: TcpServer[] = [];

afterEach(async () => {
  // fetch keeps connections alive, so `close()` alone never resolves here.
  for (const server of tcpServers.splice(0)) {
    for (const socket of relaySockets.splice(0)) socket.destroy();
    server.close();
    await once(server, "close").catch(() => undefined);
  }
  for (const server of httpServers.splice(0)) {
    server.closeAllConnections();
    server.close();
    await once(server, "close").catch(() => undefined);
  }
});

const relaySockets: Socket[] = [];

/** Stands in for the trusted dashboard host, with the real boundary applied. */
async function startDashboard(): Promise<number> {
  let reached = 0;

  const server = createServer((request, response) => {
    if (!applyDashboardBoundary(request, response, MARKER)) return;
    reached += 1;
    response.statusCode = 200;
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ ok: true, reached }));
  });

  httpServers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return address.port;
}

/** A plain TCP forwarder: the transparent relay case, no headers added. */
async function startRelay(targetPort: number): Promise<number> {
  const relay = createTcpServer((downstream) => {
    const upstream = connect(targetPort, "127.0.0.1");
    relaySockets.push(downstream, upstream);
    downstream.pipe(upstream);
    upstream.pipe(downstream);
    downstream.on("error", () => undefined);
    upstream.on("error", () => downstream.destroy());
  });

  tcpServers.push(relay);
  relay.listen(0, "0.0.0.0");
  await once(relay, "listening");

  const address = relay.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return address.port;
}

/**
 * Retries only a transport-level failure. A relayed request opens a fresh TCP
 * connection pair that cannot be pooled, and on a host whose ephemeral range
 * is saturated with TIME_WAIT entries the connect itself can fail. That is an
 * environment condition, not a property of the boundary: the status assertions
 * below are never retried, so a wrong status still fails immediately.
 */
async function fetchThroughRelay(url: string): Promise<Response> {
  let lastError: unknown;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return await fetch(url, { signal: AbortSignal.timeout(3_000) });
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 150 * (attempt + 1)));
    }
  }

  throw lastError;
}

function lanAddress(): string | null {
  const entry = Object.values(networkInterfaces())
    .flat()
    .find((item) => item && item.family === "IPv4" && !item.internal);
  return entry ? entry.address : null;
}

test("C2 benefit: a relay aimed at a port the dashboard no longer uses reaches nothing", async () => {
  const livePort = await startDashboard();

  // Stand in for a relay configured in advance against a different port, the
  // way `netsh interface portproxy connectport=3000` would be.
  const stalePort = livePort === 65_535 ? livePort - 1 : livePort + 1;
  const relayPort = await startRelay(stalePort);

  let failed = false;
  try {
    await fetch(`http://127.0.0.1:${relayPort}/api/collector/capability`, {
      signal: AbortSignal.timeout(3_000),
    });
  } catch {
    failed = true;
  }

  assert.equal(
    failed,
    true,
    "a relay pointed at an unused port must not reach the dashboard",
  );
});

test("C2 limit: a relay aimed at the active port is still served", async () => {
  // This asserts the residual risk, not a defect. It must keep passing: if it
  // ever fails, the relay path changed and the documented risk needs revising.
  const livePort = await startDashboard();
  const relayPort = await startRelay(livePort);

  const response = await fetchThroughRelay(`http://127.0.0.1:${relayPort}/`);

  assert.equal(
    response.status,
    200,
    "a relay on the active port reaches the dashboard; C2 mitigates, it does not block",
  );
});

test("C2 limit holds for a caller arriving over the LAN through the relay", async (t) => {
  const lan = lanAddress();
  if (!lan) {
    t.skip("no non-loopback IPv4 interface available");
    return;
  }

  const livePort = await startDashboard();
  const relayPort = await startRelay(livePort);

  // The relay binds every interface, so this request genuinely leaves and
  // re-enters the host, yet the dashboard sees a loopback peer.
  const response = await fetchThroughRelay(`http://${lan}:${relayPort}/`);

  assert.equal(
    response.status,
    200,
    "the dashboard cannot distinguish a relayed remote caller from a local one",
  );
});

test("a direct remote request, with no relay, is still refused", async () => {
  // The boundary is intact for everything except a loopback relay.
  const server = createServer((request, response) => {
    if (!applyDashboardBoundary(request, response, MARKER)) return;
    response.statusCode = 200;
    response.end("{}");
  });

  httpServers.push(server);
  server.listen(0, "0.0.0.0");
  await once(server, "listening");

  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");

  const lan = lanAddress();
  if (!lan) return;

  let status: number | null = null;
  try {
    const response = await fetch(`http://${lan}:${address.port}/`, {
      signal: AbortSignal.timeout(3_000),
    });
    status = response.status;
    await response.arrayBuffer();
  } catch {
    status = null;
  }

  assert.equal(
    status === null || status === 403,
    true,
    `a direct non-loopback peer must be refused, got HTTP ${String(status)}`,
  );
});
