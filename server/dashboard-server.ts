import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { parse } from "node:url";

import next from "next";

import { isLoopbackAddress } from "../lib/dashboard-authorization.ts";
import { applyDashboardBoundary } from "../lib/dashboard-boundary.ts";
import {
  DESCRIPTOR_VERSION,
  INSTANCE_PATH,
  createInstanceId,
  getDescriptorPath,
  probeDescriptor,
  readDescriptor,
  removeOwnDescriptor,
  removeOwnDescriptorSync,
  writeDescriptor,
} from "../lib/dashboard-descriptor.ts";
import { initializeDashboardRuntime } from "../lib/dashboard-runtime.ts";

/**
 * QO-SEC-01 trusted dashboard host.
 *
 * `next start` offers no hook to inspect the TCP peer, so the only header-free
 * place to enforce the network boundary is the HTTP server itself. This host
 * binds loopback, destroys non-loopback connections before Next.js ever sees
 * them, refuses proxied requests, and stamps each surviving request with a
 * per-process marker the snapshot route verifies.
 *
 * Risk C (C2): the port is allocated by the operating system at launch rather
 * than fixed at 3000. A relay configured in advance against 3000 no longer
 * reaches anything. A relay aimed at the *current* port still does — the port
 * is not a secret and this is a mitigation, not a fix.
 */

const HOST = "127.0.0.1";

/**
 * `0` asks the OS for a free port and binds it in one step, so there is no
 * window between choosing a port and claiming it for another process to take.
 * There is deliberately no fallback to 3000: a silent fallback would quietly
 * restore the configuration Risk C is meant to retire.
 */
function readRequestedPort(): number {
  const raw = process.env.PORT?.trim();
  if (!raw) return 0;

  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`Refusing to start: PORT="${raw}" is not a valid TCP port.`);
  }
  return port;
}

/**
 * Verifies what the socket actually bound, rather than what configuration
 * asked for, and returns the allocated port.
 */
function boundLoopbackPort(server: Server): number {
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Refusing to serve: the dashboard did not bind a TCP port.");
  }

  if (!isLoopbackAddress(address.address)) {
    server.close();
    throw new Error(
      `Refusing to serve: the dashboard bound ${address.address}, which is not loopback. ` +
        "Remote access is an unsupported deployment (QO-SEC-01).",
    );
  }

  return address.port;
}

/**
 * Refuses to start beside a running instance rather than overwriting its
 * descriptor, which would strand the launcher on a port it can no longer find.
 */
async function assertNoLiveInstance(): Promise<void> {
  const existing = await probeDescriptor(await readDescriptor());
  if (existing.state !== "live") return;

  throw new Error(
    `Refusing to start: QuotaOps is already running on port ${existing.descriptor.port} ` +
      `(pid ${existing.descriptor.pid}). Stop it first, or remove ${getDescriptorPath()} ` +
      "if that process is gone.",
  );
}

/**
 * Answers the identity probe. Served by the trusted host rather than Next so
 * that discovery works before `prepare()` finishes and does not depend on
 * application routing. It returns no secret: the instance id proves which
 * process owns the port, nothing more.
 */
function serveInstance(
  response: ServerResponse,
  instanceId: string,
  port: number,
): void {
  response.statusCode = 200;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.end(
    JSON.stringify({
      version: DESCRIPTOR_VERSION,
      instanceId,
      pid: process.pid,
      port,
    }),
  );
}

function serveStarting(response: ServerResponse): void {
  response.statusCode = 503;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Retry-After", "1");
  response.end(JSON.stringify({ error: "dashboard_starting" }));
}

type NextHandler = (
  request: IncomingMessage,
  response: ServerResponse,
  parsedUrl: ReturnType<typeof parse>,
) => Promise<void>;

async function main(): Promise<void> {
  // `--production` keeps the npm scripts free of shell-specific env syntax,
  // which differs between PowerShell and POSIX shells.
  // `NODE_ENV` is typed read-only by the Next.js ambient types.
  if (process.argv.includes("--production")) {
    Object.assign(process.env, { NODE_ENV: "production" });
  }

  await assertNoLiveInstance();

  const dev = process.env.NODE_ENV !== "production";
  const instanceId = createInstanceId();
  const { trustedPeerMarker } = initializeDashboardRuntime();

  // Next.js needs the port at construction, and the port is only known once
  // the socket is bound. Bind first and hold requests until the app is ready,
  // rather than starting a throwaway server just to discover a free port.
  let handle: NextHandler | null = null;
  let port = 0;

  const server = createServer((request, response) => {
    if (!applyDashboardBoundary(request, response, trustedPeerMarker)) return;

    const path = (request.url ?? "/").split("?")[0];
    if (path === INSTANCE_PATH) {
      serveInstance(response, instanceId, port);
      return;
    }

    if (!handle) {
      serveStarting(response);
      return;
    }

    void handle(request, response, parse(request.url ?? "/", true));
  });

  // Reject non-loopback peers at connect time as well, so a scanner cannot
  // keep a socket open against the dashboard at all.
  server.on("connection", (socket) => {
    if (!isLoopbackAddress(socket.remoteAddress)) socket.destroy();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(readRequestedPort(), HOST, resolve);
  });

  port = boundLoopbackPort(server);

  await writeDescriptor({
    version: DESCRIPTOR_VERSION,
    port,
    pid: process.pid,
    instanceId,
    startedAt: new Date().toISOString(),
  });

  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    server.close();
    void removeOwnDescriptor(instanceId).finally(() => {
      process.exit(signal === "SIGINT" ? 130 : 0);
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  // Backstop for exits that deliver no signal, which Windows does for some
  // termination paths. A stale descriptor is handled correctly by discovery,
  // so this is hygiene rather than a correctness requirement.
  process.on("exit", () => removeOwnDescriptorSync(instanceId));

  try {
    const app = next({ dev, hostname: HOST, port });
    await app.prepare();
    handle = app.getRequestHandler() as NextHandler;
  } catch (error) {
    // A half-started dashboard must not leave a descriptor pointing at a port
    // that only ever answers 503.
    await removeOwnDescriptor(instanceId);
    server.close();
    throw error;
  }

  process.stdout.write(
    `QuotaOps dashboard listening on http://${HOST}:${port} (loopback only)\n`,
  );
}

await main();
