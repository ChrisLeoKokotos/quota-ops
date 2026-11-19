import { homedir } from "node:os";
import { join } from "node:path";

export function getQuotaOpsHome(): string {
  return join(homedir(), ".quotaops");
}

export function getCollectorConfigPath(): string {
  return join(getQuotaOpsHome(), "collector.json");
}

export function getProfileRoot(): string {
  return join(getQuotaOpsHome(), "browser-profiles");
}

export function getDefaultProfileDir(id: string): string {
  return join(getProfileRoot(), id);
}

/** Attention holds only (statuses, timestamps); see attention-hold.ts. */
export function getCollectorStatePath(): string {
  return join(getQuotaOpsHome(), "collector-state.json");
}

export function getCollectorTokenPath(): string {
  return join(getQuotaOpsHome(), "collector.token");
}

/** Sanitized statusline snapshots only; raw CLI JSON is never written. */
export function getGoogleStatuslineRoot(): string {
  return join(getQuotaOpsHome(), "google-statusline");
}
