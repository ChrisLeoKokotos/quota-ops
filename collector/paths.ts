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

/** Request/result files of the hidden-desktop worker (overwritten each batch). */
export function getCollectorRunDir(): string {
  return join(getQuotaOpsHome(), "run");
}

/** Attention holds only (statuses, timestamps); see attention-hold.ts. */
/** Opt-in usage ledger (numbers only); see token-ledger.ts. */
export function getTokenLedgerPath(): string {
  return join(getQuotaOpsHome(), "token-ledger.jsonl");
}

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
