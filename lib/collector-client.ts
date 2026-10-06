import type { QuotaAccount } from "./quota";

const COLLECTOR_URL = "http://127.0.0.1:4317";

export type CollectorConnectionState =
  | "checking"
  | "connected"
  | "offline";

interface CollectorAccountResult {
  id: string;
  label: string;
  status: "ok" | "login_required" | "unavailable" | "unsupported";
  account: QuotaAccount | null;
  checkedAt: string;
  message: string | null;
}

interface CollectorSnapshotResponse {
  version: 1;
  generatedAt: string;
  accounts: CollectorAccountResult[];
}

export interface CollectorSnapshot {
  generatedAt: string;
  accounts: QuotaAccount[];
  issues: CollectorAccountResult[];
}

function isQuotaAccount(value: unknown): value is QuotaAccount {
  if (!value || typeof value !== "object") return false;
  const account = value as Partial<QuotaAccount>;

  return (
    typeof account.id === "string" &&
    typeof account.label === "string" &&
    account.provider === "claude" &&
    account.plan === "team" &&
    typeof account.updatedAt === "string" &&
    !!account.fiveHour &&
    typeof account.fiveHour.usedPercent === "number" &&
    !!account.weekly &&
    typeof account.weekly.usedPercent === "number"
  );
}

export async function fetchCollectorSnapshot(
  signal?: AbortSignal,
): Promise<CollectorSnapshot> {
  const init: RequestInit = {
    method: "GET",
    cache: "no-store",
  };
  if (signal) init.signal = signal;

  const response = await fetch(`${COLLECTOR_URL}/snapshot`, init);

  if (!response.ok) {
    throw new Error(`Collector returned HTTP ${response.status}`);
  }

  const payload = (await response.json()) as CollectorSnapshotResponse;
  if (payload.version !== 1 || !Array.isArray(payload.accounts)) {
    throw new Error("Collector returned an unsupported response.");
  }

  const accounts = payload.accounts
    .map((result) => result.account)
    .filter(isQuotaAccount)
    .map((account) => ({ ...account, source: "collector" as const }));

  return {
    generatedAt: payload.generatedAt,
    accounts,
    issues: payload.accounts.filter((result) => result.status !== "ok"),
  };
}
