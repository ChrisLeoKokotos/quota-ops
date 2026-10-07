import { clampPercent, type QuotaAccount } from "./quota.ts";

export interface VoiceUsageCommand {
  accountId: string;
  accountLabel: string;
  windowId: string;
  windowLabel: string;
  usedPercent: number;
}

const WEEKLY_WORDS = ["weekly", "week", "βδομα", "εβδομα"];
const FIVE_HOUR_WORDS = [
  "five hour",
  "five-hour",
  "5 hour",
  "5-hour",
  "5h",
  "πέντε ώρ",
  "πεντε ωρ",
];

export function parseVoiceUsageCommand(
  transcript: string,
  accounts: QuotaAccount[],
): VoiceUsageCommand | null {
  const normalized = transcript.toLowerCase().replaceAll(",", ".");

  const account = accounts.find((candidate) =>
    normalized.includes(candidate.label.toLowerCase()),
  );
  if (!account) return null;

  const weeklyWord = WEEKLY_WORDS.find((word) => normalized.includes(word));
  const fiveHourWord = FIVE_HOUR_WORDS.find((word) => normalized.includes(word));

  const targetId = weeklyWord ? "weekly" : fiveHourWord ? "five-hour" : null;
  const matchedWindowWord = weeklyWord ?? fiveHourWord;
  if (!targetId || !matchedWindowWord) return null;

  const quotaWindow = account.windows.find((window) => window.id === targetId);
  if (!quotaWindow) return null;

  const commandBody = normalized
    .replace(account.label.toLowerCase(), " ")
    .replace(matchedWindowWord, " ");

  const percentages = (commandBody.match(/\d+(?:\.\d+)?/g) ?? [])
    .map(Number)
    .filter((value) => Number.isFinite(value) && value >= 0 && value <= 100);

  if (percentages.length !== 1) return null;
  const percentage = percentages[0];
  if (percentage === undefined) return null;

  return {
    accountId: account.id,
    accountLabel: account.label,
    windowId: quotaWindow.id,
    windowLabel: quotaWindow.label,
    usedPercent: clampPercent(percentage),
  };
}

export function voiceWindowLabel(windowLabel: string): string {
  return windowLabel;
}
