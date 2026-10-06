import type { QuotaAccount } from "./quota";

export type ResetWindowKind = "fiveHour" | "weekly";

export interface DueResetEvent {
  key: string;
  accountId: string;
  accountLabel: string;
  window: ResetWindowKind;
  resetAt: string;
}

const DEFAULT_GRACE_MS = 15 * 60 * 1000;

export function getDueResetEvents(
  accounts: QuotaAccount[],
  nowMs: number,
  seenKeys: ReadonlySet<string>,
  graceMs = DEFAULT_GRACE_MS,
): DueResetEvent[] {
  const events: DueResetEvent[] = [];

  for (const account of accounts) {
    for (const window of ["fiveHour", "weekly"] as const) {
      const resetAt = account[window].resetAt;
      if (!resetAt) continue;

      const resetMs = Date.parse(resetAt);
      if (!Number.isFinite(resetMs)) continue;
      if (resetMs > nowMs || resetMs < nowMs - graceMs) continue;

      const key = `${account.id}:${window}:${resetAt}`;
      if (seenKeys.has(key)) continue;

      events.push({
        key,
        accountId: account.id,
        accountLabel: account.label,
        window,
        resetAt,
      });
    }
  }

  return events;
}

export function resetWindowLabel(window: ResetWindowKind): string {
  return window === "fiveHour" ? "5-hour limit" : "weekly limit";
}
