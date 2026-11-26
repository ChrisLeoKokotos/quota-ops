import type { ParsedUsage } from "./usage-parser.ts";

/**
 * Conservative last-resort parser for the visible Claude Settings > Usage panel.
 *
 * This intentionally recognises only a complete, clearly labelled pair of
 * percentage windows. A changed UI, duplicate value, missing section or number
 * outside 0..100 means "unknown", never a synthetic 0%.
 *
 * The caller extracts only the usage panel from the browser DOM, never the
 * whole page or any cookies, and never writes the panel text to logs.
 */
export interface VisibleClaudeUsageWindow {
  usedPercent: number;
  resetAt: null;
}

export interface VisibleClaudeUsage {
  fiveHour: VisibleClaudeUsageWindow;
  weekly: VisibleClaudeUsageWindow;
}

function exactLineIndex(lines: string[], heading: string, start = 0): number {
  return lines.findIndex((line, index) =>
    index >= start && line.toLowerCase() === heading.toLowerCase()
  );
}

function uniqueUsedPercent(lines: string[]): number | null {
  const values = lines
    .map((line) => /^(\d{1,3}(?:\.\d+)?)\s*%\s*used$/i.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => Number(match[1]));
  const value = values[0];
  if (values.length !== 1 || value === undefined ||
      !Number.isFinite(value) || value < 0 || value > 100) return null;
  return value;
}

export function parseVisibleClaudeUsagePanel(text: unknown): VisibleClaudeUsage | null {
  if (typeof text !== "string" || text.length === 0 || text.length > 4096) return null;

  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/\s+/g, " "))
    .filter(Boolean);

  // A bounded browser extraction may begin at "Current session" rather
  // than including the page title. Require exact, ordered section labels
  // for BOTH windows so unrelated percentages cannot be mistaken for quota.
  const first = lines[0] ?? "";
  const hasTitle = /^(?:Your usage limits(?:\s+\S+)?|Plan usage limits)$/i.test(first);
  if (!hasTitle && first.toLowerCase() !== "current session") return null;
  const current = hasTitle ? exactLineIndex(lines, "Current session", 1) : 0;
  if (current !== (hasTitle ? 1 : 0)) return null;

  // Older layouts separate "Weekly limits" and "All models". The visible
  // November 2026 layout combines them as "Weekly limit · All models".
  const combinedWeekly = lines
    .map((line, index) =>
      index > current && /^Weekly limit\s*[·•]\s*All models(?:\s*[›>])?$/i.test(line)
        ? index : -1)
    .filter((index) => index >= 0);
  const legacyWeekly = exactLineIndex(lines, "Weekly limits", current + 1);
  if (combinedWeekly.length > 1) return null;

  let weekly: number;
  let weeklyDataStart: number;
  if (combinedWeekly.length === 1 && legacyWeekly === -1) {
    weekly = combinedWeekly[0] ?? -1;
    weeklyDataStart = weekly;
  } else if (combinedWeekly.length === 0 && legacyWeekly > current) {
    weekly = legacyWeekly;
    weeklyDataStart = exactLineIndex(lines, "All models", weekly + 1);
  } else {
    return null; // Competing or missing weekly windows.
  }

  // Never scan into another quota section or the rest of account settings.
  const end = [
    exactLineIndex(lines, "Limit resets", weeklyDataStart + 1),
    exactLineIndex(lines, "Usage credits", weeklyDataStart + 1),
  ].filter((index) => index >= 0).sort((a, b) => a - b)[0] ?? -1;

  if (!(weekly > current && weeklyDataStart >= weekly && end > weeklyDataStart)) {
    return null;
  }

  const fiveHourPercent = uniqueUsedPercent(lines.slice(current + 1, weekly));
  const weeklyPercent = uniqueUsedPercent(lines.slice(weeklyDataStart + 1, end));
  if (fiveHourPercent === null || weeklyPercent === null) return null;

  // Relative UI labels ("Resets in 4 hr") and locale-specific weekly labels
  // ("Resets Fri 11 PM") cannot safely become exact timestamps here.
  return {
    fiveHour: { usedPercent: fiveHourPercent, resetAt: null },
    weekly: { usedPercent: weeklyPercent, resetAt: null },
  };
}


export type ClaudeUsageSource = "api" | "visible" | null;

/**
 * Selection policy: never hide an ambiguous organization or malformed API
 * payload behind a DOM guess. The visible fallback is eligible only when
 * the expected API response was absent. Tests inject the panel reader.
 */
export async function selectClaudeUsageSource(
  apiUsage: ParsedUsage | null,
  reason: string | null,
  readVisiblePanel: () => Promise<VisibleClaudeUsage | null>,
): Promise<{ usage: ParsedUsage | null; source: ClaudeUsageSource }> {
  if (apiUsage) return { usage: apiUsage, source: "api" };

  if (reason !== "claude_page_api_not_observed" &&
      reason !== "usage_response_not_observed") {
    return { usage: null, source: null };
  }

  try {
    const usage = await readVisiblePanel();
    return { usage, source: usage ? "visible" : null };
  } catch {
    return { usage: null, source: null };
  }
}
