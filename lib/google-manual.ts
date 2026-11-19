import { clampPercent, type QuotaWindow } from "./quota.ts";

/**
 * Antigravity documents /usage as an interactive panel, not a stable,
 * machine-readable third-party quota API. These are explicitly manual values.
 * No Google credentials, browser profiles or provider endpoints are accessed.
 */
export function normalizeGoogleModelGroup(value: string): string | null {
  const normalized = value.trim().replace(/\s+/g, " ");
  if (!normalized || normalized.length > 60 || /[\x00-\x1f\x7f]/.test(normalized)) return null;
  return normalized;
}

function groupKey(group: string): string {
  return encodeURIComponent(group.toLocaleLowerCase("en-US"));
}

export function hasGoogleModelGroup(windows: QuotaWindow[], group: string): boolean {
  const normalized = normalizeGoogleModelGroup(group);
  if (!normalized) return false;
  return windows.some((item) => item.id === `google:${groupKey(normalized)}:five-hour`);
}

export function createGoogleModelGroupWindows(
  group: string,
  fiveHourUsed: number,
  fiveHourReset: string | null,
  weeklyUsed: number,
  weeklyReset: string | null,
): QuotaWindow[] {
  const normalized = normalizeGoogleModelGroup(group);
  if (!normalized) throw new Error("A valid Antigravity model-group name is required.");
  const prefix = `google:${groupKey(normalized)}`;
  return [
    {
      id: `${prefix}:five-hour`,
      label: `${normalized} · 5-hour`,
      usedPercent: clampPercent(fiveHourUsed),
      resetAt: fiveHourReset,
    },
    {
      id: `${prefix}:weekly`,
      label: `${normalized} · Weekly`,
      usedPercent: clampPercent(weeklyUsed),
      resetAt: weeklyReset,
    },
  ];
}
