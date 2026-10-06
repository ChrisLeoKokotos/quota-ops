import { clampPercent, type QuotaAccount } from "./quota";

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

  const window: VoiceQuotaWindow | null =
    WEEKLY_WORDS.some((word) => normalized.includes(word))
      ? "weekly"
      : FIVE_HOUR_WORDS.some((word) => normalized.includes(word))
        ? "fiveHour"
        : null;

  if (!window) return null;

  const numbers = normalized.match(/\d+(?:\.\d+)?/g)?.map(Number) ?? [];
  const percentage = numbers.find((value) => value >= 0 && value <= 100);

  if (percentage === undefined) return null;

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
