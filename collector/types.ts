import type { Provider, QuotaAccount } from "../lib/quota.ts";
import type { TokenAnalyticsSnapshot, TokenScanStatus } from "../lib/token-analytics.ts";

export type CollectorAccountStatus =
  | "ok"
  /** Configured and enabled, not checked yet in this collector run. */
  | "configured"
  | "login_required"
  | "verification_required"
  | "unavailable"
  | "unsupported";

export interface CollectorAccountConfig {
  id: string;
  label: string;
  // Google uses local CLI events; no provider browser sessions.
  provider: Provider;
  profileDir: string;
  enabled: boolean;
}

export interface TokenAnalyticsConsent {
  claudeCode: boolean;
  codex: boolean;
  googleAntigravity?: boolean;
}

export interface CollectorConfig {
  version: 1;
  port: number;
  pollIntervalSeconds: number;
  tokenAnalyticsEnabled: boolean;
  /** Per-source consent. Reading either source exposes private history. */
  tokenAnalyticsSources: TokenAnalyticsConsent;
  /** Rotates on Google opt-in so cumulative counters cannot bridge revocation. */
  googleTokenConsentEpoch?: string;
  /** Changes even for a rapid off/on cycle with identical final flags. */
  tokenConsentRevision?: string;
  accounts: CollectorAccountConfig[];
  /**
   * Unattended (scheduled) collection, never on the person's screen:
   * "hidden" (Windows default when absent): an ordinary browser on a
   *   separate, never-shown desktop; "headless": no browser window at all
   *   (Claude challenges it); "off": collect only when a person asks.
   */
  backgroundCollection?: "hidden" | "headless" | "off";
}

export interface CollectorAccountResult {
  id: string;
  label: string;
  status: CollectorAccountStatus;
  account: QuotaAccount | null;
  checkedAt: string;
  message: string | null;
  /**
   * When this account last returned usage (ISO time), or null if it never
   * has on this PC. Lets the dashboard say "Never successfully synced"
   * instead of showing a misleading time or a 0%.
   */
  lastSuccessAt?: string | null;
}

export interface CollectorSnapshotResponse {
  version: 1;
  generatedAt: string;
  accounts: CollectorAccountResult[];
  tokens: TokenAnalyticsSnapshot | null;
  /** Token analytics progress: disabled, scanning, ready or unavailable. */
  tokenStatus?: TokenScanStatus;
}
