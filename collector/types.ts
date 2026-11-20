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
}

export interface CollectorSnapshotResponse {
  version: 1;
  generatedAt: string;
  accounts: CollectorAccountResult[];
  tokens: TokenAnalyticsSnapshot | null;
}
