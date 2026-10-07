import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

import type { Provider } from "../lib/quota.ts";
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

interface MutableDailyBucket extends TokenTotals {
  date: string;
  provider: Provider;
}

interface ScanResult {
  provider: Provider;
  source: TokenSourceStatus["source"];
  files: number;
  readErrors: number;
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
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
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

function addDaily(
  daily: Map<string, MutableDailyBucket>,
  provider: Provider,
  date: string | null,
  value: TokenTotals,
): void {
  if (!date) return;
  const key = `${provider}:${date}`;
  const current =
    daily.get(key) ?? { date, provider, ...emptyTokenTotals() };
  daily.set(key, {
    date,
    provider,
    ...addTokenTotals(current, value),
  });
}

async function findJsonlFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const pending = [root];

  while (pending.length > 0 && files.length < MAX_FILES_PER_SOURCE) {
    const dir = pending.pop();
    if (!dir) break;

    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (files.length >= MAX_FILES_PER_SOURCE) break;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        pending.push(full);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        files.push(full);
      }
    }
  }

  return files;
}

async function readJsonl(
  path: string,
  onRecord: (record: Record<string, unknown>) => void,
): Promise<boolean> {
  try {
    const metadata = await stat(path);
    if (!metadata.isFile() || metadata.size > MAX_FILE_BYTES) return false;

    const stream = createReadStream(path, {
      encoding: "utf8",
      highWaterMark: 64 * 1024,
    });
    const lines = createInterface({
      input: stream,
      crlfDelay: Infinity,
    });

    for await (const line of lines) {
      if (!line.trim()) continue;
      try {
        const parsed: unknown = JSON.parse(line);
        if (parsed && typeof parsed === "object") {
          onRecord(parsed as Record<string, unknown>);
        }
      } catch {
        // A concurrently written JSONL file can have one incomplete trailing line.
      }
    }

    return true;
  } catch {
    return false;
  }
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
  const root = join(homedir(), ".claude", "projects");
  const paths = await findJsonlFiles(root);
  const best = new Map<
    string,
    { date: string | null; totals: TokenTotals }
  >();
  const daily = new Map<string, MutableDailyBucket>();
  let files = 0;
  let readErrors = 0;

  for (const path of paths) {
    const ok = await readJsonl(path, (record) => {
      const parsed = parseClaudeTokenRecord(record);
      if (!parsed) return;

      const previous = best.get(parsed.id);
      best.set(parsed.id, {
        date: previous?.date ?? parsed.date,
        totals: previous
          ? maxTokenTotals(previous.totals, parsed.totals)
          : parsed.totals,
      });
    });
    if (ok) files += 1;
    else readErrors += 1;
  }

  let totals = emptyTokenTotals();
  for (const item of best.values()) {
    totals = addTokenTotals(totals, item.totals);
    addDaily(daily, "claude", item.date, item.totals);
  }

  return {
    provider: "claude",
    source: "claude-code",
    files,
    readErrors,
    totals,
    daily,
  };
}

async function scanCodex(): Promise<ScanResult> {
  const codexHome = join(homedir(), ".codex");
  const active = await findJsonlFiles(join(codexHome, "sessions"));
  const archived = await findJsonlFiles(join(codexHome, "archived_sessions"));
  const paths = [...new Set([...active, ...archived])];
  const seen = new Set<string>();
  let totals = emptyTokenTotals();
  const daily = new Map<string, MutableDailyBucket>();
  let files = 0;
  let readErrors = 0;

  for (const path of paths) {
    const state = createCodexTokenState();
    const ok = await readJsonl(path, (record) => {
      const parsed = parseCodexTokenRecord(record, state);
      if (!parsed || seen.has(parsed.id)) return;
      seen.add(parsed.id);

      totals = addTokenTotals(totals, parsed.totals);
      addDaily(daily, "openai", parsed.date, parsed.totals);
    });

    if (ok) files += 1;
    else readErrors += 1;
  }

  return {
    provider: "openai",
    source: "codex",
    files,
    readErrors,
    totals,
    daily,
  };
}

function sourceStatus(result: ScanResult): TokenSourceStatus {
  const missing = result.files === 0 && result.readErrors === 0;
  return {
    source: result.source,
    provider: result.provider,
    state: missing ? "not_found" : result.readErrors > 0 ? "partial" : "ok",
    files: result.files,
    message: missing
      ? `No ${result.source === "claude-code" ? "Claude Code" : "Codex"} session logs found.`
      : result.readErrors > 0
        ? `${result.readErrors} session file(s) could not be read.`
        : null,
  };
}

export async function collectLocalTokenAnalytics(): Promise<TokenAnalyticsSnapshot> {
  const scans = await Promise.all([scanClaudeCode(), scanCodex()]);
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

  const dailyBuckets: DailyTokenBucket[] = [...daily.values()].sort((a, b) =>
    a.date.localeCompare(b.date) || a.provider.localeCompare(b.provider),
  );

  return {
    generatedAt: new Date().toISOString(),
    scope: "locally_observed",
    totals,
    providers: providers.sort(
      (a, b) => b.totals.totalTokens - a.totals.totalTokens,
    ),
    daily: dailyBuckets,
    sources: scans.map(sourceStatus),
  };
}
