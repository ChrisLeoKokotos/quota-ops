export type Provider = "claude";
export type Plan = "team";

export interface QuotaWindow {
  usedPercent: number;
  resetAt: string | null;
}

export interface QuotaAccount {
  id: string;
  label: string;
  provider: Provider;
  plan: Plan;
  fiveHour: QuotaWindow;
  weekly: QuotaWindow;
  updatedAt: string;
  source?: "manual" | "collector";
}

export type WindowState =
  | "available"
  | "low"
  | "exhausted"
  | "refresh_required"
  | "unknown";

export type AccountStatus =
  | "available"
  | "low"
  | "five_hour_limited"
  | "weekly_limited"
  | "exhausted"
  | "needs_setup"
  | "refresh_required";

export function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, Math.round(value * 10) / 10));
}

export function getWindowState(
  window: QuotaWindow,
  nowMs: number,
): WindowState {
  if (!window.resetAt) return "unknown";

  const resetMs = Date.parse(window.resetAt);
  if (!Number.isFinite(resetMs)) return "unknown";

  const usedPercent = clampPercent(window.usedPercent);
  if (usedPercent >= 100) return "exhausted";
  if (resetMs <= nowMs) return "refresh_required";
  if (usedPercent >= 85) return "low";

  return "available";
}

function getAccountWindowState(
  account: QuotaAccount,
  window: QuotaWindow,
  nowMs: number,
): WindowState {
  if (
    account.source === "collector" &&
    window.resetAt === null &&
    clampPercent(window.usedPercent) === 0
  ) {
    return "available";
  }

  return getWindowState(window, nowMs);
}

export function getAccountStatus(
  account: QuotaAccount,
  nowMs: number,
): AccountStatus {
  const fiveHour = getAccountWindowState(account, account.fiveHour, nowMs);
  const weekly = getAccountWindowState(account, account.weekly, nowMs);

  if (fiveHour === "exhausted" && weekly === "exhausted") {
    return "exhausted";
  }

  if (weekly === "exhausted") return "weekly_limited";
  if (fiveHour === "exhausted") return "five_hour_limited";

  if (
    fiveHour === "refresh_required" ||
    weekly === "refresh_required"
  ) {
    return "refresh_required";
  }

  if (fiveHour === "unknown" || weekly === "unknown") {
    return "needs_setup";
  }
  if (weekly === "low" || fiveHour === "low") return "low";

  return "available";
}

export function recommendationScore(
  account: QuotaAccount,
  nowMs: number,
): number {
  const status = getAccountStatus(account, nowMs);

  if (
    status === "refresh_required" ||
    status === "needs_setup" ||
    status === "weekly_limited" ||
    status === "five_hour_limited" ||
    status === "exhausted"
  ) {
    return Number.NEGATIVE_INFINITY;
  }

  const weeklyRemaining = 100 - clampPercent(account.weekly.usedPercent);
  const fiveHourRemaining = 100 - clampPercent(account.fiveHour.usedPercent);

  return weeklyRemaining * 0.7 + fiveHourRemaining * 0.3;
}

export function getRecommendedAccount(
  accounts: QuotaAccount[],
  nowMs: number,
): QuotaAccount | null {
  let best: QuotaAccount | null = null;
  let bestScore = Number.NEGATIVE_INFINITY;

  for (const account of accounts) {
    const score = recommendationScore(account, nowMs);
    if (score > bestScore) {
      best = account;
      bestScore = score;
    }
  }

  return Number.isFinite(bestScore) ? best : null;
}

export function formatCountdown(resetAt: string | null, nowMs: number): string {
  if (!resetAt) return "Unknown reset";

  const resetMs = Date.parse(resetAt);
  if (!Number.isFinite(resetMs)) return "Unknown reset";

  const diffMs = resetMs - nowMs;
  if (diffMs <= 0) return "Reset reached";

  const totalMinutes = Math.ceil(diffMs / 60_000);
  const days = Math.floor(totalMinutes / 1_440);
  const hours = Math.floor((totalMinutes % 1_440) / 60);
  const minutes = totalMinutes % 60;

  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

