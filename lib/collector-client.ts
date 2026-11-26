import { getDesktopBridge } from "./collector-transport.ts";
import type { QuotaAccount } from "./quota";
import type {
  DailyTokenBucket,
  ProviderTokenTotals,
  TokenAccountTotals,
  TokenAnalyticsSnapshot,
  TokenScanStatus,
  TokenSourceStatus,
  TokenTotals,
} from "./token-analytics";

const COLLECTOR_URL = "/api/collector";

export type CollectorConnectionState =
  | "checking"
  | "connected"
  | "offline";

export type CollectorAccountState =
  | "ok"
  | "configured"
  | "login_required"
  | "verification_required"
  | "unavailable"
  | "unsupported";

export interface CollectorAccountResult {
  id: string;
  label: string;
  status: CollectorAccountState;
  account: QuotaAccount | null;
  checkedAt: string;
  message: string | null;
  /** Last time this account returned usage, or null: never on this PC. */
  lastSuccessAt?: string | null;
}

interface CollectorSnapshotResponse {
  version: 1;
  generatedAt: string;
  accounts: CollectorAccountResult[];
  tokens?: unknown;
  tokenStatus?: unknown;
}

export interface CollectorSnapshot {
  generatedAt: string;
  accounts: QuotaAccount[];
  issues: CollectorAccountResult[];
  tokens: TokenAnalyticsSnapshot | null;
  /** Null from an older collector that does not report it. */
  tokenStatus: TokenScanStatus | null;
}

function isQuotaAccount(value: unknown): value is QuotaAccount {
  if (!value || typeof value !== "object") return false;
  const account = value as Partial<QuotaAccount>;

  return (
    typeof account.id === "string" &&
    typeof account.label === "string" &&
    (account.provider === "claude" || account.provider === "openai" || account.provider === "google") &&
    typeof account.plan === "string" &&
    typeof account.updatedAt === "string" &&
    Array.isArray(account.windows) &&
    account.windows.length > 0 &&
    account.windows.length <= 32 &&
    new Set(account.windows.map(window => window?.id)).size === account.windows.length &&
    account.windows.every(
      (window) =>
        !!window &&
        typeof window.id === "string" &&
        typeof window.label === "string" &&
        typeof window.usedPercent === "number" &&
        Number.isFinite(window.usedPercent) && window.usedPercent >= 0 && window.usedPercent <= 100 &&
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
    (item.provider === "claude" || item.provider === "openai" || item.provider === "google") &&
    isTokenTotals(item.totals)
  );
}

function isDailyTokenBucket(value: unknown): value is DailyTokenBucket {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<DailyTokenBucket>;
  return (
    typeof item.date === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(item.date) &&
    (item.provider === "claude" || item.provider === "openai" || item.provider === "google") &&
    isTokenTotals(item)
  );
}

function isTokenSourceStatus(value: unknown): value is TokenSourceStatus {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<TokenSourceStatus>;
  return (
    (item.source === "claude-code" || item.source === "codex" || item.source === "google-antigravity") &&
    (item.provider === "claude" || item.provider === "openai" || item.provider === "google") &&
    (item.state === "ok" ||
      item.state === "not_found" ||
      item.state === "partial" ||
      item.state === "disabled") &&
    typeof item.files === "number" &&
    Number.isFinite(item.files) &&
    item.files >= 0 &&
    (item.message === null || typeof item.message === "string")
  );
}

function isTokenAccountTotals(value: unknown): value is TokenAccountTotals {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<TokenAccountTotals>;
  return (
    (item.source === "claude-code" || item.source === "codex" || item.source === "google-antigravity") &&
    (item.attribution === "attributed" || item.attribution === "no_account_record" ||
      item.attribution === "several_accounts") &&
    (item.attribution === "attributed"
      ? typeof item.account === "string" && /^[0-9a-f]{12}$/.test(item.account)
      : item.account === null) &&
    typeof item.current === "boolean" &&
    typeof item.sessions === "number" && Number.isSafeInteger(item.sessions) && item.sessions >= 0 &&
    isTokenTotals(item.totals)
  );
}

export function parseTokenScanStatus(value: unknown): TokenScanStatus | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Partial<TokenScanStatus>;
  if (
    (item.state !== "disabled" && item.state !== "scanning" && item.state !== "ready" &&
      item.state !== "unavailable") ||
    typeof item.pending !== "boolean" ||
    !(item.scannedAt === null || typeof item.scannedAt === "string")
  ) {
    return null;
  }
  return { state: item.state, scannedAt: item.scannedAt, pending: item.pending };
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

  // A malformed per-account split is dropped on its own; it never changes
  // the totals and is never guessed.
  const accounts = Array.isArray(item.accounts) && item.accounts.every(isTokenAccountTotals)
    ? item.accounts
    : [];
  return { ...(item as TokenAnalyticsSnapshot), accounts };
}

/**
 * QO-SEC-01: the dashboard presents a server-minted capability rather than a
 * static client marker. The capability is only obtainable through the trusted
 * loopback server, and it is refreshed once when it expires so a long-running
 * tab does not silently fall back to an unauthorized state.
 */
let cachedCapability: string | null = null;

async function requestCapability(signal?: AbortSignal): Promise<string> {
  const init: RequestInit = { method: "GET", cache: "no-store" };
  if (signal) init.signal = signal;

  const response = await fetch(`${COLLECTOR_URL}/capability`, init);
  if (!response.ok) {
    throw new Error(`Dashboard capability unavailable (HTTP ${response.status})`);
  }

  const payload = (await response.json()) as { capability?: unknown };
  if (typeof payload.capability !== "string" || payload.capability.length === 0) {
    throw new Error("Dashboard capability response was malformed.");
  }

  cachedCapability = payload.capability;
  return payload.capability;
}

async function requestSnapshot(
  capability: string,
  signal?: AbortSignal,
): Promise<Response> {
  const init: RequestInit = {
    method: "GET",
    cache: "no-store",
    headers: { "X-QuotaOps-Capability": capability },
  };
  if (signal) init.signal = signal;

  return fetch(`${COLLECTOR_URL}/snapshot`, init);
}

/**
 * Fetches the raw snapshot payload over whichever transport is available.
 *
 * On the desktop the preload bridge answers and no HTTP request is made: the
 * renderer never holds the collector's bearer token and there is no dashboard
 * listener to reach. In the browser the existing capability-gated loopback
 * path runs unchanged.
 */
async function fetchSnapshotPayload(signal?: AbortSignal): Promise<unknown> {
  const bridge = getDesktopBridge();
  if (bridge) return bridge.getSnapshot();

  const capability = cachedCapability ?? (await requestCapability(signal));
  let response = await requestSnapshot(capability, signal);

  if (response.status === 403) {
    // The capability expired or the process restarted; mint exactly one more.
    cachedCapability = null;
    response = await requestSnapshot(await requestCapability(signal), signal);
  }

  if (!response.ok) {
    throw new Error(`Collector returned HTTP ${response.status}`);
  }

  return response.json();
}

export async function fetchCollectorSnapshot(
  signal?: AbortSignal,
): Promise<CollectorSnapshot> {
  const payload = (await fetchSnapshotPayload(signal)) as CollectorSnapshotResponse;

  // The payload is validated identically on both transports: the desktop
  // bridge is trusted to deliver it, not to have checked it.
  if (!payload || payload.version !== 1 || !Array.isArray(payload.accounts)) {
    throw new Error("Collector returned an unsupported response.");
  }

  if (payload.accounts.length > 64 || payload.accounts.some(result =>
    !result || typeof result.id !== "string" || typeof result.label !== "string") ||
    new Set(payload.accounts.map(result => result.id)).size !== payload.accounts.length) {
    throw new Error("Collector returned invalid account identities.");
  }
  const results = payload.accounts.map(result =>
    result.status === "ok" && (!isQuotaAccount(result.account) || result.account.id !== result.id)
      ? { ...result, status: "unavailable" as const, account: null, message: "Invalid or incomplete quota reading." }
      : result);
  const accounts = results
    .filter(result => result.status === "ok")
    .map(result => result.account)
    .filter(isQuotaAccount)
    .map(account => ({ ...account, source: "collector" as const }));

  return {
    generatedAt: payload.generatedAt,
    accounts,
    issues: results.filter((result) => result.status !== "ok"),
    tokens: parseTokenAnalytics(payload.tokens),
    tokenStatus: parseTokenScanStatus(payload.tokenStatus),
  };
}
