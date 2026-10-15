import type { Provider, QuotaAccount } from "../lib/quota.ts";
import type { TokenAnalyticsSnapshot } from "../lib/token-analytics.ts";
import type { LocalRuntimeSnapshot } from "../lib/local-runtime.ts";

export type CollectorAccountStatus =
  | "ok"
  | "login_required"
  | "unavailable"
  | "unsupported";

export interface CollectorAccountConfig {
  id: string;
  label: string;
  provider: Provider;
  profileDir: string;
  enabled: boolean;
}

export interface CollectorConfig {
  version: 1;
  port: number;
  pollIntervalSeconds: number;
  accounts: CollectorAccountConfig[];
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
  tokens: TokenAnalyticsSnapshot;
  runtimes: LocalRuntimeSnapshot[];
}
