import type { Provider, QuotaAccount } from "../lib/quota.ts";
import type { TokenAnalyticsSnapshot } from "../lib/token-analytics.ts";

export type CollectorAccountStatus =
  | "ok"
  | "login_required"
  | "verification_required"
  | "unavailable"
  | "unsupported";

export interface CollectorAccountConfig {
  id: string;
  label: string;
  // Google / Antigravity is manual-only; never launch a Google collector session.
  provider: Exclude<Provider, "google">;
  profileDir: string;
  enabled: boolean;
}

export interface TokenAnalyticsConsent {
  claudeCode: boolean;
  codex: boolean;
}

export interface CollectorConfig {
  version: 1;
  port: number;
  pollIntervalSeconds: number;
  tokenAnalyticsEnabled: boolean;
  /** Per-source consent. Reading either source exposes private history. */
  tokenAnalyticsSources: TokenAnalyticsConsent;
  accounts: CollectorAccountConfig[];
  /**
   * Unattended (scheduled) collection. "headless" (default when absent) never
   * opens a window; "off" collects only when a person asks.
   */
  backgroundCollection?: "headless" | "off";
}

export interface CollectorAccountResult {
  id: string;
  label: string;
  status: CollectorAccountStatus;
  account: QuotaAccount | null;
  checkedAt: string;
  message: string | null;
}

export interface CollectorSnapshotResponse {
  version: 1;
  generatedAt: string;
  accounts: CollectorAccountResult[];
  tokens: TokenAnalyticsSnapshot | null;
}
