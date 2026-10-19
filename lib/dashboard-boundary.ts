import type { IncomingMessage, ServerResponse } from "node:http";

import {
  PEER_ADDRESS_HEADER,
  TRUSTED_PEER_HEADER,
  hasForwardingHeader,
  isLoopbackAddress,
} from "./dashboard-authorization.ts";

/**
 * The QO-SEC-01 network boundary, separated from the Next.js server so it can
 * be driven by real HTTP requests in tests. Asserting that the server's source
 * text mentions a control is not evidence the control runs.
 *
 * **Known limit — a transparent loopback relay defeats this.** The peer check
 * asks whether the TCP connection came from 127.0.0.0/8, and a relay such as
 * `netsh interface portproxy`, an nginx `proxy_pass` with no `proxy_set_header`
 * lines, `ssh -R`, or a tunnelling tool connects from loopback on the
 * attacker's behalf. None of those add an `X-Forwarded-*` header by default,
 * so `isProxiedRequest` does not see them: that check catches a *cooperative*
 * proxy, not a transparent one, and there is no header-based way to catch the
 * latter. Interposing such a relay is a deliberate local configuration change,
 * and it takes the deployment outside the supported boundary — but nothing
 * here detects or prevents it. See docs/residual-risk-decision.md, Risk C.
 */

export function denyRequest(
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
 * Removes the headers a client could use to impersonate the trusted layer.
 * Node lower-cases and joins repeated headers into one key, so a single delete
 * removes every inbound copy regardless of casing or repetition.
 *
 * The property that actually protects these two headers is the unconditional
 * assignment below, which replaces any inbound value outright — a mutation
 * test with this call removed still passes. It is kept as defence for any
 * header a future change stamps only conditionally, not because the ordering
 * is load-bearing today.
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

/**
 * Applies the boundary to one request. Returns false when the request was
 * refused and a response has already been sent, true when it may proceed with
 * the trusted marker stamped.
 */
export function applyDashboardBoundary(
  request: IncomingMessage,
  response: ServerResponse,
  trustedPeerMarker: string,
): boolean {
  const peer = request.socket.remoteAddress;

  if (!isLoopbackAddress(peer)) {
    denyRequest(response, 403, "non_loopback_peer");
    request.socket.destroy();
    return false;
  }

  if (isProxiedRequest(request)) {
    denyRequest(response, 403, "forwarded_request");
    return false;
  }

  stripSpoofableHeaders(request);
  request.headers[TRUSTED_PEER_HEADER] = trustedPeerMarker;
  request.headers[PEER_ADDRESS_HEADER] = peer ?? "";
  return true;
}
