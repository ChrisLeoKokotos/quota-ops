import { clampPercent, type QuotaAccount } from "./quota.ts";

export type VoiceQuotaWindow = "fiveHour" | "weekly";

export interface VoiceUsageCommand {
  accountId: string;
  accountLabel: string;
  window: VoiceQuotaWindow;
  usedPercent: number;
}

const WEEKLY_WORDS = [
  "weekly",
  "week",
  "βδομα",
  "εβδομα",
];

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

  const window: VoiceQuotaWindow | null = weeklyWord
    ? "weekly"
    : fiveHourWord
      ? "fiveHour"
      : null;

  if (!window) return null;

  const matchedWindowWord = weeklyWord ?? fiveHourWord;
  if (!matchedWindowWord) return null;

  const commandBody = normalized
    .replace(account.label.toLowerCase(), " ")
    .replace(matchedWindowWord, " ");

  const percentages = (commandBody.match(/\d+(?:\.\d+)?/g) ?? [])
    .map(Number)
    .filter((value) => Number.isFinite(value) && value >= 0 && value <= 100);

  // Fail closed when the spoken command contains no percentage or is ambiguous.
  if (percentages.length !== 1) return null;
  const percentage = percentages[0];

  return {
    accountId: account.id,
    accountLabel: account.label,
    window,
    usedPercent: clampPercent(percentage),
  };
}

export function voiceWindowLabel(window: VoiceQuotaWindow): string {
  return window === "weekly" ? "weekly" : "5-hour";
}
