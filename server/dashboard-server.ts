import { createServer, type Server } from "node:http";
import { parse } from "node:url";

import next from "next";

import { isLoopbackAddress } from "../lib/dashboard-authorization.ts";
import { applyDashboardBoundary } from "../lib/dashboard-boundary.ts";
import { initializeDashboardRuntime } from "../lib/dashboard-runtime.ts";

/**
 * QO-SEC-01 trusted dashboard host.
 *
 * `next start` offers no hook to inspect the TCP peer, so the only header-free
 * place to enforce the network boundary is the HTTP server itself. This host
 * binds loopback, destroys non-loopback connections before Next.js ever sees
 * them, refuses proxied requests, and stamps each surviving request with a
 * per-process marker the snapshot route verifies.
 */

const HOST = "127.0.0.1";
const DEFAULT_PORT = 3000;

function readPort(): number {
  const raw = process.env.PORT?.trim();
  if (!raw) return DEFAULT_PORT;

  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Refusing to start: PORT="${raw}" is not a valid TCP port.`);
  }
  return port;
}

/**
 * Verifies what the socket actually bound, rather than what configuration
 * asked for. An earlier version rejected a non-loopback `HOSTNAME`, which
 * protected nothing — the host is a constant and `HOSTNAME` is never read —
 * while falsely refusing to start in POSIX shells, where `HOSTNAME` normally
 * holds the machine name.
 */
function assertBoundToLoopback(server: Server): void {
  const address = server.address();
  const bound =
    address && typeof address !== "string" ? address.address : String(address);

  if (!isLoopbackAddress(bound)) {
    server.close();
    throw new Error(
      `Refusing to serve: the dashboard bound ${String(bound)}, which is not loopback. ` +
        "Remote access is an unsupported deployment (QO-SEC-01).",
    );
  }
}

async function main(): Promise<void> {
  // `--production` keeps the npm scripts free of shell-specific env syntax,
  // which differs between PowerShell and POSIX shells.
  // `NODE_ENV` is typed read-only by the Next.js ambient types.
  if (process.argv.includes("--production")) {
    Object.assign(process.env, { NODE_ENV: "production" });
  }

  const port = readPort();
  const dev = process.env.NODE_ENV !== "production";
  const { trustedPeerMarker } = initializeDashboardRuntime();

  const app = next({ dev, hostname: HOST, port });
  await app.prepare();
  const handle = app.getRequestHandler();

  const server = createServer((request, response) => {
    if (!applyDashboardBoundary(request, response, trustedPeerMarker)) return;
    void handle(request, response, parse(request.url ?? "/", true));
  });

  // Reject non-loopback peers at connect time as well, so a scanner cannot
  // keep a socket open against the dashboard at all.
  server.on("connection", (socket) => {
    if (!isLoopbackAddress(socket.remoteAddress)) socket.destroy();
  });

  server.listen(port, HOST, () => {
    assertBoundToLoopback(server);
    process.stdout.write(
      `QuotaOps dashboard listening on http://${HOST}:${port} (loopback only)\n`,
    );
  });
}

await main();
