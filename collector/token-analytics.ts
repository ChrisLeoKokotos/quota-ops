import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
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

function isoDateKey(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return null;
  return new Date(time).toISOString().slice(0, 10);
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
  if (!message) return null;

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
    typeof record.uuid === "string" && record.uuid
      ? record.uuid
      : typeof record.requestId === "string" && record.requestId
        ? `${String(record.sessionId ?? "")}:${record.requestId}`
        : "";

  if (!id) return null;

  return {
    id,
    date: isoDateKey(record.timestamp),
    totals: tokenTotals(
      usage.input,
      usage.output,
      usage.cacheRead,
      usage.cacheWrite,
      usage.input + usage.output + usage.cacheRead + usage.cacheWrite,
    ),
  };
}

interface CodexCumulative {
  input: number;
  output: number;
  cacheRead: number;
}

export function parseCodexCumulative(
  record: Record<string, unknown>,
): { date: string | null; cumulative: CodexCumulative } | null {
  if (record.type !== "event_msg") return null;

  const payload =
    record.payload && typeof record.payload === "object"
      ? (record.payload as Record<string, unknown>)
      : null;
  if (!payload || payload.type !== "token_count") return null;

  const info =
    payload.info && typeof payload.info === "object"
      ? (payload.info as Record<string, unknown>)
      : null;
  const total =
    info?.total_token_usage && typeof info.total_token_usage === "object"
      ? (info.total_token_usage as Record<string, unknown>)
      : null;
  if (!total) return null;

  return {
    date: isoDateKey(record.timestamp),
    cumulative: {
      input: safeTokenNumber(total.input_tokens),
      output: safeTokenNumber(total.output_tokens),
      cacheRead: safeTokenNumber(total.cached_input_tokens),
    },
  };
}

function cumulativeDelta(current: number, previous: number): number {
  return current >= previous ? current - previous : current;
}

async function scanClaudeCode(): Promise<ScanResult> {
  const root = join(homedir(), ".claude", "projects");
  const paths = await findJsonlFiles(root);
  const seen = new Set<string>();
  let totals = emptyTokenTotals();
  const daily = new Map<string, MutableDailyBucket>();
  let files = 0;
  let readErrors = 0;

  for (const path of paths) {
    const ok = await readJsonl(path, (record) => {
      const parsed = parseClaudeTokenRecord(record);
      if (!parsed || seen.has(parsed.id)) return;
      seen.add(parsed.id);
      totals = addTokenTotals(totals, parsed.totals);
      addDaily(daily, "claude", parsed.date, parsed.totals);
    });
    if (ok) files += 1;
    else readErrors += 1;
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
  const root = join(homedir(), ".codex", "sessions");
  const paths = await findJsonlFiles(root);
  let totals = emptyTokenTotals();
  const daily = new Map<string, MutableDailyBucket>();
  let files = 0;
  let readErrors = 0;

  for (const path of paths) {
    let last: CodexCumulative = { input: 0, output: 0, cacheRead: 0 };

    const ok = await readJsonl(path, (record) => {
      const parsed = parseCodexCumulative(record);
      if (!parsed) return;

      const input = cumulativeDelta(parsed.cumulative.input, last.input);
      const output = cumulativeDelta(parsed.cumulative.output, last.output);
      const cacheRead = cumulativeDelta(
        parsed.cumulative.cacheRead,
        last.cacheRead,
      );
      last = parsed.cumulative;

      if (input + output === 0 && cacheRead === 0) return;

      // Codex reports cached_input_tokens as a subset of input_tokens.
      // Keep it as a breakdown, but do not add it twice to totalTokens.
      const value = tokenTotals(
        input,
        output,
        cacheRead,
        0,
        input + output,
      );
      totals = addTokenTotals(totals, value);
      addDaily(daily, "openai", parsed.date, value);
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
