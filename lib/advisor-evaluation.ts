import { adviseAccounts, recordAdvisorHistory, TASKS, type AdvisorHistory, type AdvisorTask } from "./smart-advisor.ts";
import type { QuotaAccount } from "./quota.ts";

/** Each frame contains only successful readings from the same local snapshot. */
export interface AdvisorObservation {
  capturedAt: number;
  accounts: readonly QuotaAccount[];
}
interface Pending {
  at: number;
  due: number;
  forecast: number;
  baseline: number;
}

const MINUTE = 60_000;
const headroom = (account: QuotaAccount) => Math.min(...account.windows.map(w => 100 - w.usedPercent));
function valid(account: QuotaAccount, capturedAt: number): boolean {
  const at = Date.parse(account.updatedAt);
  return account.source === "collector" && Number.isFinite(at) &&
    at <= capturedAt && capturedAt - at <= 35 * MINUTE &&
    account.windows.length > 0 && new Set(account.windows.map(w => w.id)).size === account.windows.length &&
    account.windows.every(w => Number.isFinite(w.usedPercent) && w.usedPercent >= 0 && w.usedPercent <= 100 &&
      w.resetAt !== null && Number.isFinite(Date.parse(w.resetAt)) && Date.parse(w.resetAt) > at);
}
function sameSeries(previous: QuotaAccount, current: QuotaAccount): boolean {
  return previous.provider === current.provider && previous.plan === current.plan &&
    previous.windows.length === current.windows.length &&
    current.windows.every(w => {
      const old = previous.windows.find(x => x.id === w.id);
      return old && old.resetAt === w.resetAt && w.usedPercent >= old.usedPercent;
    });
}

/** Chronological holdout evaluation of the production forecast, against a
 * persistence baseline (current headroom). No future sample enters history
 * before its own frame; no identifiers or per-account results are returned.
 * Missing/failed snapshots, resets and usage rewinds break a series.
 */
export function evaluateAdvisorObservations(frames: readonly AdvisorObservation[], task: AdvisorTask) {
  const { hours, reserve } = TASKS[task];
  const horizon = hours * 60 * MINUTE;
  const tolerance = 5 * MINUTE;
  let history: AdvisorHistory = Object.create(null) as AdvisorHistory;
  let last = new Map<string, QuotaAccount>();
  const pending = new Map<string, Pending[]>();
  let lastFrame = -Infinity;
  let observations = 0, issued = 0, paired = 0, forecastError = 0, baselineError = 0;
  let overoptimistic = 0, reserveMisses = 0, baselineReserveMisses = 0;
  for (const frame of frames) {
    if (!Number.isFinite(frame.capturedAt) || frame.capturedAt <= lastFrame) throw new Error("Observation frames must be strictly chronological");
    lastFrame = frame.capturedAt;
    const good = new Map<string, QuotaAccount>();
    const duplicated = new Set<string>();
    for (const account of frame.accounts) {
      if (!valid(account, frame.capturedAt)) continue;
      if (good.has(account.id)) duplicated.add(account.id);
      good.set(account.id, account);
    }
    for (const id of duplicated) good.delete(id);
    for (const id of last.keys()) {
      if (!good.has(id)) {
        pending.delete(id);
        delete history[id];
      }
    }
    const changed = new Set<string>();
    for (const [id, account] of good) {
      const at = Date.parse(account.updatedAt);
      const prev = last.get(id);
      const prevAt = prev ? Date.parse(prev.updatedAt) : -Infinity;
      if (prev && (at < prevAt || !sameSeries(prev, account) ||
          (at === prevAt && account.windows.some(w => w.usedPercent !== prev.windows.find(x => x.id === w.id)?.usedPercent)))) {
        // Discontinuous histories cannot be compared.
        pending.delete(id);
        delete history[id];
      } else if (prev && at === prevAt) {
        continue; // repeated API polls are not new observations
      } else {
        const keep: Pending[] = [];
        for (const prediction of pending.get(id) ?? []) {
          if (at < prediction.due) { keep.push(prediction); continue; }
          if (at > prediction.due + tolerance) continue;
          const actual = headroom(account);
          paired++;
          forecastError += Math.abs(prediction.forecast - actual);
          baselineError += Math.abs(prediction.baseline - actual);
          overoptimistic += Number(prediction.forecast > actual);
          reserveMisses += Number(prediction.forecast >= reserve && actual < reserve);
          baselineReserveMisses += Number(prediction.baseline >= reserve && actual < reserve);
        }
        pending.set(id, keep);
      }
      observations++;
      changed.add(id);
    }
    history = recordAdvisorHistory(history, [...good.values()], frame.capturedAt);
    for (const provider of ["claude", "openai", "google"] as const) {
      const candidates = adviseAccounts([...good.values()], { provider, task, nowMs: frame.capturedAt,
        freshIds: [...good.keys()], history }).candidates;
      for (const candidate of candidates) {
        const account = candidate.account;
        const at = Date.parse(account.updatedAt);
        // A reset inside the forecast horizon invalidates this comparison.
        if (!changed.has(account.id) || !candidate.trendKnown ||
            account.windows.some(w => Date.parse(w.resetAt!) <= at + horizon + tolerance)) continue;
        issued++;
        const entries = pending.get(account.id) ?? [];
        entries.push({ at, due: at + horizon, forecast: candidate.projectedRemaining, baseline: candidate.remaining });
        pending.set(account.id, entries);
      }
    }
    last = good;
  }
  return { task, horizonMinutes: hours * 60, toleranceMinutes: 5,
    observations, forecastsIssued: issued, matchedOutcomes: paired, unmatchedForecasts: issued - paired,
    forecastMAE: paired ? forecastError / paired : null,
    persistenceMAE: paired ? baselineError / paired : null,
    overoptimisticForecasts: overoptimistic, forecastReserveMisses: reserveMisses, persistenceReserveMisses: baselineReserveMisses };
}
