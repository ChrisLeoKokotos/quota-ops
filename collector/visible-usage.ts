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
  if (values.length !== 1 || !Number.isFinite(values[0]) ||
      values[0] < 0 || values[0] > 100) return null;
  return values[0];
}

export function parseVisibleClaudeUsagePanel(text: unknown): VisibleClaudeUsage | null {
  if (typeof text !== "string" || text.length === 0 || text.length > 4096) return null;

  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/\s+/g, " "))
    .filter(Boolean);

  // The panel has to be identifiable as usage data, not arbitrary account text.
  if (!/^Your usage limits(?:\s+\S+)?$/i.test(lines[0] ?? "")) return null;

  const current = exactLineIndex(lines, "Current session", 1);
  const weekly = exactLineIndex(lines, "Weekly limits", current + 1);
  const allModels = exactLineIndex(lines, "All models", weekly + 1);
  const end = exactLineIndex(lines, "Limit resets", allModels + 1);
  if (!(current > 0 && weekly > current && allModels > weekly && end > allModels)) {
    return null;
  }

  const fiveHourPercent = uniqueUsedPercent(lines.slice(current + 1, weekly));
  const weeklyPercent = uniqueUsedPercent(lines.slice(allModels + 1, end));
  if (fiveHourPercent === null || weeklyPercent === null) return null;

  // Relative UI labels ("Resets in 4 hr") and locale-specific weekly labels
  // ("Resets Fri 11 PM") cannot safely become exact timestamps here.
  return {
    fiveHour: { usedPercent: fiveHourPercent, resetAt: null },
    weekly: { usedPercent: weeklyPercent, resetAt: null },
  };
}
