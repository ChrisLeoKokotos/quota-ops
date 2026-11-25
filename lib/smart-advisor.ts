import type { Provider, QuotaAccount, QuotaWindow } from "./quota.ts";

export type AdvisorTask = "quick" | "coding" | "heavy";
export type AdvisorHistory = Record<string, QuotaAccount[]>;
export const TASKS = {
  quick: { label: "Quick fix", hours: 0.25, reserve: 5 },
  coding: { label: "Coding session", hours: 1, reserve: 15 },
  heavy: { label: "Heavy development", hours: 3, reserve: 25 },
} as const;
const MINUTE = 60_000;
const MAX_AGE = 35 * MINUTE;
const MANUAL_AGE = 24 * 60 * MINUTE;
const MAX_HISTORY = 12;
const HISTORY_AGE = 120 * MINUTE;

export interface AdvisorOptions {
  provider: Provider;
  task: AdvisorTask;
  nowMs: number;
  // Only IDs explicitly returned successfully by the latest connected snapshot.
  freshIds: readonly string[];
  history?: AdvisorHistory;
  previousId?: string | null;
}

export interface AdvisorCandidate {
  account: QuotaAccount;
  score: number;
  remaining: number;
  projectedRemaining: number;
  trendKnown: boolean;
  fit: boolean;
  reason: string;
}
export interface AdvisorResult {
  recommended: AdvisorCandidate | null;
  candidates: AdvisorCandidate[];
  excluded: { account: QuotaAccount; reason: string }[];
  upcomingReset: { account: QuotaAccount; resetAt: string } | null;
  retained: boolean;
}

function samplesFor(history: AdvisorHistory | undefined, id: string): QuotaAccount[] {
  return history && Object.hasOwn(history, id) ? history[id] ?? [] : [];
}

function validPercent(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 100;
}
function validReading(account: QuotaAccount, now: number): boolean {
  const at = Date.parse(account.updatedAt);
  return Number.isFinite(at) && at <= now && now - at <=
    (account.source === "collector" ? MAX_AGE : MANUAL_AGE);
}

// Keep only numeric quota readings and operational metadata in memory;
// never retain email, session content or tokens. Reset on app restart.
export function recordAdvisorHistory(previous: AdvisorHistory, readings: readonly QuotaAccount[], now: number): AdvisorHistory {
  const next: AdvisorHistory = Object.create(null) as AdvisorHistory;
  for (const a of readings) {
    if (a.source !== "collector" || !validReading(a, now) ||
        a.windows.length === 0 || a.windows.some(w => !validPercent(w.usedPercent))) continue;
    const old = samplesFor(previous, a.id).filter(p =>
      p.provider === a.provider && p.plan === a.plan &&
      Date.parse(p.updatedAt) >= now - HISTORY_AGE &&
      Date.parse(p.updatedAt) < Date.parse(a.updatedAt));
    const sample: QuotaAccount = {
      id: a.id, label: "", provider: a.provider, plan: a.plan,
      source: "collector", updatedAt: a.updatedAt,
      windows: a.windows.map(w => ({ ...w })),
    };
    next[a.id] = [...old, sample].slice(-MAX_HISTORY);
  }
  return next;
}

function rate(account: QuotaAccount, window: QuotaWindow, history: AdvisorHistory | undefined): number | null {
  if (!window.resetAt || account.source !== "collector") return null;
  const at = Date.parse(account.updatedAt);
  const points = samplesFor(history, account.id)
    .filter(p => p.provider === account.provider && p.plan === account.plan &&
      Date.parse(p.updatedAt) >= at - HISTORY_AGE && Date.parse(p.updatedAt) < at)
    .map(p => ({ at: Date.parse(p.updatedAt), window: p.windows.find(w => w.id === window.id) }))
    .concat({ at, window })
    .sort((a, b) => a.at - b.at);
  // Only a contiguous, same-reset, non-decreasing series is usable.
  const suffix: typeof points = [];
  for (let i = points.length - 1; i >= 0; i--) {
    const p = points[i]!;
    const later = suffix[0];
    if (!p.window || p.window.resetAt !== window.resetAt || !validPercent(p.window.usedPercent) ||
        (later && (p.at >= later.at || p.window.usedPercent > later.window!.usedPercent))) break;
    suffix.unshift(p);
  }
  if (suffix.length < 3) return null;
  const first = suffix[0]!;
  const hours = (at - first.at) / 3_600_000;
  if (hours < 0.25) return null;
  return (window.usedPercent - first.window!.usedPercent) / hours;
}

export function adviseAccounts(accounts: readonly QuotaAccount[], options: AdvisorOptions): AdvisorResult {
  const { provider, task, nowMs, freshIds, history, previousId } = options;
  const profile = TASKS[task];
  const candidates: AdvisorCandidate[] = [];
  const excluded: AdvisorResult["excluded"] = [];
  const resets: NonNullable<AdvisorResult["upcomingReset"]>[] = [];
  const fresh = new Set(freshIds);
  for (const account of accounts) {
    if (account.provider !== provider) continue;
    const exclude = (reason: string) => excluded.push({ account, reason });
    if (!validReading(account, nowMs) || (account.source === "collector" && !fresh.has(account.id))) {
      exclude("Refresh required: no recent successful reading."); continue;
    }
    if (!account.windows.length || new Set(account.windows.map(w => w.id)).size !== account.windows.length ||
        account.windows.some(w => !validPercent(w.usedPercent))) {
      exclude("Missing or invalid quota data."); continue;
    }
    if (account.windows.some(w => w.resetAt !== null &&
        (!Number.isFinite(Date.parse(w.resetAt)) || Date.parse(w.resetAt) <= nowMs))) {
      exclude("A reset is due or invalid; verify current usage."); continue;
    }
    const limiting = account.windows.filter(w => 100 - w.usedPercent < profile.reserve);
    // A reset is only a reminder to refresh, never assumed to replenish capacity.
    if (limiting.length && limiting.every(w => w.resetAt !== null)) {
      const at = Math.max(...limiting.map(w => Date.parse(w.resetAt!)));
      if (at <= nowMs + 60 * MINUTE) resets.push({ account, resetAt: new Date(at).toISOString() });
    }
    if (account.windows.some(w => w.usedPercent >= 100)) {
      exclude("At least one quota is exhausted."); continue;
    }
    if (account.windows.some(w => !w.resetAt && !(account.source === "collector" && w.usedPercent === 0))) {
      exclude("Reset time unknown; verify current usage."); continue;
    }
    const headrooms = account.windows.map(w => 100 - w.usedPercent);
    const rates = account.windows.map(w => rate(account, w, history));
    const trendKnown = rates.every(r => r !== null);
    const projected = headrooms.map((h, i) => Math.max(0, h - (rates[i] ?? 0) * profile.hours));
    const remaining = Math.min(...headrooms);
    const projectedRemaining = Math.min(...projected);
    const fit = remaining >= profile.reserve && projectedRemaining >= profile.reserve;
    const average = headrooms.reduce((a, b) => a + b, 0) / headrooms.length;
    const score = 0.65 * projectedRemaining + 0.25 * remaining + 0.10 * average;
    const reason = !fit
      ? "Below the selected task's headroom reserve."
      : trendKnown
        ? "Balanced quota headroom, adjusted using recent observed usage."
        : "Balanced quota headroom; consumption trend is not yet established.";
    candidates.push({ account, score, remaining, projectedRemaining, trendKnown, fit, reason });
  }
  candidates.sort((a, b) => Number(b.fit) - Number(a.fit) || b.score - a.score ||
    (a.account.id < b.account.id ? -1 : a.account.id > b.account.id ? 1 : 0));
  const best = candidates.find(c => c.fit) ?? null;
  const prior = candidates.find(c => c.account.id === previousId && c.fit);
  // Stabilize only within the same task/provider context, never retain an ineligible account.
  const retained = !!best && !!prior && best.account.id !== prior.account.id &&
    best.score - prior.score <= 5;
  resets.sort((a, b) => Date.parse(a.resetAt) - Date.parse(b.resetAt) ||
    (a.account.id < b.account.id ? -1 : a.account.id > b.account.id ? 1 : 0));
  return { recommended: retained ? prior! : best, candidates, excluded,
    upcomingReset: resets[0] ?? null, retained };
}
