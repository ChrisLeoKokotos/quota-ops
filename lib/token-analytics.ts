import type { Provider } from "./quota.ts";

export type TokenRange = "today" | "7d" | "30d" | "all";

/**
 * Accounting contract (see docs/token-analytics.md, "Accounting contract"):
 *
 * - outputTokens: provider-reported output = **generated tokens**.
 * - reasoningTokens: provider-reported reasoning/thinking tokens where a
 *   source exposes them. Always a SUBSET of outputTokens (Anthropic counts
 *   thinking as output; OpenAI/Codex reports reasoning inside output), so it
 *   is never added to any total.
 * - inputTokens: provider-reported input. Claude: uncached input only.
 *   Codex: input INCLUDING cached input.
 * - cacheReadTokens / cacheWriteTokens: Claude: separate from input.
 *   Codex: a breakdown of input (never added again).
 * - totalTokens ("total processed"): Claude input + output + cache read +
 *   cache write; Codex input + output. No category is counted twice.
 */
export interface TokenTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  /** Subset of outputTokens; absent when no source reports it. */
  reasoningTokens?: number;
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

/**
 * What one source's numbers are based on. Counts only, never names or
 * content. `filesRemoved`: session files that disappeared since the
 * collector started (for example Claude Code's own cleanup of old
 * transcripts); their usage is no longer in a retained-history total.
 */
export interface TokenSourceCoverage {
  filesDiscovered: number;
  filesRead: number;
  filesPending: number;
  filesRemoved: number;
  /** Distinct usage records counted. */
  records: number;
  /** Repeated reports of an already counted record (merged, not added). */
  duplicates: number;
  /** Lines that were not valid JSON (skipped). */
  malformed: number;
  /** Usage lines too large to read (skipped). */
  oversized: number;
  oldestDate: string | null;
  newestDate: string | null;
}

export interface TokenSourceStatus {
  source: TokenSourceId;
  provider: Provider;
  state: TokenSourceState;
  files: number;
  message: string | null;
  coverage?: TokenSourceCoverage;
}

/** All-time usage per model id (provider-reported, e.g. "claude-sonnet-..."). */
export interface TokenModelTotals {
  provider: Provider;
  model: string;
  totals: TokenTotals;
}

/**
 * What "all time" means in a snapshot:
 * - "retained_history": computed from the session files currently on this
 *   PC. It goes down when a tool deletes old session files.
 * - "observed_lifetime": from the local usage ledger (opt-in): everything
 *   QuotaOps has observed since the ledger was turned on, kept after the
 *   source files are deleted. Numbers only.
 */
export type TokenTotalsBasis = "retained_history" | "observed_lifetime";

export interface TokenLedgerInfo {
  /** When the ledger began observing (ISO), null if unknown. */
  since: string | null;
  /** Distinct usage records in the ledger. */
  records: number;
  /** Ledger lines that failed their integrity check (ignored). */
  corrupt: number;
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
  /** All-time per-model split (largest first, bounded). */
  models?: TokenModelTotals[];
  /** Absent means "retained_history" (older collectors). */
  basis?: TokenTotalsBasis;
  /** With basis "observed_lifetime": the retained-history totals for comparison. */
  retainedTotals?: TokenTotals;
  ledger?: TokenLedgerInfo;
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
  const sum: TokenTotals = {
    inputTokens: target.inputTokens + value.inputTokens,
    outputTokens: target.outputTokens + value.outputTokens,
    cacheReadTokens: target.cacheReadTokens + value.cacheReadTokens,
    cacheWriteTokens: target.cacheWriteTokens + value.cacheWriteTokens,
    totalTokens: target.totalTokens + value.totalTokens,
  };
  if (target.reasoningTokens !== undefined || value.reasoningTokens !== undefined) {
    sum.reasoningTokens = (target.reasoningTokens ?? 0) + (value.reasoningTokens ?? 0);
  }
  return sum;
}

/** True when every counter is a safe, non-negative integer. */
export function tokenTotalsAreSafe(totals: TokenTotals): boolean {
  const values = [
    totals.inputTokens, totals.outputTokens, totals.cacheReadTokens,
    totals.cacheWriteTokens, totals.totalTokens,
    ...(totals.reasoningTokens === undefined ? [] : [totals.reasoningTokens]),
  ];
  return values.every((value) => Number.isSafeInteger(value) && value >= 0);
}

/**
 * Local calendar date, the same key the collector uses for its daily
 * buckets (both run on this PC). An earlier version used the UTC date here,
 * so near midnight "Today" counted the wrong local day.
 */
export function localDayKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${String(year).padStart(4, "0")}-${month}-${day}`;
}

function rangeStartKey(range: TokenRange, nowMs: number): string | null {
  if (range === "all") return null;

  const date = new Date(nowMs);
  date.setHours(0, 0, 0, 0);

  const daysBack = range === "today" ? 0 : range === "7d" ? 6 : 29;
  date.setDate(date.getDate() - daysBack);
  return localDayKey(date);
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
      ...(bucket.reasoningTokens === undefined ? {} : { reasoningTokens: bucket.reasoningTokens }),
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

/** Exact integer with digit grouping, for counts too large for a compact label. */
export function formatExactTokens(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0) return "—";
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(value);
}
