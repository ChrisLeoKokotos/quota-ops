export type Provider = "claude" | "openai";
export type Plan = string;

export interface QuotaWindow {
  id: string;
  label: string;
  usedPercent: number;
  resetAt: string | null;
}

export interface QuotaAccount {
  id: string;
  label: string;
  email?: string;
  provider: Provider;
  plan: Plan;
  windows: QuotaWindow[];
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
  | "limited"
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
  if (account.windows.length === 0) return "needs_setup";

  const states = account.windows.map((window) =>
    getAccountWindowState(account, window, nowMs),
  );

  if (states.every((state) => state === "exhausted")) return "exhausted";
  if (states.some((state) => state === "exhausted")) return "limited";
  if (states.some((state) => state === "refresh_required")) {
    return "refresh_required";
  }
  if (states.some((state) => state === "unknown")) return "needs_setup";
  if (states.some((state) => state === "low")) return "low";

  return "available";
}

function recommendationWeights(account: QuotaAccount): number[] {
  if (account.windows.length === 2) {
    const fiveHourIndex = account.windows.findIndex(
      (window) => window.id === "five-hour",
    );
    const weeklyIndex = account.windows.findIndex(
      (window) => window.id === "weekly",
    );

    if (fiveHourIndex >= 0 && weeklyIndex >= 0) {
      return account.windows.map((_, index) =>
        index === weeklyIndex ? 0.7 : index === fiveHourIndex ? 0.3 : 0,
      );
    }
  }

  const equal = 1 / account.windows.length;
  return account.windows.map(() => equal);
}

export function recommendationScore(
  account: QuotaAccount,
  nowMs: number,
): number {
  const status = getAccountStatus(account, nowMs);

  if (
    status === "refresh_required" ||
    status === "needs_setup" ||
    status === "limited" ||
    status === "exhausted"
  ) {
    return Number.NEGATIVE_INFINITY;
  }

  const weights = recommendationWeights(account);
  return account.windows.reduce(
    (score, window, index) =>
      score + (100 - clampPercent(window.usedPercent)) * (weights[index] ?? 0),
    0,
  );
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

export function providerLabel(provider: Provider): string {
  return provider === "claude" ? "Claude" : "OpenAI";
}
