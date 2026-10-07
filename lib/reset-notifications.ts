import type { QuotaAccount } from "./quota";

export interface DueResetEvent {
  key: string;
  accountId: string;
  accountLabel: string;
  windowId: string;
  windowLabel: string;
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
    for (const window of account.windows) {
      const resetAt = window.resetAt;
      if (!resetAt) continue;

      const resetMs = Date.parse(resetAt);
      if (!Number.isFinite(resetMs)) continue;
      if (resetMs > nowMs || resetMs < nowMs - graceMs) continue;

      const key = `${account.id}:${window.id}:${resetAt}`;
      if (seenKeys.has(key)) continue;

      events.push({
        key,
        accountId: account.id,
        accountLabel: account.label,
        windowId: window.id,
        windowLabel: window.label,
        resetAt,
      });
    }
  }

  return events;
}

export function resetWindowLabel(windowLabel: string): string {
  return `${windowLabel} limit`;
}
