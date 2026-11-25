import { createHash, randomBytes } from "node:crypto";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { Provider } from "../lib/quota.ts";
import type { TokenAnalyticsConsent } from "./types.ts";
import { readBoundedJsonl, readJsonlIncrement } from "./bounded-jsonl.ts";
import { getQuotaOpsHome } from "./paths.ts";
import {
  addTokenTotals,
  emptyTokenTotals,
  type DailyTokenBucket,
  type ProviderTokenTotals,
  type TokenAccountTotals,
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
  /** Files still waiting for a later pass (incremental sources). */
  pendingFiles?: number;
  /** Newest modification time among pending files: totals are complete after it. */
  pendingNewestMtimeMs?: number;
  /** Oversized assistant (usage-bearing) lines that had to be skipped. */
  skippedUsageLines?: number;
  totals: TokenTotals;
  daily: Map<string, MutableDailyBucket>;
  /** All-time per-account split (Claude Code only). */
  accounts?: TokenAccountTotals[];
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
  signal?: AbortSignal,
): Promise<FileWalk> {
  const files: string[] = [];
  const pending = [root];
  let directories = 0;
  let truncated = false;

  while (pending.length > 0) {
    signal?.throwIfAborted();
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
      signal?.throwIfAborted();
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

/**
 * Claude Code histories can be gigabytes (owner's PC: 381 files, 2.47 GB,
 * single files over 800 MB, lines holding pasted images). Reading all of it
 * every pass, oldest first, with a whole-file rejection on any long line,
 * left recent days, including today, missing.
 *
 * Now: newest files first; a per-file cache in the collector keeps each
 * file's records, so unchanged files are not read again and an appended
 * session file is read only from where the last pass stopped; long lines are
 * skipped, not fatal. Every pass is still bounded by time and bytes, and the
 * result says "partial" (with the reason) until every file has been covered.
 */
interface ClaudeRecord {
  date: string | null;
  totals: TokenTotals;
  /** Interned session id, used only to look up the session's account. */
  session: string | null;
}
interface ClaudeFileCache {
  size: number;
  mtimeMs: number;
  endOffset: number;
  records: Map<string, ClaudeRecord>;
  /** session id -> salted hashes of the account ids its owner records name. */
  owners: Map<string, Set<string>>;
  skippedUsageLines: number;
}
const claudeFileCache = new Map<string, ClaudeFileCache>();
const CLAUDE_BYTES_PER_PASS = 1024 * 1024 * 1024;
const ASSISTANT_RECORD_HEAD = /"type"\s*:\s*"assistant"/;
let lastClaudePendingFiles = 0;

/** Session ids repeat on every record of a session: keep one copy of each. */
const MAX_INTERNED_SESSIONS = 50_000;
const internedSessions = new Map<string, string>();
function internSession(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 100) return null;
  const known = internedSessions.get(value);
  if (known) return known;
  if (internedSessions.size >= MAX_INTERNED_SESSIONS) return null;
  internedSessions.set(value, value);
  return value;
}

/**
 * Account ids are stored and shown only as a salted one-way hash. The salt
 * is random per QuotaOps home, so the short key cannot be matched against
 * anything outside this PC.
 */
let accountSalt: Buffer | null = null;
async function loadAccountSalt(): Promise<Buffer> {
  if (accountSalt) return accountSalt;
  const path = join(getQuotaOpsHome(), "token-account-salt");
  try {
    const existing = await readFile(path);
    if (existing.length >= 32) return (accountSalt = existing.subarray(0, 32));
  } catch {
    // Created below.
  }
  const fresh = randomBytes(32);
  try {
    await writeFile(path, fresh, { flag: "wx", mode: 0o600 });
    accountSalt = fresh;
  } catch {
    // Lost a race with another writer, or the home is not writable: use
    // whatever is on disk, else keep this process's salt in memory only.
    const again = await readFile(path).catch(() => null);
    accountSalt = again && again.length >= 32 ? again.subarray(0, 32) : fresh;
  }
  return accountSalt;
}
function accountKey(salt: Buffer, accountId: string): string {
  return createHash("sha256").update(salt).update(accountId).digest("hex").slice(0, 12);
}
const ACCOUNT_ID_PATTERN = /^[0-9a-f-]{8,64}$/i;

/**
 * The account Claude Code is signed in to now (~/.claude.json), as the same
 * salted key. Only that one field is used; the file is not kept.
 */
async function currentClaudeAccountKey(salt: Buffer): Promise<string | null> {
  const path = join(homedir(), ".claude.json");
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > 16 * 1024 * 1024) return null;
    const parsed = JSON.parse(await readFile(path, "utf8")) as { oauthAccount?: { accountUuid?: unknown } };
    const id = parsed?.oauthAccount?.accountUuid;
    return typeof id === "string" && ACCOUNT_ID_PATTERN.test(id) ? accountKey(salt, id) : null;
  } catch {
    return null;
  }
}

/** Test seam: forget cached files (a fresh collector process). */
export function resetTokenScanCache(): void {
  claudeFileCache.clear();
  internedSessions.clear();
  accountSalt = null;
  lastClaudePendingFiles = 0;
}

/** True while the last Claude Code pass left older files for a later pass. */
export function tokenScanPending(): boolean {
  return lastClaudePendingFiles > 0;
}

async function scanClaudeCode(signal?: AbortSignal): Promise<ScanResult> {
  signal?.throwIfAborted();
  // The deadline starts before the walk, which is part of the scan's cost.
  const deadline = Date.now() + MAX_SCAN_DURATION_MS;
  const salt = await loadAccountSalt();
  const root = join(homedir(), ".claude", "projects");
  const walk = await findJsonlFiles(root, deadline, signal);
  let truncated = walk.truncated;
  let readErrors = 0;
  let pendingFiles = 0;
  let pendingNewestMtimeMs = 0;
  let bytesThisPass = 0;

  const files: Array<{ path: string; size: number; mtimeMs: number }> = [];
  for (const path of walk.files) {
    signal?.throwIfAborted();
    const info = await stat(path).catch(() => null);
    if (!info || !info.isFile()) {
      readErrors += 1;
      continue;
    }
    files.push({ path, size: info.size, mtimeMs: info.mtimeMs });
  }
  // Newest first: when a pass runs out of budget, recent days are complete.
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const present = new Set(files.map((file) => file.path));
  for (const cachedPath of [...claudeFileCache.keys()]) {
    if (!present.has(cachedPath)) claudeFileCache.delete(cachedPath);
  }

  let tracked = 0;
  for (const file of files) {
    signal?.throwIfAborted();
    const cached = claudeFileCache.get(file.path);
    if (cached && cached.size === file.size && cached.mtimeMs === file.mtimeMs) {
      tracked += cached.records.size;
      continue;
    }
    if (Date.now() > deadline || bytesThisPass >= CLAUDE_BYTES_PER_PASS ||
        tracked >= MAX_TRACKED_RECORDS_PER_SOURCE) {
      pendingFiles += 1;
      pendingNewestMtimeMs = Math.max(pendingNewestMtimeMs, file.mtimeMs);
      if (cached) tracked += cached.records.size;
      continue;
    }
    // Resume an appended file; read a shrunk or rewritten one from the start.
    const resume = cached && cached.endOffset <= file.size ? cached : null;
    const entry: ClaudeFileCache = resume ?? {
      size: 0, mtimeMs: 0, endOffset: 0, records: new Map(), owners: new Map(), skippedUsageLines: 0,
    };
    const result = await readJsonlIncrement(
      file.path,
      (record) => {
        if (record.type === "session-owner") {
          const session = internSession(record.sessionId);
          const id = record.accountUuid;
          if (session && typeof id === "string" && ACCOUNT_ID_PATTERN.test(id)) {
            const owners = entry.owners.get(session) ?? new Set<string>();
            if (owners.size < 8) owners.add(accountKey(salt, id));
            entry.owners.set(session, owners);
          }
          return;
        }
        const parsed = parseClaudeTokenRecord(record);
        if (!parsed) return;
        const key = boundedKey(parsed.id);
        const previous = entry.records.get(key);
        entry.records.set(key, {
          date: previous?.date ?? parsed.date,
          totals: previous ? maxTokenTotals(previous.totals, parsed.totals) : parsed.totals,
          session: previous?.session ?? internSession(record.sessionId),
        });
      },
      {
        startOffset: resume ? resume.endOffset : 0,
        shouldStop: () => signal?.aborted === true || Date.now() > deadline,
        onOversizedLine: (head) => {
          if (ASSISTANT_RECORD_HEAD.test(head)) entry.skippedUsageLines += 1;
        },
      },
    );
    signal?.throwIfAborted();
    bytesThisPass += result.bytesRead;
    entry.endOffset = result.endOffset;
    if (result.ok) {
      entry.size = file.size;
      entry.mtimeMs = file.mtimeMs;
    } else {
      // Keep the progress; size 0 makes the next pass resume this file.
      entry.size = 0;
      entry.mtimeMs = 0;
      if (Date.now() > deadline) {
        pendingFiles += 1;
        pendingNewestMtimeMs = Math.max(pendingNewestMtimeMs, file.mtimeMs);
      } else {
        readErrors += 1;
      }
    }
    claudeFileCache.set(file.path, entry);
    tracked += entry.records.size;
  }
  if (pendingFiles > 0) truncated = true;
  lastClaudePendingFiles = pendingFiles;

  const best = new Map<string, ClaudeRecord>();
  const owners = new Map<string, Set<string>>();
  let skippedUsageLines = 0;
  for (const entry of claudeFileCache.values()) {
    skippedUsageLines += entry.skippedUsageLines;
    for (const [session, keys] of entry.owners) {
      const all = owners.get(session) ?? new Set<string>();
      for (const key of keys) all.add(key);
      owners.set(session, all);
    }
    for (const [key, value] of entry.records) {
      const previous = best.get(key);
      if (!previous && best.size >= MAX_TRACKED_RECORDS_PER_SOURCE) {
        truncated = true;
        continue;
      }
      best.set(key, previous
        ? {
            date: previous.date ?? value.date,
            totals: maxTokenTotals(previous.totals, value.totals),
            session: previous.session ?? value.session,
          }
        : value);
    }
  }

  const daily = new Map<string, MutableDailyBucket>();
  let totals = emptyTokenTotals();
  // Attribution: a session with exactly one account id; nothing else.
  const byAccount = new Map<string, { totals: TokenTotals; sessions: Set<string> }>();
  const unattributed = {
    no_account_record: { totals: emptyTokenTotals(), sessions: new Set<string>() },
    several_accounts: { totals: emptyTokenTotals(), sessions: new Set<string>() },
  };
  for (const item of best.values()) {
    totals = addTokenTotals(totals, item.totals);
    if (!addDaily(daily, "claude", item.date, item.totals)) truncated = true;
    const sessionOwners = item.session ? owners.get(item.session) : undefined;
    const bucket = !sessionOwners || sessionOwners.size === 0
      ? unattributed.no_account_record
      : sessionOwners.size > 1
        ? unattributed.several_accounts
        : (() => {
            const key = [...sessionOwners][0] as string;
            const existing = byAccount.get(key) ?? { totals: emptyTokenTotals(), sessions: new Set<string>() };
            byAccount.set(key, existing);
            return existing;
          })();
    bucket.totals = addTokenTotals(bucket.totals, item.totals);
    if (item.session) bucket.sessions.add(item.session);
  }
  signal?.throwIfAborted();
  const current = byAccount.size > 0 ? await currentClaudeAccountKey(salt) : null;
  signal?.throwIfAborted();
  const accounts: TokenAccountTotals[] = [...byAccount.entries()]
    .sort((a, b) => b[1].totals.totalTokens - a[1].totals.totalTokens)
    .slice(0, 12)
    .map(([account, value]) => ({
      source: "claude-code" as const,
      account,
      attribution: "attributed" as const,
      current: account === current,
      sessions: value.sessions.size,
      totals: value.totals,
    }));
  for (const reason of ["no_account_record", "several_accounts"] as const) {
    const value = unattributed[reason];
    if (value.totals.totalTokens === 0) continue;
    accounts.push({
      source: "claude-code",
      account: null,
      attribution: reason,
      current: false,
      sessions: value.sessions.size,
      totals: value.totals,
    });
  }

  return {
    provider: "claude",
    source: "claude-code",
    files: [...claudeFileCache.values()].filter((entry) => entry.size > 0).length,
    readErrors,
    truncated,
    pendingFiles,
    pendingNewestMtimeMs,
    skippedUsageLines,
    totals,
    daily,
    accounts,
  };
}

async function scanCodex(signal?: AbortSignal): Promise<ScanResult> {
  signal?.throwIfAborted();
  // The deadline starts before the walk, which is part of the scan's cost.
  const deadline = Date.now() + MAX_SCAN_DURATION_MS;
  const codexHome = join(homedir(), ".codex");
  const active = await findJsonlFiles(join(codexHome, "sessions"), deadline, signal);
  const archived = await findJsonlFiles(
    join(codexHome, "archived_sessions"),
    deadline, signal,
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
    signal?.aborted === true || Date.now() > deadline || seen.size >= MAX_TRACKED_RECORDS_PER_SOURCE;

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
  const skipped = result.skippedUsageLines ?? 0;
  if (missing) {
    message = `No ${label} session logs found.`;
  } else if ((result.pendingFiles ?? 0) > 0) {
    // A pending file holds nothing newer than its modification time, so
    // activity after the newest pending file is complete.
    const since = localDateKey(new Date(result.pendingNewestMtimeMs ?? 0).toISOString());
    message = `${label}: ${result.pendingFiles} older session file(s) are still being read in the background; ` +
      `totals are complete only for activity after ${since ?? "an earlier pass"}.`;
  } else if (result.truncated) {
    message = `${label} scan stopped at its time or record budget; totals are partial.`;
  } else if (result.readErrors > 0) {
    message = `${result.readErrors} session file(s) could not be read.`;
  } else if (skipped > 0) {
    message = `${skipped} very large ${label} record(s) were skipped; totals may be slightly low.`;
  }

  return {
    source: result.source,
    provider: result.provider,
    state: missing
      ? "not_found"
      : result.readErrors > 0 || result.truncated || skipped > 0
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
  signal?: AbortSignal,
): Promise<TokenAnalyticsSnapshot> {
  signal?.throwIfAborted();
  // Wait for both readers to settle before invalidation can clear their caches.
  const results = await Promise.allSettled([
    consent.claudeCode ? scanClaudeCode(signal) : null,
    consent.codex ? scanCodex(signal) : null,
  ]);
  signal?.throwIfAborted();
  const [claudeScan, codexScan] = results.map(result => {
    if (result.status === "rejected") throw result.reason;
    return result.value;
  });

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
    accounts: claudeScan?.accounts ?? [],
  };
}
