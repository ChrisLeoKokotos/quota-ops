import type { QuotaAccount } from "./quota";
import type {
  DailyTokenBucket,
  ProviderTokenTotals,
  TokenAnalyticsSnapshot,
  TokenSourceStatus,
  TokenTotals,
} from "./token-analytics";
import type {
  LocalModelSnapshot,
  LocalRuntimeSnapshot,
} from "./local-runtime";

const COLLECTOR_URL = "/api/collector";

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
  tokens?: unknown;
  runtimes?: unknown;
}

export interface CollectorSnapshot {
  generatedAt: string;
  accounts: QuotaAccount[];
  issues: CollectorAccountResult[];
  tokens: TokenAnalyticsSnapshot | null;
  runtimes: LocalRuntimeSnapshot[];
}

function isQuotaAccount(value: unknown): value is QuotaAccount {
  if (!value || typeof value !== "object") return false;
  const account = value as Partial<QuotaAccount>;

  return (
    typeof account.id === "string" &&
    typeof account.label === "string" &&
    (account.provider === "claude" || account.provider === "openai") &&
    typeof account.plan === "string" &&
    typeof account.updatedAt === "string" &&
    Array.isArray(account.windows) &&
    account.windows.length > 0 &&
    account.windows.every(
      (window) =>
        !!window &&
        typeof window.id === "string" &&
        typeof window.label === "string" &&
        typeof window.usedPercent === "number" &&
        (typeof window.resetAt === "string" || window.resetAt === null),
    )
  );
}

function isTokenTotals(value: unknown): value is TokenTotals {
  if (!value || typeof value !== "object") return false;
  const totals = value as Partial<TokenTotals>;
  return (
    typeof totals.inputTokens === "number" &&
    Number.isFinite(totals.inputTokens) &&
    totals.inputTokens >= 0 &&
    typeof totals.outputTokens === "number" &&
    Number.isFinite(totals.outputTokens) &&
    totals.outputTokens >= 0 &&
    typeof totals.cacheReadTokens === "number" &&
    Number.isFinite(totals.cacheReadTokens) &&
    totals.cacheReadTokens >= 0 &&
    typeof totals.cacheWriteTokens === "number" &&
    Number.isFinite(totals.cacheWriteTokens) &&
    totals.cacheWriteTokens >= 0 &&
    typeof totals.totalTokens === "number" &&
    Number.isFinite(totals.totalTokens) &&
    totals.totalTokens >= 0
  );
}

function isProviderTokenTotals(value: unknown): value is ProviderTokenTotals {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<ProviderTokenTotals>;
  return (
    (item.provider === "claude" || item.provider === "openai") &&
    isTokenTotals(item.totals)
  );
}

function isDailyTokenBucket(value: unknown): value is DailyTokenBucket {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<DailyTokenBucket>;
  return (
    typeof item.date === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(item.date) &&
    (item.provider === "claude" || item.provider === "openai") &&
    isTokenTotals(item)
  );
}

function isTokenSourceStatus(value: unknown): value is TokenSourceStatus {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<TokenSourceStatus>;
  return (
    (item.source === "claude-code" || item.source === "codex") &&
    (item.provider === "claude" || item.provider === "openai") &&
    (item.state === "ok" ||
      item.state === "not_found" ||
      item.state === "partial") &&
    typeof item.files === "number" &&
    Number.isFinite(item.files) &&
    item.files >= 0 &&
    (item.message === null || typeof item.message === "string")
  );
}

function parseTokenAnalytics(value: unknown): TokenAnalyticsSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Partial<TokenAnalyticsSnapshot>;

  if (
    typeof item.generatedAt !== "string" ||
    item.scope !== "locally_observed" ||
    !isTokenTotals(item.totals) ||
    !Array.isArray(item.providers) ||
    !item.providers.every(isProviderTokenTotals) ||
    !Array.isArray(item.daily) ||
    !item.daily.every(isDailyTokenBucket) ||
    !Array.isArray(item.sources) ||
    !item.sources.every(isTokenSourceStatus)
  ) {
    return null;
  }

  return item as TokenAnalyticsSnapshot;
}


function isLocalModelSnapshot(value: unknown): value is LocalModelSnapshot {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<LocalModelSnapshot>;
  return (
    typeof item.name === "string" &&
    (item.family === null || typeof item.family === "string") &&
    (item.parameterSize === null || typeof item.parameterSize === "string") &&
    (item.quantization === null || typeof item.quantization === "string") &&
    (item.sizeBytes === null ||
      (typeof item.sizeBytes === "number" &&
        Number.isFinite(item.sizeBytes) &&
        item.sizeBytes >= 0)) &&
    (typeof item.loaded === "boolean" || item.loaded === null) &&
    (item.vramBytes === null ||
      (typeof item.vramBytes === "number" &&
        Number.isFinite(item.vramBytes) &&
        item.vramBytes >= 0)) &&
    (item.contextLength === null ||
      (typeof item.contextLength === "number" &&
        Number.isFinite(item.contextLength) &&
        item.contextLength >= 0)) &&
    (item.expiresAt === null || typeof item.expiresAt === "string")
  );
}

function isLocalRuntimeSnapshot(value: unknown): value is LocalRuntimeSnapshot {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<LocalRuntimeSnapshot>;
  return (
    item.runtime === "ollama" &&
    typeof item.label === "string" &&
    (item.state === "online" ||
      item.state === "offline" ||
      item.state === "partial") &&
    (item.version === null || typeof item.version === "string") &&
    typeof item.checkedAt === "string" &&
    Array.isArray(item.models) &&
    item.models.every(isLocalModelSnapshot) &&
    (item.installedModelCount === null ||
      (typeof item.installedModelCount === "number" && Number.isSafeInteger(item.installedModelCount) && item.installedModelCount >= 0)) &&
    (item.loadedModelCount === null ||
      (typeof item.loadedModelCount === "number" && Number.isSafeInteger(item.loadedModelCount) && item.loadedModelCount >= 0)) &&
    (item.message === null || typeof item.message === "string")
  );
}

function parseLocalRuntimes(value: unknown): LocalRuntimeSnapshot[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isLocalRuntimeSnapshot);
}

export async function fetchCollectorSnapshot(
  signal?: AbortSignal,
): Promise<CollectorSnapshot> {
  const init: RequestInit = {
    method: "GET",
    cache: "no-store",
    headers: {
      "X-QuotaOps-Client": "dashboard",
    },
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
    tokens: parseTokenAnalytics(payload.tokens),
    runtimes: parseLocalRuntimes(payload.runtimes),
  };
}
