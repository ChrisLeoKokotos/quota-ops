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
  if (resetMs <= nowMs) return "refresh_required";
  if (clampPercent(window.usedPercent) >= 100) return "exhausted";
  if (clampPercent(window.usedPercent) >= 85) return "low";

  return "available";
}

export function getAccountStatus(
  account: QuotaAccount,
  nowMs: number,
): AccountStatus {
  const fiveHour = getWindowState(account.fiveHour, nowMs);
  const weekly = getWindowState(account.weekly, nowMs);

  if (
    fiveHour === "refresh_required" ||
    weekly === "refresh_required"
  ) {
    return "refresh_required";
  }

  if (fiveHour === "unknown" || weekly === "unknown") {
    return "needs_setup";
  }

  if (fiveHour === "exhausted" && weekly === "exhausted") {
    return "exhausted";
  }

  if (weekly === "exhausted") return "weekly_limited";
  if (fiveHour === "exhausted") return "five_hour_limited";
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

export function createDemoAccounts(nowMs = Date.now()): QuotaAccount[] {
  const isoIn = (milliseconds: number) =>
    new Date(nowMs + milliseconds).toISOString();
  const hours = (value: number) => value * 60 * 60 * 1_000;
  const days = (value: number) => hours(value * 24);
  const updatedAt = new Date(nowMs).toISOString();

  return [
    {
      id: "dev-1",
      label: "Dev 1",
      provider: "claude",
      plan: "team",
      fiveHour: { usedPercent: 63, resetAt: isoIn(hours(2.4)) },
      weekly: { usedPercent: 100, resetAt: isoIn(days(4) + hours(7)) },
      updatedAt,
    },
    {
      id: "dev-2",
      label: "Dev 2",
      provider: "claude",
      plan: "team",
      fiveHour: { usedPercent: 92, resetAt: isoIn(hours(0.8)) },
      weekly: { usedPercent: 44, resetAt: isoIn(days(1) + hours(7)) },
      updatedAt,
    },
    {
      id: "dev-3",
      label: "Dev 3",
      provider: "claude",
      plan: "team",
      fiveHour: { usedPercent: 21, resetAt: isoIn(hours(3.2)) },
      weekly: { usedPercent: 73, resetAt: isoIn(days(5) + hours(2)) },
      updatedAt,
    },
    {
      id: "dev-4",
      label: "Dev 4",
      provider: "claude",
      plan: "team",
      fiveHour: { usedPercent: 100, resetAt: isoIn(hours(1.1)) },
      weekly: { usedPercent: 38, resetAt: isoIn(days(2) + hours(11)) },
      updatedAt,
    },
    {
      id: "dev-5",
      label: "Dev 5",
      provider: "claude",
      plan: "team",
      fiveHour: { usedPercent: 47, resetAt: isoIn(hours(4.5)) },
      weekly: { usedPercent: 12, resetAt: isoIn(days(6) + hours(4)) },
      updatedAt,
    },
  ];
}
