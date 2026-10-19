import {
  createCapabilitySecret,
  mintDashboardCapability,
} from "./dashboard-authorization.ts";

/**
 * Per-process secrets shared between the trusted dashboard server and the
 * snapshot route. The server publishes them into the process environment
 * before Next.js starts; they are never prefixed `NEXT_PUBLIC_`, so they are
 * not inlined into client bundles.
 *
 * Fail-closed: when the dashboard is started without the trusted server
 * (for example plain `next start`), these are absent and the snapshot route
 * denies every request instead of falling back to header-only checks.
 */

export const SECRET_ENV = "QUOTAOPS_DASHBOARD_CAPABILITY_SECRET";
export const MARKER_ENV = "QUOTAOPS_DASHBOARD_PEER_MARKER";

export interface DashboardRuntimeSecrets {
  capabilitySecret: Buffer;
  trustedPeerMarker: string;
}

/** Generates fresh secrets and publishes them for the in-process Next server. */
export function initializeDashboardRuntime(): DashboardRuntimeSecrets {
  const capabilitySecret = createCapabilitySecret();
  const trustedPeerMarker = createCapabilitySecret().toString("base64url");

  process.env[SECRET_ENV] = capabilitySecret.toString("base64url");
  process.env[MARKER_ENV] = trustedPeerMarker;

  return { capabilitySecret, trustedPeerMarker };
}

/** Both secrets are 32 bytes, so base64url is always 43 characters. */
const SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/**
 * Returns the running process secrets, or null when the trusted server is
 * absent.
 *
 * The values are shape-checked rather than trusted. `Buffer.from(x,
 * "base64url")` never throws: it silently yields a 0-byte buffer for input it
 * cannot decode, and `createHmac` accepts an empty key. Without this check, a
 * process started with these variables pre-set to junk would sign capabilities
 * with an empty key instead of failing closed.
 */
export function getDashboardRuntime(): DashboardRuntimeSecrets | null {
  const secret = process.env[SECRET_ENV];
  const marker = process.env[MARKER_ENV];
  if (!secret || !marker) return null;
  if (!SECRET_PATTERN.test(secret) || !SECRET_PATTERN.test(marker)) return null;

  const capabilitySecret = Buffer.from(secret, "base64url");
  if (capabilitySecret.length !== 32) return null;

  return { capabilitySecret, trustedPeerMarker: marker };
}

/**
 * Mints a short-lived capability for the dashboard page to hand to the
 * browser. Returns null when the trusted server is not running, which keeps
 * the UI honest instead of implying an authorized session.
 */
export function issueDashboardCapability(): string | null {
  const runtime = getDashboardRuntime();
  if (!runtime) return null;
  return mintDashboardCapability(runtime.capabilitySecret);
}
