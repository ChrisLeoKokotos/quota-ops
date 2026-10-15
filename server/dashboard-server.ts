import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { parse } from "node:url";

import next from "next";

import {
  PEER_ADDRESS_HEADER,
  TRUSTED_PEER_HEADER,
  hasForwardingHeader,
  isLoopbackAddress,
} from "../lib/dashboard-authorization.ts";
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
 * The host is not configurable. An operator who wants remote access must go
 * through the QO-SEC-05 remote-access review, not an environment variable.
 */
function assertLoopbackOnlyConfiguration(): void {
  const requested = process.env.HOSTNAME?.trim();
  if (requested && !isLoopbackAddress(requested) && requested !== "localhost") {
    throw new Error(
      `Refusing to start: HOSTNAME="${requested}" would expose the dashboard beyond loopback. ` +
        "Remote access is an unsupported deployment (QO-SEC-01).",
    );
  }
}

function denyRequest(
  response: ServerResponse,
  status: number,
  reason: string,
): void {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.end(JSON.stringify({ error: reason }));
}

/**
 * Removes every header a client could use to impersonate the trusted layer.
 * Runs before any marker is applied, so an inbound copy can never survive.
 */
export function stripSpoofableHeaders(request: IncomingMessage): void {
  delete request.headers[TRUSTED_PEER_HEADER];
  delete request.headers[PEER_ADDRESS_HEADER];
}

export function isProxiedRequest(request: IncomingMessage): boolean {
  return hasForwardingHeader((name) => {
    const value = request.headers[name];
    return Array.isArray(value) ? value[0] ?? null : value ?? null;
  });
}

async function main(): Promise<void> {
  assertLoopbackOnlyConfiguration();

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
    const peer = request.socket.remoteAddress;

    if (!isLoopbackAddress(peer)) {
      denyRequest(response, 403, "non_loopback_peer");
      request.socket.destroy();
      return;
    }

    if (isProxiedRequest(request)) {
      denyRequest(response, 403, "forwarded_request");
      return;
    }

    stripSpoofableHeaders(request);
    request.headers[TRUSTED_PEER_HEADER] = trustedPeerMarker;
    request.headers[PEER_ADDRESS_HEADER] = peer ?? "";

    void handle(request, response, parse(request.url ?? "/", true));
  });

  // Reject non-loopback peers at connect time as well, so a scanner cannot
  // keep a socket open against the dashboard at all.
  server.on("connection", (socket) => {
    if (!isLoopbackAddress(socket.remoteAddress)) socket.destroy();
  });

  server.listen(port, HOST, () => {
    process.stdout.write(
      `QuotaOps dashboard listening on http://${HOST}:${port} (loopback only)\n`,
    );
  });
}

await main();
