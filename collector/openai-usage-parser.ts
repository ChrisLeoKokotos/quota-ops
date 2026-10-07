import { clampPercent, type QuotaWindow } from "../lib/quota.ts";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function resetAtIso(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const milliseconds = value > 10_000_000_000 ? value : value * 1000;
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function parseWindow(
  value: unknown,
  id: string,
  label: string,
): QuotaWindow | null {
  const record = asRecord(value);
  if (!record) return null;

  const rawPercent =
    typeof record.used_percent === "number"
      ? record.used_percent
      : typeof record.utilization === "number"
        ? record.utilization
        : null;

  if (rawPercent === null || !Number.isFinite(rawPercent)) return null;

  return {
    id,
    label,
    usedPercent: clampPercent(rawPercent),
    resetAt: resetAtIso(record.reset_at),
  };
}

export interface ParsedOpenAIUsage {
  plan: string;
  windows: QuotaWindow[];
}

export function parseOpenAIUsagePayload(
  payload: unknown,
): ParsedOpenAIUsage | null {
  const root = asRecord(payload);
  if (!root) return null;

  const rateLimit = asRecord(root.rate_limit ?? root.rateLimit);
  if (!rateLimit) return null;

  const windows: QuotaWindow[] = [];
  const primary = parseWindow(
    rateLimit.primary_window ?? rateLimit.primaryWindow,
    "five-hour",
    "5-hour",
  );
  const secondary = parseWindow(
    rateLimit.secondary_window ?? rateLimit.secondaryWindow,
    "weekly",
    "Weekly",
  );

  if (primary) windows.push(primary);
  if (secondary) windows.push(secondary);
  if (windows.length === 0) return null;

  const rawPlan =
    typeof root.plan_type === "string"
      ? root.plan_type
      : typeof root.plan === "string"
        ? root.plan
        : "ChatGPT";

  return {
    plan: rawPlan.trim() || "ChatGPT",
    windows,
  };
}
