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

export type TokenSourceId = "claude-code" | "codex";
export type TokenSourceState = "ok" | "not_found" | "partial";

export interface TokenSourceStatus {
  source: TokenSourceId;
  provider: Provider;
  state: TokenSourceState;
  files: number;
  message: string | null;
}

export interface TokenAnalyticsSnapshot {
  generatedAt: string;
  scope: "locally_observed";
  totals: TokenTotals;
  providers: ProviderTokenTotals[];
  daily: DailyTokenBucket[];
  sources: TokenSourceStatus[];
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
