import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * QO-SEC-01 authorization boundary for the dashboard snapshot proxy.
 *
 * Request headers are attacker-controlled and are never treated as
 * authentication. Two independent controls gate sensitive snapshots:
 *
 *   1. Peer enforcement. The trusted dashboard server inspects the TCP peer
 *      address and refuses every connection that did not originate on the
 *      loopback interface. Headers cannot influence that decision.
 *   2. Capability tokens. The server mints a short-lived HMAC capability from
 *      a per-process secret and the route verifies it in constant time, so a
 *      request that bypassed the trusted layer cannot forge authorization.
 *
 * Residual risk: any process running under the same OS account can read the
 * capability and reach the loopback listener. This design bounds *network*
 * exposure; it is not a defence against same-user local compromise.
 */

export const TRUSTED_PEER_HEADER = "x-quotaops-peer";
export const CAPABILITY_HEADER = "x-quotaops-capability";
/** Verified TCP peer address stamped by the trusted server. */
export const PEER_ADDRESS_HEADER = "x-quotaops-peer-address";

/** Headers that only appear when a proxy sits in front of the dashboard. */
export const FORWARDING_HEADERS = [
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-forwarded-port",
  "x-real-ip",
  "forwarded",
] as const;

/**
 * Detects a proxied request. This check belongs to the trusted server, where
 * headers are still exactly what the client sent: Next.js synthesizes its own
 * `x-forwarded-*` headers downstream, so a route handler cannot distinguish
 * them from client input. The trusted server refuses proxied requests before
 * stamping its marker, so a request reaching the route has already passed it.
 */
export function hasForwardingHeader(
  header: (name: string) => string | null | undefined,
): boolean {
  return FORWARDING_HEADERS.some((name) => {
    const value = header(name);
    return value !== null && value !== undefined;
  });
}

const CAPABILITY_PREFIX = "qo1";
const DEFAULT_CAPABILITY_TTL_MS = 10 * 60 * 1000;

export type AuthorizationDenialReason =
  | "non_loopback_peer"
  | "forwarded_request"
  | "untrusted_peer_marker"
  | "invalid_host"
  | "cross_origin"
  | "missing_capability"
  | "invalid_capability"
  | "expired_capability";

export type AuthorizationDecision =
  | { allowed: true }
  | { allowed: false; reason: AuthorizationDenialReason };

/**
 * Loopback check covering IPv4 `127.0.0.0/8`, IPv6 `::1` and IPv4-mapped
 * IPv6 (`::ffff:127.0.0.1`, `::ffff:7f00:1`).
 *
 * The address is expanded to eight 16-bit groups rather than pattern-matched,
 * because the near-miss forms matter here. `::127.0.0.1` (deprecated
 * IPv4-compatible) and `::ffff:0:127.0.0.1` (RFC 2765 IPv4-translated) embed
 * 127.0.0.1 but are **not** loopback addresses, and a regex that treats the
 * `ffff:` and `0:` segments as optional accepts both.
 */
export function isLoopbackAddress(address: string | undefined | null): boolean {
  if (!address) return false;

  let value = address.trim().toLowerCase();
  if (value.length === 0) return false;

  // Strip bracket notation and an RFC 6874 zone identifier (fe80::1%eth0).
  if (value.startsWith("[") && value.includes("]")) {
    value = value.slice(1, value.indexOf("]"));
  }
  const zoneIndex = value.indexOf("%");
  if (zoneIndex !== -1) value = value.slice(0, zoneIndex);

  if (!value.includes(":")) return isLoopbackIpv4(value);

  const groups = expandIpv6(value);
  if (!groups) return false;

  // ::1 — the IPv6 loopback address itself.
  if (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) {
    return true;
  }

  // ::ffff:a.b.c.d — an IPv4 address carried over an IPv6 socket.
  const isIpv4Mapped =
    groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff;
  if (!isIpv4Mapped) return false;

  return ((groups[6] ?? 0) >>> 8) === 127;
}

/** Returns eight 16-bit groups, or null when the text is not a valid address. */
function expandIpv6(value: string): number[] | null {
  let head = value;
  let embeddedIpv4: number[] | null = null;

  // A trailing dotted quad occupies the final two groups.
  const lastColon = head.lastIndexOf(":");
  const tail = head.slice(lastColon + 1);
  if (tail.includes(".")) {
    const octets = parseIpv4Octets(tail);
    if (!octets) return null;
    embeddedIpv4 = octets;
    // The quad stands in for the final two groups, not one.
    head = head.slice(0, lastColon + 1) + "0:0";
  }

  const doubleColon = head.indexOf("::");
  if (doubleColon !== head.lastIndexOf("::")) return null;

  let parts: string[];
  if (doubleColon === -1) {
    parts = head.split(":");
  } else {
    const before = head.slice(0, doubleColon);
    const after = head.slice(doubleColon + 2);
    const left = before.length > 0 ? before.split(":") : [];
    const right = after.length > 0 ? after.split(":") : [];
    const missing = 8 - left.length - right.length;
    if (missing < 1) return null;
    parts = [...left, ...Array.from({ length: missing }, () => "0"), ...right];
  }

  if (parts.length !== 8) return null;

  const groups: number[] = [];
  for (const part of parts) {
    if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
    groups.push(Number.parseInt(part, 16));
  }

  if (embeddedIpv4) {
    groups[6] = ((embeddedIpv4[0] ?? 0) << 8) | (embeddedIpv4[1] ?? 0);
    groups[7] = ((embeddedIpv4[2] ?? 0) << 8) | (embeddedIpv4[3] ?? 0);
  }

  return groups;
}

function parseIpv4Octets(value: string): number[] | null {
  const octets = value.split(".");
  if (octets.length !== 4) return null;

  const parsed: number[] = [];
  for (const octet of octets) {
    // Reject leading zeros: some resolvers read "0177" as octal.
    if (!/^(0|[1-9]\d{0,2})$/.test(octet)) return null;
    const numeric = Number(octet);
    if (numeric > 255) return null;
    parsed.push(numeric);
  }

  return parsed;
}

function isLoopbackIpv4(value: string): boolean {
  const octets = parseIpv4Octets(value);
  return octets !== null && octets[0] === 127;
}

/** A hostname is loopback-safe only when it resolves to this machine by definition. */
export function isLoopbackHostname(hostname: string): boolean {
  const value = hostname.trim().toLowerCase();
  if (value === "localhost") return true;
  return isLoopbackAddress(value);
}

export function createCapabilitySecret(): Buffer {
  return randomBytes(32);
}

function sign(secret: Buffer, payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function mintDashboardCapability(
  secret: Buffer,
  now: number = Date.now(),
  ttlMs: number = DEFAULT_CAPABILITY_TTL_MS,
): string {
  const expiresAt = now + ttlMs;
  const payload = `${CAPABILITY_PREFIX}.${expiresAt}`;
  return `${payload}.${sign(secret, payload)}`;
}

export function verifyDashboardCapability(
  secret: Buffer,
  capability: string,
  now: number = Date.now(),
): AuthorizationDecision {
  const parts = capability.split(".");
  if (parts.length !== 3) return { allowed: false, reason: "invalid_capability" };

  const [prefix, expiry, mac] = parts;
  if (prefix !== CAPABILITY_PREFIX || !expiry || !mac) {
    return { allowed: false, reason: "invalid_capability" };
  }
  if (!/^\d{1,15}$/.test(expiry)) {
    return { allowed: false, reason: "invalid_capability" };
  }

  const expected = Buffer.from(sign(secret, `${prefix}.${expiry}`), "utf8");
  const supplied = Buffer.from(mac, "utf8");
  if (
    expected.length !== supplied.length ||
    !timingSafeEqual(expected, supplied)
  ) {
    return { allowed: false, reason: "invalid_capability" };
  }

  if (Number(expiry) <= now) {
    return { allowed: false, reason: "expired_capability" };
  }

  return { allowed: true };
}

export interface SnapshotRequestContext {
  /** TCP peer address observed by the trusted server, never a header value. */
  remoteAddress: string | undefined | null;
  /** Lower-cased header lookup. */
  header: (name: string) => string | null;
  /** Per-process marker the trusted server injects after stripping inbound copies. */
  trustedPeerMarker: string;
  capabilitySecret: Buffer;
  now?: number;
}

/**
 * Full authorization decision for a snapshot request. Every control fails
 * closed, and no single header can satisfy the check on its own.
 */
/**
 * Every control except the capability check: proves the request arrived over
 * loopback through the trusted server and targets a same-origin local host.
 */
export function evaluateTrustedLocalRequest(
  context: SnapshotRequestContext,
): AuthorizationDecision {
  if (!isLoopbackAddress(context.remoteAddress)) {
    return { allowed: false, reason: "non_loopback_peer" };
  }

  const marker = context.header(TRUSTED_PEER_HEADER);
  if (!marker || !constantTimeEquals(marker, context.trustedPeerMarker)) {
    return { allowed: false, reason: "untrusted_peer_marker" };
  }

  const host = context.header("host") ?? "";
  const hostMatch = /^([^:]+|\[[^\]]+\]):(\d{2,5})$/.exec(host);
  if (!hostMatch?.[1] || !hostMatch[2]) {
    return { allowed: false, reason: "invalid_host" };
  }
  const hostname = hostMatch[1].replace(/^\[|\]$/g, "");
  if (!isLoopbackHostname(hostname)) {
    return { allowed: false, reason: "invalid_host" };
  }

  const origin = context.header("origin");
  if (origin !== null) {
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      return { allowed: false, reason: "cross_origin" };
    }
    if (
      parsed.protocol !== "http:" ||
      !isLoopbackHostname(parsed.hostname) ||
      parsed.port !== hostMatch[2]
    ) {
      return { allowed: false, reason: "cross_origin" };
    }
  }

  return { allowed: true };
}

/**
 * Full authorization decision for a snapshot request. Every control fails
 * closed, and no single header can satisfy the check on its own.
 */
export function evaluateSnapshotRequest(
  context: SnapshotRequestContext,
): AuthorizationDecision {
  const local = evaluateTrustedLocalRequest(context);
  if (!local.allowed) return local;

  const capability = context.header(CAPABILITY_HEADER);
  if (!capability) return { allowed: false, reason: "missing_capability" };

  return verifyDashboardCapability(
    context.capabilitySecret,
    capability,
    context.now ?? Date.now(),
  );
}

function constantTimeEquals(supplied: string, expected: string): boolean {
  const suppliedBytes = Buffer.from(supplied, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  return (
    suppliedBytes.length === expectedBytes.length &&
    timingSafeEqual(suppliedBytes, expectedBytes)
  );
}
