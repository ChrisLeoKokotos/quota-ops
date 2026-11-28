/**
 * Opt-in local usage ledger: "observed lifetime" token totals.
 *
 * Why: tools delete old session files (Claude Code cleans up its own
 * transcripts), so a total computed from the files on disk goes DOWN when
 * that happens. The ledger keeps one numeric row per usage record QuotaOps
 * has observed, so lifetime totals survive the deletion of the source file.
 *
 * Privacy contract (see docs/token-analytics.md, "Usage ledger"):
 * - Off by default. Enabled only by the person (config `tokenLedger: true`),
 *   and only for sources that have token-analytics consent.
 * - Each row holds numbers, a day, a provider model id, a salted hash of the
 *   record id and of the session id, and the salted account key (or an
 *   unattributed marker). Never prompts, responses, paths, emails or ids.
 * - Turning the ledger off deletes the file. Withdrawing a source's consent
 *   purges that source's rows. Nothing leaves this PC.
 *
 * Integrity: append-only JSON lines, each with a checksum; a torn or edited
 * line is ignored and counted as corrupt. Re-ingesting the same record is
 * idempotent (largest value per field wins, as in the scanner). The file is
 * rewritten atomically (temp file + rename) when it grows past twice its
 * live rows, and when rows are purged.
 */
import { createHash } from "node:crypto";
import { appendFile, readFile, rename, rm, writeFile } from "node:fs/promises";

import type { Provider } from "../lib/quota.ts";
import {
  addTokenTotals,
  emptyTokenTotals,
  type DailyTokenBucket,
  type ProviderTokenTotals,
  type TokenAccountTotals,
  type TokenAnalyticsSnapshot,
  type TokenModelTotals,
  type TokenSourceId,
  type TokenTotals,
} from "../lib/token-analytics.ts";
import type { TokenUsageEvent } from "./token-analytics.ts";

export const LEDGER_SCHEMA = 1;
const MAX_LEDGER_ROWS = 2_000_000;
const MAX_DAILY_BUCKETS = 800;
const MAX_MODELS = 12;
const ROW_KEY = /^[0-9a-f]{24}$/;
const SHORT_KEY = /^[0-9a-f]{12}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MODEL = /^[A-Za-z0-9._:@/-]{1,64}$/;
const SOURCES: readonly TokenSourceId[] = ["claude-code", "codex", "google-antigravity"];
const PROVIDERS: readonly Provider[] = ["claude", "openai", "google"];

/** One stored row. Field names are short: the file holds many of them. */
interface Row {
  f: string;            // salted hash of source + record id
  s: TokenSourceId;
  p: Provider;
  t: "a" | "n" | "s";   // attributed / no account record / several accounts
  a: string | null;     // salted account key when attributed
  x: string | null;     // salted session key
  m: string;
  d: string | null;
  i: number; o: number; cr: number; cw: number; r: number | null;
}

function checksum(body: string): string {
  return createHash("sha256").update(body).digest("hex").slice(0, 12);
}

function safe(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function isRow(value: unknown): value is Row {
  if (!value || typeof value !== "object") return false;
  const row = value as Partial<Row>;
  return typeof row.f === "string" && ROW_KEY.test(row.f) &&
    SOURCES.includes(row.s as TokenSourceId) && PROVIDERS.includes(row.p as Provider) &&
    (row.t === "a" || row.t === "n" || row.t === "s") &&
    (row.t === "a" ? typeof row.a === "string" && SHORT_KEY.test(row.a) : row.a === null) &&
    (row.x === null || (typeof row.x === "string" && SHORT_KEY.test(row.x))) &&
    typeof row.m === "string" && MODEL.test(row.m) &&
    (row.d === null || (typeof row.d === "string" && DAY.test(row.d))) &&
    safe(row.i) !== null && safe(row.o) !== null && safe(row.cr) !== null && safe(row.cw) !== null &&
    (row.r === null || safe(row.r) !== null);
}

function rowTotals(row: Row): TokenTotals {
  // Same per-source semantics as the scanner: Codex cache is part of input.
  const total = row.s === "codex" ? row.i + row.o : row.i + row.o + row.cr + row.cw;
  const totals: TokenTotals = {
    inputTokens: row.i, outputTokens: row.o, cacheReadTokens: row.cr,
    cacheWriteTokens: row.cw, totalTokens: total,
  };
  if (row.r !== null) totals.reasoningTokens = row.r;
  return totals;
}

function serialize(row: Row): string {
  const body = JSON.stringify(row);
  return JSON.stringify({ ...row, c: checksum(body) });
}

export interface LedgerView {
  totals: TokenTotals;
  providers: ProviderTokenTotals[];
  daily: DailyTokenBucket[];
  models: TokenModelTotals[];
  accounts: TokenAccountTotals[];
  records: number;
  corrupt: number;
  since: string | null;
}

export class TokenLedger {
  private rows = new Map<string, Row>();
  private loaded = false;
  private lines = 0;
  private corrupt = 0;
  private since: string | null = null;
  private full = false;

  private readonly path: string;
  private readonly salt: Buffer;
  private readonly now: () => Date;

  // Plain fields (no parameter properties): the collector runs with
  // Node's strip-only TypeScript support.
  constructor(path: string, salt: Buffer, now: () => Date = () => new Date()) {
    this.path = path;
    this.salt = salt;
    this.now = now;
  }

  private key(prefix: string, value: string): string {
    return createHash("sha256").update(this.salt).update(prefix).update("\u0000").update(value).digest("hex");
  }

  /** True when the row limit stopped ingestion (reported as partial). */
  get limitReached(): boolean {
    return this.full;
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    this.rows.clear();
    this.lines = 0;
    this.corrupt = 0;
    this.since = null;
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.loaded = true;
      return;
    }
    const lines = text.split("\n");
    for (const [index, raw] of lines.entries()) {
      const line = raw.trim();
      if (!line) continue;
      this.lines += 1;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        this.corrupt += 1;
        continue;
      }
      if (index === 0 && parsed && typeof parsed === "object" && "quotaopsTokenLedger" in parsed) {
        const header = parsed as { quotaopsTokenLedger: unknown; since?: unknown };
        if (header.quotaopsTokenLedger !== LEDGER_SCHEMA) {
          throw new Error("Unsupported token ledger schema.");
        }
        this.since = typeof header.since === "string" ? header.since.slice(0, 64) : null;
        continue;
      }
      const { c, ...body } = (parsed ?? {}) as Record<string, unknown>;
      if (typeof c !== "string" || c !== checksum(JSON.stringify(body)) || !isRow(body)) {
        this.corrupt += 1;
        continue;
      }
      const previous = this.rows.get(body.f);
      this.rows.set(body.f, previous ? mergeRow(previous, body) : body);
    }
    this.loaded = true;
  }

  /**
   * Record new or grown usage. Returns the number of rows written. Only
   * events whose source is in `allowed` are taken.
   */
  async ingest(events: TokenUsageEvent[], allowed: ReadonlySet<TokenSourceId>): Promise<number> {
    await this.load();
    const out: string[] = [];
    const newFile = this.lines === 0;
    const headerless = !newFile && this.since === null;
    if (this.since === null) this.since = this.now().toISOString();
    for (const event of events) {
      if (!allowed.has(event.source)) continue;
      const f = this.key(event.source, event.key).slice(0, 24);
      const candidate: Row = {
        f,
        s: event.source,
        p: event.provider,
        t: event.attribution === "attributed" ? "a" : event.attribution === "several_accounts" ? "s" : "n",
        a: event.attribution === "attributed" && event.account && SHORT_KEY.test(event.account) ? event.account : null,
        x: event.session ? this.key("session", event.session).slice(0, 12) : null,
        m: MODEL.test(event.model) ? event.model : "unknown",
        d: event.date && DAY.test(event.date) ? event.date : null,
        i: event.totals.inputTokens,
        o: event.totals.outputTokens,
        cr: event.totals.cacheReadTokens,
        cw: event.totals.cacheWriteTokens,
        r: event.totals.reasoningTokens ?? null,
      };
      if (candidate.t === "a" && candidate.a === null) candidate.t = "n";
      if (!isRow(candidate)) continue;
      const previous = this.rows.get(f);
      if (!previous && this.rows.size >= MAX_LEDGER_ROWS) {
        this.full = true;
        continue;
      }
      const next = previous ? mergeRow(previous, candidate) : candidate;
      if (previous && sameRow(previous, next)) continue;
      this.rows.set(f, next);
      out.push(serialize(next));
    }
    if (out.length === 0) return 0;
    if (headerless) {
      // A file without a header (edited or foreign): rewrite it cleanly.
      await this.rewrite();
      return out.length;
    }
    const header = newFile
      ? JSON.stringify({ quotaopsTokenLedger: LEDGER_SCHEMA, since: this.since }) + "\n"
      : "";
    await appendFile(this.path, header + out.join("\n") + "\n", { encoding: "utf8", mode: 0o600 });
    this.lines += out.length + (newFile ? 1 : 0);
    if (this.lines > 2 * this.rows.size + 1_000) await this.rewrite();
    return out.length;
  }

  /** Drop every row of a source that no longer has consent. */
  async purge(allowed: ReadonlySet<TokenSourceId>): Promise<number> {
    await this.load();
    let removed = 0;
    for (const [key, row] of this.rows) {
      if (!allowed.has(row.s)) {
        this.rows.delete(key);
        removed += 1;
      }
    }
    if (removed > 0) {
      if (this.rows.size === 0) await this.destroy();
      else await this.rewrite();
    }
    return removed;
  }

  /** Delete the ledger file (turning the ledger off, or an explicit reset). */
  async destroy(): Promise<void> {
    await rm(this.path, { force: true });
    this.rows.clear();
    this.lines = 0;
    this.corrupt = 0;
    this.since = null;
    this.loaded = true;
  }

  private async rewrite(): Promise<void> {
    const temp = `${this.path}.tmp`;
    const body = [
      JSON.stringify({ quotaopsTokenLedger: LEDGER_SCHEMA, since: this.since ?? this.now().toISOString() }),
      ...[...this.rows.values()].map(serialize),
    ].join("\n") + "\n";
    try {
      await writeFile(temp, body, { encoding: "utf8", mode: 0o600 });
      await rename(temp, this.path);
    } catch (error) {
      await rm(temp, { force: true }).catch(() => undefined);
      throw error;
    }
    this.lines = this.rows.size + 1;
    this.corrupt = 0;
  }

  /** Lifetime totals for the allowed sources. `currentAccount` marks the signed-in account. */
  view(allowed: ReadonlySet<TokenSourceId>, currentAccount: string | null = null): LedgerView {
    let totals = emptyTokenTotals();
    const providers = new Map<Provider, TokenTotals>();
    const daily = new Map<string, DailyTokenBucket>();
    const models = new Map<string, TokenModelTotals>();
    const accounts = new Map<string, { row: TokenAccountTotals; sessions: Set<string> }>();
    let records = 0;
    for (const row of this.rows.values()) {
      if (!allowed.has(row.s)) continue;
      records += 1;
      const value = rowTotals(row);
      totals = addTokenTotals(totals, value);
      providers.set(row.p, addTokenTotals(providers.get(row.p) ?? emptyTokenTotals(), value));
      if (row.d) {
        const key = `${row.d}|${row.p}`;
        const existing = daily.get(key);
        daily.set(key, { date: row.d, provider: row.p, ...addTokenTotals(existing ?? emptyTokenTotals(), value) });
      }
      const modelKey = `${row.p}:${row.m}`;
      const model = models.get(modelKey);
      models.set(modelKey, { provider: row.p, model: row.m, totals: addTokenTotals(model?.totals ?? emptyTokenTotals(), value) });
      if (row.s === "claude-code") {
        const attribution = row.t === "a" ? "attributed" : row.t === "s" ? "several_accounts" : "no_account_record";
        const accountKey = row.a ?? `~${attribution}`;
        const entry = accounts.get(accountKey) ?? {
          row: {
            source: "claude-code", account: row.a, attribution,
            current: row.a !== null && row.a === currentAccount, sessions: 0, totals: emptyTokenTotals(),
          } as TokenAccountTotals,
          sessions: new Set<string>(),
        };
        entry.row = { ...entry.row, totals: addTokenTotals(entry.row.totals, value) };
        if (row.x) entry.sessions.add(row.x);
        accounts.set(accountKey, entry);
      }
    }
    const accountRows = [...accounts.values()].map(({ row, sessions }) => ({ ...row, sessions: sessions.size }));
    const attributed = accountRows.filter((row) => row.account !== null)
      .sort((a, b) => b.totals.totalTokens - a.totals.totalTokens).slice(0, 12);
    const unattributed = accountRows.filter((row) => row.account === null);
    const sortedDaily = [...daily.values()].sort((a, b) => a.date.localeCompare(b.date) || a.provider.localeCompare(b.provider));
    return {
      totals,
      providers: [...providers.entries()].map(([provider, value]) => ({ provider, totals: value }))
        .sort((a, b) => b.totals.totalTokens - a.totals.totalTokens),
      daily: sortedDaily.slice(Math.max(0, sortedDaily.length - MAX_DAILY_BUCKETS)),
      models: [...models.values()].sort((a, b) => b.totals.totalTokens - a.totals.totalTokens).slice(0, MAX_MODELS),
      accounts: [...attributed, ...unattributed],
      records,
      corrupt: this.corrupt,
      since: this.since,
    };
  }
}

function mergeRow(a: Row, b: Row): Row {
  return {
    ...a,
    // Attribution and model can only become more specific, never guessed.
    t: a.t === "a" || b.t !== "a" ? a.t : b.t,
    a: a.t === "a" ? a.a : b.t === "a" ? b.a : null,
    x: a.x ?? b.x,
    m: a.m !== "unknown" ? a.m : b.m,
    d: a.d ?? b.d,
    i: Math.max(a.i, b.i),
    o: Math.max(a.o, b.o),
    cr: Math.max(a.cr, b.cr),
    cw: Math.max(a.cw, b.cw),
    r: a.r === null && b.r === null ? null : Math.max(a.r ?? 0, b.r ?? 0),
  };
}

function sameRow(a: Row, b: Row): boolean {
  return a.t === b.t && a.a === b.a && a.x === b.x && a.m === b.m && a.d === b.d &&
    a.i === b.i && a.o === b.o && a.cr === b.cr && a.cw === b.cw && a.r === b.r;
}

/**
 * Replace a retained-history snapshot's totals with the ledger's lifetime
 * view (Claude Code and Codex only; Google is merged afterwards and is
 * already lifetime by nature). The retained totals stay available.
 */
export function applyLedgerView(snapshot: TokenAnalyticsSnapshot, view: LedgerView): TokenAnalyticsSnapshot {
  return {
    ...snapshot,
    totals: view.totals,
    providers: view.providers,
    daily: view.daily,
    models: view.models,
    accounts: view.accounts,
    basis: "observed_lifetime",
    retainedTotals: snapshot.totals,
    ledger: { since: view.since, records: view.records, corrupt: view.corrupt },
  };
}
