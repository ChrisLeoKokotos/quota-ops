// A narrow, versioned, read-only projection for the Windows Lily companion.
// This module NEVER exposes browser profiles, account emails, authentication,
// provider response bodies, local paths, source error messages or raw sessions.
import { getAccountStatus, getRecommendedAccount, type QuotaAccount } from "../lib/quota.ts";
import { summarizeTokenRange, type TokenAnalyticsSnapshot, type TokenRange } from "../lib/token-analytics.ts";
import type { CollectorAccountResult } from "./types.ts";

export const LILY_SCHEMA_VERSION = 1;
const MAX_ACCOUNT_AGE_MS = 15 * 60_000;
const MAX_ANALYTICS_AGE_MS = 20 * 60_000;
const SAFE_LABEL = /[\u0000-\u001f\u007f-\u009f]/g;
const PROVIDERS = new Set(["claude", "openai"]);

function label(value: string, max = 48): string {
  return value.replace(SAFE_LABEL, "").slice(0, max).trim();
}
function age(iso: string | null, now: number, maxAge: number): boolean {
  if (!iso) return true;
  const then = Date.parse(iso);
  return !Number.isFinite(then) || then > now + 30_000 || now - then > maxAge;
}
function count(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}
function totals(value: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; totalTokens: number }) {
  return {
    inputTokens: count(value.inputTokens),
    outputTokens: count(value.outputTokens),
    cacheReadTokens: count(value.cacheReadTokens),
    cacheWriteTokens: count(value.cacheWriteTokens),
    totalTokens: count(value.totalTokens),
  };
}

export function lilySnapshot(
  results: CollectorAccountResult[],
  analytics: TokenAnalyticsSnapshot,
  at = new Date(),
) {
  const now = at.getTime();
  const validAccounts: QuotaAccount[] = [];
  const accounts = results.slice(0, 32).flatMap((row) => {
    const account = row.account;
    const provider = account?.provider;
    if (!account || (provider !== "claude" && provider !== "openai") || !/^[a-z0-9][a-z0-9_-]{0,31}$/.test(row.id)) return [];
    const stale = age(row.checkedAt, now, MAX_ACCOUNT_AGE_MS);
    const valid = row.status === "ok" && !stale;
    if (valid) validAccounts.push(account);
    return [{
      id: row.id,
      provider,
      label: label(row.label || row.id),
      plan: label(account.plan),
      state: !valid ? stale ? "stale" : row.status : getAccountStatus(account, now),
      checkedAt: row.checkedAt,
      stale,
      windows: account.windows.slice(0, 8).filter(w =>
        /^[a-z0-9][a-z0-9_-]{0,31}$/.test(w.id) &&
        Number.isFinite(w.usedPercent) && w.usedPercent >= 0 && w.usedPercent <= 100 &&
        (w.resetAt === null || Number.isFinite(Date.parse(w.resetAt)))
      ).map(w => ({
        id: w.id, label: label(w.label, 32),
        usedPercent: w.usedPercent,
        resetAt: w.resetAt,
      })),
    }];
  });
  const candidate = getRecommendedAccount(validAccounts, now);
  const live = candidate && accounts.find(a => a.id === candidate.id && !a.stale);
  const tokensStale = age(analytics.generatedAt, now, MAX_ANALYTICS_AGE_MS);
  const ranges = (["today", "7d", "30d", "all"] as TokenRange[]).map(range => {
    const summary = summarizeTokenRange(analytics, range, now);
    return {
      range,
      totals: totals(summary.totals),
      providers: summary.providers.filter(p => PROVIDERS.has(p.provider)).map(p => ({
        provider: p.provider, totals: totals(p.totals),
      })),
    };
  });
  return {
    version: LILY_SCHEMA_VERSION,
    scope: "lily_readonly" as const,
    generatedAt: at.toISOString(),
    accounts,
    recommendation: live ? { accountId: live.id, provider: live.provider } : null,
    tokens: { scope: "locally_observed" as const, generatedAt: analytics.generatedAt, stale: tokensStale, ranges },
  };
}
