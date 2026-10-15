import { createHash } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { Provider } from "../lib/quota.ts";
import type { TokenAnalyticsConsent } from "./types.ts";
import { readBoundedJsonl } from "./bounded-jsonl.ts";
import {
  addTokenTotals,
  emptyTokenTotals,
  type DailyTokenBucket,
  type ProviderTokenTotals,
  type TokenAnalyticsSnapshot,
  type TokenSourceStatus,
  type TokenTotals,
} from "../lib/token-analytics.ts";

const MAX_FILES_PER_SOURCE = 20_000;
const MAX_FILE_BYTES = 256 * 1024 * 1024;
const MAX_SCAN_BYTES_PER_SOURCE = 512 * 1024 * 1024;
/**
 * Byte budgets alone do not bound a scan. Every budget below closes a
 * different way a corpus can stay inside the documented size limits while
 * still costing unbounded time or memory. Exhausting any of them reports the
 * source as partial rather than complete.
 *
 * - duration: wall-clock ceiling for one source.
 * - tracked records: how many distinct ids the de-duplication state holds.
 * - key bytes: how large one of those ids may be. Ids come from the file, so
 *   capping the count alone still allows 200k keys of 2 MiB each.
 * - daily buckets: distinct dates, which are also file-controlled and are
 *   serialised into every snapshot response.
 * - directories: the tree walk runs before any record is read, so it needs
 *   its own ceiling and its own view of the deadline.
 */
const MAX_SCAN_DURATION_MS = 20_000;
const MAX_TRACKED_RECORDS_PER_SOURCE = 200_000;
const MAX_TRACKING_KEY_CHARS = 200;
const MAX_DAILY_BUCKETS_PER_SOURCE = 2_000;
/**
 * The assembled snapshot is serialised into every collector response, and the
 * dashboard proxy rejects a body over 256 KiB. Keeping the most recent days
 * bounds that body while preserving the data a user actually looks at; a
 * truncated snapshot reports its sources as partial.
 */
const MAX_DAILY_BUCKETS_IN_SNAPSHOT = 800;
const MAX_DIRECTORIES_PER_SOURCE = 50_000;

/**
 * Keeps aggregation keys bounded. A record id is attacker-influenced text up
 * to the 2 MiB per-record limit, and it is retained for the whole scan, so an
 * oversized one is replaced by a digest of itself. Collisions are irrelevant
 * here: the key only de-duplicates repeated reports of the same record.
 */
function boundedKey(value: string): string {
  if (value.length <= MAX_TRACKING_KEY_CHARS) return value;
  return "sha256:" + createHash("sha256").update(value).digest("base64url");
}

interface MutableDailyBucket extends TokenTotals {
  date: string;
  provider: Provider;
}

interface ScanResult {
  provider: Provider;
  source: TokenSourceStatus["source"];
  files: number;
  readErrors: number;
  /** True when a time or aggregation budget stopped the scan early. */
  truncated: boolean;
  totals: TokenTotals;
  daily: Map<string, MutableDailyBucket>;
}

function safeTokenNumber(value: unknown): number {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= Number.MAX_SAFE_INTEGER
    ? Math.floor(value)
    : 0;
}

function localDateKey(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return null;

  const date = new Date(time);
  const year = date.getFullYear();

  // The dashboard validates each bucket against /^\d{4}-\d{2}-\d{2}$/ and
  // discards the entire analytics snapshot if one fails. An unpadded year
  // ("999-01-01") or an expanded one ("12345-06-07") would therefore let a
  // single malformed record silently blank the whole panel, so reject the
  // record here instead of emitting a key the consumer cannot accept.
  if (year < 1 || year > 9999) return null;

  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${String(year).padStart(4, "0")}-${month}-${day}`;
}

function timestampSeconds(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time / 1000 : null;
}

function tokenTotals(
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number,
  cacheWriteTokens: number,
  totalTokens: number,
): TokenTotals {
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens,
  };
}

/** Returns false when the bucket was dropped because the date cap was reached. */
function addDaily(
  daily: Map<string, MutableDailyBucket>,
  provider: Provider,
  date: string | null,
  value: TokenTotals,
): boolean {
  if (!date) return true;
  const key = `${provider}:${date}`;
  const existing = daily.get(key);
  if (!existing && daily.size >= MAX_DAILY_BUCKETS_PER_SOURCE) return false;

  const current = existing ?? { date, provider, ...emptyTokenTotals() };
  daily.set(key, {
    date,
    provider,
    ...addTokenTotals(current, value),
  });
  return true;
}

interface FileWalk {
  files: string[];
  /** True when a ceiling stopped the walk before the tree was exhausted. */
  truncated: boolean;
}

/**
 * The walk runs before any record is read, so it needs its own ceilings: a
 * tree of empty directories satisfies no file-count limit and would otherwise
 * run unbounded, holding the collector's `collecting` flag and starving every
 * later poll. `withFileTypes` reports a symlinked directory as a symlink
 * rather than a directory, so links are not followed and cannot form a cycle.
 */
async function findJsonlFiles(
  root: string,
  deadline: number,
): Promise<FileWalk> {
  const files: string[] = [];
  const pending = [root];
  let directories = 0;
  let truncated = false;

  while (pending.length > 0) {
    if (files.length >= MAX_FILES_PER_SOURCE) {
      truncated = true;
      break;
    }
    if (directories >= MAX_DIRECTORIES_PER_SOURCE || Date.now() > deadline) {
      truncated = true;
      break;
    }

    const dir = pending.pop();
    if (!dir) break;
    directories += 1;

    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (files.length >= MAX_FILES_PER_SOURCE) {
        truncated = true;
        break;
      }
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (pending.length + directories >= MAX_DIRECTORIES_PER_SOURCE) {
          truncated = true;
          continue;
        }
        pending.push(full);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        files.push(full);
      }
    }
  }

  return { files, truncated };
}


function usageNumbers(value: unknown): {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
} {
  const usage =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};

  const iterations = Array.isArray(usage.iterations)
    ? usage.iterations
    : null;

  if (iterations && iterations.length > 0) {
    return iterations.reduce(
      (sum, iteration) => {
        const record =
          iteration && typeof iteration === "object"
            ? (iteration as Record<string, unknown>)
            : {};
        return {
          input: sum.input + safeTokenNumber(record.input_tokens),
          output: sum.output + safeTokenNumber(record.output_tokens),
          cacheRead:
            sum.cacheRead + safeTokenNumber(record.cache_read_input_tokens),
          cacheWrite:
            sum.cacheWrite +
            safeTokenNumber(record.cache_creation_input_tokens),
        };
      },
      { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    );
  }

  return {
    input: safeTokenNumber(usage.input_tokens),
    output: safeTokenNumber(usage.output_tokens),
    cacheRead: safeTokenNumber(usage.cache_read_input_tokens),
    cacheWrite: safeTokenNumber(usage.cache_creation_input_tokens),
  };
}

export function parseClaudeTokenRecord(
  record: Record<string, unknown>,
): { id: string; date: string | null; totals: TokenTotals } | null {
  if (record.type !== "assistant") return null;

  const message =
    record.message && typeof record.message === "object"
      ? (record.message as Record<string, unknown>)
      : null;
  if (!message || message.model === "<synthetic>") return null;

  const usage = usageNumbers(message.usage);
  if (
    usage.input +
      usage.output +
      usage.cacheRead +
      usage.cacheWrite ===
    0
  ) {
    return null;
  }

  const id =
    typeof message.id === "string" && message.id
      ? message.id
      : typeof record.uuid === "string" && record.uuid
        ? record.uuid
        : typeof record.requestId === "string" && record.requestId
          ? `${String(record.sessionId ?? "")}:${record.requestId}`
          : "";

  if (!id) return null;

  return {
    id,
    date: localDateKey(record.timestamp),
    totals: tokenTotals(
      usage.input,
      usage.output,
      usage.cacheRead,
      usage.cacheWrite,
      usage.input + usage.output + usage.cacheRead + usage.cacheWrite,
    ),
  };
}

function maxTokenTotals(a: TokenTotals, b: TokenTotals): TokenTotals {
  const inputTokens = Math.max(a.inputTokens, b.inputTokens);
  const outputTokens = Math.max(a.outputTokens, b.outputTokens);
  const cacheReadTokens = Math.max(a.cacheReadTokens, b.cacheReadTokens);
  const cacheWriteTokens = Math.max(a.cacheWriteTokens, b.cacheWriteTokens);
  return tokenTotals(
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
  );
}

interface CodexRawUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface CodexTokenState {
  sawSessionMeta: boolean;
  sessionId: string;
  replayGate: { createdAtSeconds: number | null } | null;
  previousCumulative: CodexRawUsage | null;
}

export function createCodexTokenState(): CodexTokenState {
  return {
    sawSessionMeta: false,
    sessionId: "",
    replayGate: null,
    previousCumulative: null,
  };
}

function nonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function isCodexChildSession(payload: Record<string, unknown>): boolean {
  if (nonEmptyString(payload.forked_from_id)) return true;
  if (nonEmptyString(payload.parent_thread_id)) return true;
  if (payload.thread_source === "subagent") return true;

  const source =
    payload.source && typeof payload.source === "object"
      ? (payload.source as Record<string, unknown>)
      : null;
  return !!source?.subagent;
}

function codexUsage(value: unknown): CodexRawUsage | null {
  if (!value || typeof value !== "object") return null;
  const usage = value as Record<string, unknown>;
  return {
    input: safeTokenNumber(
      usage.input_tokens ?? usage.prompt_tokens ?? usage.input,
    ),
    output: safeTokenNumber(
      usage.output_tokens ?? usage.completion_tokens ?? usage.output,
    ),
    cacheRead: safeTokenNumber(
      usage.cached_input_tokens ??
        usage.cache_read_input_tokens ??
        usage.cached_tokens,
    ),
    cacheWrite: safeTokenNumber(
      usage.cache_write_input_tokens ?? usage.cache_creation_input_tokens,
    ),
  };
}

function sameCodexUsage(a: CodexRawUsage, b: CodexRawUsage): boolean {
  return (
    a.input === b.input &&
    a.output === b.output &&
    a.cacheRead === b.cacheRead &&
    a.cacheWrite === b.cacheWrite
  );
}

function subtractCodexUsage(
  current: CodexRawUsage,
  previous: CodexRawUsage | null,
): CodexRawUsage {
  return {
    input: Math.max(0, current.input - (previous?.input ?? 0)),
    output: Math.max(0, current.output - (previous?.output ?? 0)),
    cacheRead: Math.max(0, current.cacheRead - (previous?.cacheRead ?? 0)),
    cacheWrite: Math.max(
      0,
      current.cacheWrite - (previous?.cacheWrite ?? 0),
    ),
  };
}

export function parseCodexTokenRecord(
  record: Record<string, unknown>,
  state: CodexTokenState,
): { id: string; date: string | null; totals: TokenTotals } | null {
  const payload =
    record.payload && typeof record.payload === "object"
      ? (record.payload as Record<string, unknown>)
      : null;

  if (record.type === "session_meta" && payload && !state.sawSessionMeta) {
    state.sawSessionMeta = true;
    const id = payload.id ?? payload.session_id;
    if (typeof id === "string") state.sessionId = id;

    if (isCodexChildSession(payload)) {
      state.replayGate = {
        createdAtSeconds: timestampSeconds(record.timestamp),
      };
    }
    return null;
  }

  if (record.type !== "event_msg" || !payload) return null;

  if (payload.type === "task_started" && state.replayGate) {
    const startedAt =
      typeof payload.started_at === "number" &&
      Number.isFinite(payload.started_at)
        ? payload.started_at
        : null;
    const lineSeconds = timestampSeconds(record.timestamp);
    const threshold =
      state.replayGate.createdAtSeconds ??
      (lineSeconds === null ? null : Math.floor(lineSeconds));

    if (startedAt !== null && threshold !== null && startedAt >= threshold) {
      state.replayGate = null;
    }
    return null;
  }

  if (payload.type !== "token_count") return null;

  const info =
    payload.info && typeof payload.info === "object"
      ? (payload.info as Record<string, unknown>)
      : null;
  if (!info) return null;

  const cumulative = codexUsage(info.total_token_usage);

  // Child/fork rollouts can replay their parent's complete token history.
  // The replay still seeds the cumulative baseline, but must not count again.
  if (state.replayGate) {
    if (cumulative) state.previousCumulative = cumulative;
    return null;
  }

  if (
    cumulative &&
    state.previousCumulative &&
    sameCodexUsage(cumulative, state.previousCumulative)
  ) {
    return null;
  }

  const direct = codexUsage(info.last_token_usage);
  const usage =
    direct ?? (cumulative ? subtractCodexUsage(cumulative, state.previousCumulative) : null);

  if (cumulative) state.previousCumulative = cumulative;
  if (!usage) return null;
  if (usage.input + usage.output + usage.cacheRead + usage.cacheWrite === 0) {
    return null;
  }

  // Codex input_tokens includes cached input. Cache values are a breakdown,
  // not extra tokens on top of input.
  const cacheRead = Math.min(usage.cacheRead, usage.input);
  const cacheWrite = Math.min(
    usage.cacheWrite,
    Math.max(0, usage.input - cacheRead),
  );
  const totals = tokenTotals(
    usage.input,
    usage.output,
    cacheRead,
    cacheWrite,
    usage.input + usage.output,
  );
  const timestamp =
    typeof record.timestamp === "string" ? record.timestamp : "";
  const signature = [
    usage.input,
    usage.output,
    usage.cacheRead,
    usage.cacheWrite,
  ].join(":");

  return {
    id: `${state.sessionId || "unknown"}:${timestamp}:${signature}`,
    date: localDateKey(record.timestamp),
    totals,
  };
}

async function scanClaudeCode(): Promise<ScanResult> {
  // The deadline starts before the walk, which is part of the scan's cost.
  const deadline = Date.now() + MAX_SCAN_DURATION_MS;
  const root = join(homedir(), ".claude", "projects");
  const walk = await findJsonlFiles(root, deadline);
  const paths = walk.files;
  const best = new Map<
    string,
    { date: string | null; totals: TokenTotals }
  >();
  const daily = new Map<string, MutableDailyBucket>();
  let files = 0;
  let readErrors = 0;
  let scanBytes = 0;
  let truncated = walk.truncated;
  const budgetExhausted = (): boolean =>
    Date.now() > deadline || best.size >= MAX_TRACKED_RECORDS_PER_SOURCE;

  for (const path of paths) {
    if (budgetExhausted()) {
      truncated = true;
      break;
    }

    const size = await stat(path).then((info) => info.size).catch(() => null);
    if (size === null || size > MAX_FILE_BYTES || scanBytes + size > MAX_SCAN_BYTES_PER_SOURCE) {
      readErrors += 1;
      continue;
    }
    scanBytes += size;
    const ok = await readBoundedJsonl(
      path,
      (record) => {
        const parsed = parseClaudeTokenRecord(record);
        if (!parsed) return;

        const key = boundedKey(parsed.id);
        const previous = best.get(key);
        if (!previous && best.size >= MAX_TRACKED_RECORDS_PER_SOURCE) return;

        best.set(key, {
          date: previous?.date ?? parsed.date,
          totals: previous
            ? maxTokenTotals(previous.totals, parsed.totals)
            : parsed.totals,
        });
      },
      { shouldStop: budgetExhausted },
    );

    if (ok) files += 1;
    else if (budgetExhausted()) {
      truncated = true;
      break;
    } else readErrors += 1;
  }

  let totals = emptyTokenTotals();
  for (const item of best.values()) {
    totals = addTokenTotals(totals, item.totals);
    if (!addDaily(daily, "claude", item.date, item.totals)) truncated = true;
  }

  return {
    provider: "claude",
    source: "claude-code",
    files,
    readErrors,
    truncated,
    totals,
    daily,
  };
}

async function scanCodex(): Promise<ScanResult> {
  // The deadline starts before the walk, which is part of the scan's cost.
  const deadline = Date.now() + MAX_SCAN_DURATION_MS;
  const codexHome = join(homedir(), ".codex");
  const active = await findJsonlFiles(join(codexHome, "sessions"), deadline);
  const archived = await findJsonlFiles(
    join(codexHome, "archived_sessions"),
    deadline,
  );
  const paths = [...new Set([...active.files, ...archived.files])];
  const seen = new Set<string>();
  let totals = emptyTokenTotals();
  const daily = new Map<string, MutableDailyBucket>();
  let files = 0;
  let readErrors = 0;
  let scanBytes = 0;
  let truncated = active.truncated || archived.truncated;

  const budgetExhausted = (): boolean =>
    Date.now() > deadline || seen.size >= MAX_TRACKED_RECORDS_PER_SOURCE;

  for (const path of paths) {
    if (budgetExhausted()) {
      truncated = true;
      break;
    }

    const size = await stat(path).then((info) => info.size).catch(() => null);
    if (size === null || size > MAX_FILE_BYTES || scanBytes + size > MAX_SCAN_BYTES_PER_SOURCE) {
      readErrors += 1;
      continue;
    }
    scanBytes += size;
    const state = createCodexTokenState();
    const ok = await readBoundedJsonl(
      path,
      (record) => {
        const parsed = parseCodexTokenRecord(record, state);
        if (!parsed) return;

        const key = boundedKey(parsed.id);
        if (seen.has(key)) return;
        if (seen.size >= MAX_TRACKED_RECORDS_PER_SOURCE) return;
        seen.add(key);

        totals = addTokenTotals(totals, parsed.totals);
        if (!addDaily(daily, "openai", parsed.date, parsed.totals)) {
          truncated = true;
        }
      },
      { shouldStop: budgetExhausted },
    );

    if (ok) files += 1;
    else if (budgetExhausted()) {
      truncated = true;
      break;
    } else readErrors += 1;
  }

  return {
    provider: "openai",
    source: "codex",
    files,
    readErrors,
    truncated,
    totals,
    daily,
  };
}

function sourceStatus(result: ScanResult): TokenSourceStatus {
  const missing =
    result.files === 0 && result.readErrors === 0 && !result.truncated;
  const label = result.source === "claude-code" ? "Claude Code" : "Codex";

  // Totals are never presented as complete once a file was rejected or a
  // budget stopped the scan; counts stay numeric and name no file content.
  let message: string | null = null;
  if (missing) {
    message = `No ${label} session logs found.`;
  } else if (result.truncated) {
    message = `${label} scan stopped at its time or record budget; totals are partial.`;
  } else if (result.readErrors > 0) {
    message = `${result.readErrors} session file(s) could not be read.`;
  }

  return {
    source: result.source,
    provider: result.provider,
    state: missing
      ? "not_found"
      : result.readErrors > 0 || result.truncated
        ? "partial"
        : "ok",
    files: result.files,
    message,
  };
}

/**
 * Each source is read only with its own recorded consent. A source the user
 * has not consented to is reported `disabled`, never `not_found`: QuotaOps
 * did not look, so it must not imply it looked and found nothing.
 */
function disabledSource(
  source: TokenSourceStatus["source"],
  provider: Provider,
): TokenSourceStatus {
  const label = source === "claude-code" ? "Claude Code" : "Codex";
  return {
    source,
    provider,
    state: "disabled",
    files: 0,
    message: `${label} history scanning is turned off. QuotaOps did not read these files.`,
  };
}

export async function collectLocalTokenAnalytics(
  consent: TokenAnalyticsConsent,
): Promise<TokenAnalyticsSnapshot> {
  const [claudeScan, codexScan] = await Promise.all([
    consent.claudeCode ? scanClaudeCode() : null,
    consent.codex ? scanCodex() : null,
  ]);

  const scans = [claudeScan, codexScan].filter(
    (scan): scan is ScanResult => scan !== null,
  );

  let totals = emptyTokenTotals();
  const providers: ProviderTokenTotals[] = [];
  const daily = new Map<string, MutableDailyBucket>();

  for (const scan of scans) {
    totals = addTokenTotals(totals, scan.totals);
    providers.push({
      provider: scan.provider,
      totals: scan.totals,
    });

    for (const [key, bucket] of scan.daily) {
      const existing = daily.get(key);
      daily.set(
        key,
        existing
          ? {
              date: bucket.date,
              provider: bucket.provider,
              ...addTokenTotals(existing, bucket),
            }
          : bucket,
      );
    }
  }

  const allBuckets: DailyTokenBucket[] = [...daily.values()].sort((a, b) =>
    a.date.localeCompare(b.date) || a.provider.localeCompare(b.provider),
  );
  const dailyTruncated = allBuckets.length > MAX_DAILY_BUCKETS_IN_SNAPSHOT;
  const dailyBuckets = dailyTruncated
    ? allBuckets.slice(allBuckets.length - MAX_DAILY_BUCKETS_IN_SNAPSHOT)
    : allBuckets;

  const sources: TokenSourceStatus[] = [
    claudeScan
      ? sourceStatus({ ...claudeScan, truncated: claudeScan.truncated || dailyTruncated })
      : disabledSource("claude-code", "claude"),
    codexScan
      ? sourceStatus({ ...codexScan, truncated: codexScan.truncated || dailyTruncated })
      : disabledSource("codex", "openai"),
  ];

  return {
    generatedAt: new Date().toISOString(),
    scope: "locally_observed",
    totals,
    providers: providers.sort(
      (a, b) => b.totals.totalTokens - a.totals.totalTokens,
    ),
    daily: dailyBuckets,
    sources,
  };
}
