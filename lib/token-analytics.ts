import type { Provider } from "./quota.ts";

export type TokenRange = "today" | "7d" | "30d" | "all";

export interface TokenTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
}

export interface ProviderTokenTotals {
  provider: Provider;
  totals: TokenTotals;
}

export interface DailyTokenBucket extends TokenTotals {
  date: string;
  provider: Provider;
}

export type TokenSourceId = "claude-code" | "codex" | "google-antigravity";
/**
 * `disabled` means QuotaOps never opened the source because the user has not
 * consented to it. It is deliberately distinct from `not_found`, which would
 * claim a search happened and came back empty.
 */
export type TokenSourceState = "ok" | "not_found" | "partial" | "disabled";

export interface TokenSourceStatus {
  source: TokenSourceId;
  provider: Provider;
  state: TokenSourceState;
  files: number;
  message: string | null;
}

/**
 * All-time usage of one source split by the provider account that ran it.
 *
 * Claude Code writes a `session-owner` record (account and organization id)
 * into newer session logs. Usage is attributed to an account only when its
 * session has exactly one such account: never inferred, never spread out.
 * `account` is a salted one-way hash (12 hex characters), never the id.
 * Usage without that evidence stays explicitly unattributed (`account: null`).
 */
export type TokenAttribution = "attributed" | "no_account_record" | "several_accounts";

export interface TokenAccountTotals {
  source: TokenSourceId;
  account: string | null;
  attribution: TokenAttribution;
  /** The account Claude Code is signed in to right now. */
  current: boolean;
  sessions: number;
  totals: TokenTotals;
}

export interface TokenAnalyticsSnapshot {
  generatedAt: string;
  scope: "locally_observed";
  totals: TokenTotals;
  providers: ProviderTokenTotals[];
  daily: DailyTokenBucket[];
  sources: TokenSourceStatus[];
  /** All-time per-account split, where a source records account ids. */
  accounts?: TokenAccountTotals[];
}

/** How far the collector has got with token analytics. */
export type TokenScanState = "disabled" | "scanning" | "ready" | "unavailable";

export interface TokenScanStatus {
  state: TokenScanState;
  scannedAt: string | null;
  pending: boolean;
}

export function emptyTokenTotals(): TokenTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
  };
}

export function addTokenTotals(
  target: TokenTotals,
  value: TokenTotals,
): TokenTotals {
  return {
    inputTokens: target.inputTokens + value.inputTokens,
    outputTokens: target.outputTokens + value.outputTokens,
    cacheReadTokens: target.cacheReadTokens + value.cacheReadTokens,
    cacheWriteTokens: target.cacheWriteTokens + value.cacheWriteTokens,
    totalTokens: target.totalTokens + value.totalTokens,
  };
}

function localDateKey(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function rangeStartKey(range: TokenRange, nowMs: number): string | null {
  if (range === "all") return null;

  const date = new Date(nowMs);
  date.setUTCHours(0, 0, 0, 0);

  const daysBack = range === "today" ? 0 : range === "7d" ? 6 : 29;
  date.setUTCDate(date.getUTCDate() - daysBack);
  return localDateKey(date);
}

export function summarizeTokenRange(
  analytics: TokenAnalyticsSnapshot,
  range: TokenRange,
  nowMs: number,
): {
  totals: TokenTotals;
  providers: ProviderTokenTotals[];
} {
  if (range === "all") {
    return {
      totals: analytics.totals,
      providers: analytics.providers,
    };
  }

  const startKey = rangeStartKey(range, nowMs);
  const providerTotals = new Map<Provider, TokenTotals>();
  let totals = emptyTokenTotals();

  for (const bucket of analytics.daily) {
    if (startKey && bucket.date < startKey) continue;

    const value: TokenTotals = {
      inputTokens: bucket.inputTokens,
      outputTokens: bucket.outputTokens,
      cacheReadTokens: bucket.cacheReadTokens,
      cacheWriteTokens: bucket.cacheWriteTokens,
      totalTokens: bucket.totalTokens,
    };

    totals = addTokenTotals(totals, value);
    providerTotals.set(
      bucket.provider,
      addTokenTotals(
        providerTotals.get(bucket.provider) ?? emptyTokenTotals(),
        value,
      ),
    );
  }

  return {
    totals,
    providers: [...providerTotals.entries()]
      .map(([provider, providerTokens]) => ({
        provider,
        totals: providerTokens,
      }))
      .sort((a, b) => b.totals.totalTokens - a.totals.totalTokens),
  };
}

export function formatTokenCount(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";

  return new Intl.NumberFormat(undefined, {
    notation: value >= 1_000 ? "compact" : "standard",
    maximumFractionDigits: value >= 1_000_000 ? 2 : 1,
  }).format(Math.round(value));
}

/** What the token panel shows, from the collector's status and its data. */
export type TokenPanelState =
  | "checking"
  | "offline"
  | "disabled"
  | "scanning"
  | "unavailable"
  | "partial"
  | "complete"
  | "zero";

export function tokenPanelState(
  analytics: TokenAnalyticsSnapshot | null,
  status: TokenScanStatus | null,
  collector: "checking" | "connected" | "offline",
): TokenPanelState {
  // Before the first snapshot arrives, say so; never "start the collector".
  if (collector === "checking") return "checking";
  if (collector === "offline") return "offline";
  // An older collector reports no status: data means on, no data means off.
  if (status?.state === "disabled" || (!status && !analytics)) return "disabled";
  if (!analytics) return status?.state === "unavailable" ? "unavailable" : "scanning";
  if (status?.state === "unavailable") return "unavailable";
  const consented = analytics.sources.filter((source) => source.state !== "disabled");
  if (status?.pending || consented.some((source) => source.state === "partial")) return "partial";
  if (analytics.totals.totalTokens === 0) return "zero";
  return "complete";
}
