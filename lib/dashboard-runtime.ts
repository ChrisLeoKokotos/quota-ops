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

/** Returns the running process secrets, or null when the trusted server is absent. */
export function getDashboardRuntime(): DashboardRuntimeSecrets | null {
  const secret = process.env[SECRET_ENV];
  const marker = process.env[MARKER_ENV];
  if (!secret || !marker) return null;

  return {
    capabilitySecret: Buffer.from(secret, "base64url"),
    trustedPeerMarker: marker,
  };
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
