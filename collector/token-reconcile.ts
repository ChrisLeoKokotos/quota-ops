/**
 * Token analytics reconciliation (issue #57): an INDEPENDENT reference
 * calculation from the raw local histories, compared with
 *   1. the production scanner (collector/token-analytics.ts),
 *   2. the running collector's /snapshot (if reachable),
 *   3. the Electron IPC projection of that snapshot (desktop/electron-ipc/security.js),
 *   4. the label the dashboard would display (formatTokenCount).
 *
 * The reference deliberately shares no parsing, caching or de-duplication
 * code with the scanner: it streams every file with readline and applies the
 * documented accounting contract directly. It reads only with the stored
 * token-analytics consent. Output is counts, match/mismatch and relative
 * differences; absolute totals are printed only with --show-values, for the
 * person on this PC. Nothing is written or sent anywhere.
 */
import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

import { formatTokenCount, type TokenAnalyticsSnapshot, type TokenTotals } from "../lib/token-analytics.ts";
import { collectLocalTokenAnalytics, resetTokenScanCache, tokenScanPending } from "./token-analytics.ts";

export interface ReferenceTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  total: number;
}

export interface ReferenceResult {
  files: number;
  records: number;
  duplicates: number;
  malformed: number;
  oversized: number;
  iterationMismatches: number;
  totals: ReferenceTotals;
}

const MAX_LINE = 16 * 1024 * 1024;

async function* jsonlFiles(dir: string): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* jsonlFiles(path);
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) yield path;
  }
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

async function eachRecord(
  path: string,
  onRecord: (record: Record<string, unknown>) => void,
  stats: { malformed: number; oversized: number },
): Promise<void> {
  const lines = createInterface({ input: createReadStream(path, { highWaterMark: 1 << 20 }), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    if (line.length > MAX_LINE) {
      stats.oversized += 1;
      continue;
    }
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      stats.malformed += 1;
      continue;
    }
    if (value && typeof value === "object" && !Array.isArray(value)) onRecord(value as Record<string, unknown>);
  }
}

/** Claude Code: one record per message id, largest value per field (top-level usage). */
export async function referenceClaudeCode(home = homedir()): Promise<ReferenceResult> {
  const byId = new Map<string, ReferenceTotals>();
  const stats = { malformed: 0, oversized: 0 };
  let files = 0;
  let duplicates = 0;
  let iterationMismatches = 0;
  for await (const path of jsonlFiles(join(home, ".claude", "projects"))) {
    files += 1;
    await eachRecord(path, (record) => {
      if (record.type !== "assistant") return;
      const message = record.message as Record<string, unknown> | undefined;
      if (!message || typeof message !== "object" || message.model === "<synthetic>") return;
      const usage = message.usage as Record<string, unknown> | undefined;
      if (!usage || typeof usage !== "object") return;
      const id = typeof message.id === "string" && message.id ? message.id
        : typeof record.uuid === "string" && record.uuid ? record.uuid : null;
      if (!id) return;
      const details = usage.output_tokens_details as Record<string, unknown> | undefined;
      const value: ReferenceTotals = {
        input: count(usage.input_tokens),
        output: count(usage.output_tokens),
        cacheRead: count(usage.cache_read_input_tokens),
        cacheWrite: count(usage.cache_creation_input_tokens),
        reasoning: Math.min(count(details?.thinking_tokens ?? details?.reasoning_tokens), count(usage.output_tokens)),
        total: 0,
      };
      if (Array.isArray(usage.iterations) && usage.iterations.length > 0) {
        const sum = usage.iterations.reduce((acc: number[], item: unknown) => {
          const it = (item ?? {}) as Record<string, unknown>;
          return [acc[0]! + count(it.input_tokens), acc[1]! + count(it.output_tokens),
            acc[2]! + count(it.cache_read_input_tokens), acc[3]! + count(it.cache_creation_input_tokens)];
        }, [0, 0, 0, 0]);
        if (sum[0] !== value.input || sum[1] !== value.output || sum[2] !== value.cacheRead || sum[3] !== value.cacheWrite) {
          iterationMismatches += 1;
        }
      }
      if (value.input + value.output + value.cacheRead + value.cacheWrite === 0) return;
      const previous = byId.get(id);
      if (previous) duplicates += 1;
      byId.set(id, previous ? {
        input: Math.max(previous.input, value.input),
        output: Math.max(previous.output, value.output),
        cacheRead: Math.max(previous.cacheRead, value.cacheRead),
        cacheWrite: Math.max(previous.cacheWrite, value.cacheWrite),
        reasoning: Math.max(previous.reasoning, value.reasoning),
        total: 0,
      } : value);
    }, stats);
  }
  const totals: ReferenceTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0 };
  for (const value of byId.values()) {
    totals.input += value.input;
    totals.output += value.output;
    totals.cacheRead += value.cacheRead;
    totals.cacheWrite += value.cacheWrite;
    totals.reasoning += value.reasoning;
  }
  totals.total = totals.input + totals.output + totals.cacheRead + totals.cacheWrite;
  return { files, records: byId.size, duplicates, iterationMismatches, totals, ...stats };
}

/**
 * Codex: per rollout, final cumulative usage minus the cumulative usage
 * inherited from a parent before the child's own first turn. Cached input is
 * part of input, so total = input + output.
 */
export async function referenceCodex(home = homedir()): Promise<ReferenceResult> {
  const stats = { malformed: 0, oversized: 0 };
  const totals: ReferenceTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0 };
  let files = 0;
  let records = 0;
  const sessions = new Set<string>();
  let duplicates = 0;
  for (const dir of ["sessions", "archived_sessions"]) {
    for await (const path of jsonlFiles(join(home, ".codex", dir))) {
      files += 1;
      let session = "";
      let child = false;
      let createdAt: number | null = null;
      let ownTurns = false;
      let inherited: number[] | null = null;
      let last: number[] | null = null;
      await eachRecord(path, (record) => {
        const payload = record.payload as Record<string, unknown> | undefined;
        if (!payload || typeof payload !== "object") return;
        if (record.type === "session_meta" && !session) {
          session = String(payload.id ?? payload.session_id ?? path);
          const source = payload.source as Record<string, unknown> | undefined;
          child = Boolean(payload.forked_from_id || payload.parent_thread_id || payload.thread_source === "subagent" || source?.subagent);
          const parsed = Date.parse(String(record.timestamp ?? ""));
          createdAt = Number.isFinite(parsed) ? parsed / 1000 : null;
          return;
        }
        if (record.type !== "event_msg") return;
        if (payload.type === "task_started" && child && !ownTurns) {
          const started = typeof payload.started_at === "number" ? payload.started_at : null;
          if (started !== null && createdAt !== null && started >= Math.floor(createdAt)) ownTurns = true;
          return;
        }
        if (payload.type !== "token_count") return;
        const info = payload.info as Record<string, unknown> | undefined;
        const usage = info?.total_token_usage as Record<string, unknown> | undefined;
        if (!usage) return;
        const current = [count(usage.input_tokens), count(usage.output_tokens), count(usage.cached_input_tokens),
          count(usage.reasoning_output_tokens)];
        if (child && !ownTurns) inherited = current;
        else records += 1;
        last = current;
      }, stats);
      if (session && sessions.has(session)) {
        duplicates += 1;
        continue;
      }
      if (session) sessions.add(session);
      if (!last) continue;
      const base: number[] = inherited ?? [0, 0, 0, 0];
      const end: number[] = last;
      const input = Math.max(0, end[0]! - base[0]!);
      const output = Math.max(0, end[1]! - base[1]!);
      totals.input += input;
      totals.output += output;
      totals.cacheRead += Math.min(input, Math.max(0, end[2]! - base[2]!));
      totals.reasoning += Math.min(output, Math.max(0, end[3]! - base[3]!));
    }
  }
  totals.total = totals.input + totals.output;
  return { files, records, duplicates, iterationMismatches: 0, totals, ...stats };
}

/** Production scanner, passes repeated until no file is pending (bounded). */
export async function productionSnapshot(consent: { claudeCode: boolean; codex: boolean }): Promise<{ snapshot: TokenAnalyticsSnapshot; passes: number }> {
  resetTokenScanCache();
  let snapshot = await collectLocalTokenAnalytics(consent);
  let passes = 1;
  while (tokenScanPending() && passes < 50) {
    snapshot = await collectLocalTokenAnalytics(consent);
    passes += 1;
  }
  return { snapshot, passes };
}

export interface ReconcileRow {
  metric: string;
  reference: number | null;
  production: number | null;
  collector: number | null;
  ipc: number | null;
  status: "match" | "differs" | "n/a";
  relativeDifference: number | null;
}

function rowFor(metric: string, values: Array<number | null>): ReconcileRow {
  const [reference, production, collector, ipc] = values as [number | null, number | null, number | null, number | null];
  const present = values.filter((value): value is number => value !== null);
  const status = present.length < 2 ? "n/a" : present.every((value) => value === present[0]) ? "match" : "differs";
  const base = reference ?? production;
  const worst = present.reduce((max, value) => Math.max(max, Math.abs(value - (base ?? value))), 0);
  return {
    metric, reference, production, collector, ipc, status,
    relativeDifference: base ? worst / base : present.length > 0 && worst === 0 ? 0 : null,
  };
}

function pick(totals: TokenTotals | undefined, metric: keyof ReferenceTotals): number | null {
  if (!totals) return null;
  switch (metric) {
    case "input": return totals.inputTokens;
    case "output": return totals.outputTokens;
    case "cacheRead": return totals.cacheReadTokens;
    case "cacheWrite": return totals.cacheWriteTokens;
    case "reasoning": return totals.reasoningTokens ?? 0;
    default: return totals.totalTokens;
  }
}

export interface ReconcileReport {
  sources: Record<string, ReferenceResult | null>;
  productionPasses: number;
  collectorReachable: boolean;
  collectorBasis: string | null;
  rows: ReconcileRow[];
  dashboardLabelMatches: boolean | null;
  coverage: TokenAnalyticsSnapshot["sources"];
}

/**
 * `collectorSnapshot` is the parsed /snapshot body (or null when the
 * collector is not running). Comparisons for the collector use its retained
 * totals when it publishes observed-lifetime (ledger) totals, because the
 * reference can only see files that still exist.
 */
export async function reconcile(
  consent: { claudeCode: boolean; codex: boolean },
  collectorSnapshot: { tokens?: unknown } | null,
  home = homedir(),
): Promise<ReconcileReport> {
  const [claude, codex] = await Promise.all([
    consent.claudeCode ? referenceClaudeCode(home) : Promise.resolve(null),
    consent.codex ? referenceCodex(home) : Promise.resolve(null),
  ]);
  const { snapshot, passes } = await productionSnapshot(consent);
  const reference: ReferenceTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0 };
  for (const result of [claude, codex]) {
    if (!result) continue;
    for (const key of Object.keys(reference) as Array<keyof ReferenceTotals>) reference[key] += result.totals[key];
  }
  const collectorTokens = (collectorSnapshot?.tokens ?? null) as TokenAnalyticsSnapshot | null;
  const collectorLocal = collectorTokens
    ? (collectorTokens.basis === "observed_lifetime" ? collectorTokens.retainedTotals : collectorTokens.totals)
    : undefined;
  let ipcTotals: TokenTotals | undefined;
  if (collectorSnapshot && collectorTokens) {
    const require = createRequire(import.meta.url);
    const security = require("../desktop/electron-ipc/security.js") as {
      projectSnapshot: (value: unknown) => { tokens: TokenAnalyticsSnapshot | null };
    };
    const projected = security.projectSnapshot({ version: 1, generatedAt: "", accounts: [], ...collectorSnapshot }).tokens;
    ipcTotals = projected
      ? (projected.basis === "observed_lifetime" ? projected.retainedTotals : projected.totals)
      : undefined;
  }
  const metrics: Array<keyof ReferenceTotals> = ["output", "input", "cacheRead", "cacheWrite", "reasoning", "total"];
  // Google/Antigravity counters are event observations, not files: excluded
  // from the comparison (the collector adds them on top).
  const googleOnly = collectorTokens?.providers.find((item) => item.provider === "google")?.totals;
  const minusGoogle = (value: number | null, metric: keyof ReferenceTotals) =>
    value === null || !googleOnly ? value : value - (pick(googleOnly, metric) ?? 0);
  const rows = metrics.map((metric) => rowFor(metric, [
    reference[metric],
    pick(snapshot.totals, metric),
    minusGoogle(pick(collectorLocal, metric), metric),
    minusGoogle(pick(ipcTotals, metric), metric),
  ]));
  return {
    sources: { "claude-code": claude, codex },
    productionPasses: passes,
    collectorReachable: collectorSnapshot !== null,
    collectorBasis: collectorTokens?.basis ?? (collectorTokens ? "retained_history" : null),
    rows,
    dashboardLabelMatches: collectorTokens && ipcTotals
      ? formatTokenCount(collectorTokens.totals.totalTokens) === formatTokenCount(
          (collectorTokens.basis === "observed_lifetime" ? collectorTokens.totals : ipcTotals).totalTokens)
      : null,
    coverage: snapshot.sources,
  };
}

/** Human-readable report; absolute numbers only with showValues. */
export function formatReconcileReport(report: ReconcileReport, showValues: boolean): string {
  const lines: string[] = [];
  lines.push("QuotaOps token analytics reconciliation (local only, nothing sent)");
  for (const [source, result] of Object.entries(report.sources)) {
    if (!result) {
      lines.push(`  ${source}: not consented, not read`);
      continue;
    }
    lines.push(`  ${source}: ${result.files} files, ${result.records} records, ${result.duplicates} repeated reports, ` +
      `${result.malformed} malformed lines, ${result.oversized} oversized lines` +
      (result.iterationMismatches ? `, ${result.iterationMismatches} records whose iterations differ from top-level usage` : ""));
  }
  lines.push(`  production passes until complete: ${report.productionPasses}`);
  lines.push(`  running collector: ${report.collectorReachable ? `reachable (${report.collectorBasis ?? "token analytics off"})` : "not reachable"}`);
  lines.push("");
  lines.push("  metric       reference  production  collector  ipc        result");
  for (const row of report.rows) {
    const cell = (value: number | null) => value === null ? "-" : showValues ? String(value) : "•";
    const diff = row.relativeDifference === null ? "" : row.status === "differs" ? ` (max ${(row.relativeDifference * 100).toFixed(3)}%)` : "";
    lines.push(`  ${row.metric.padEnd(12)} ${cell(row.reference).padEnd(10)} ${cell(row.production).padEnd(11)} ${cell(row.collector).padEnd(10)} ${cell(row.ipc).padEnd(10)} ${row.status}${diff}`);
  }
  if (report.dashboardLabelMatches !== null) {
    lines.push(`  dashboard label equals the IPC value: ${report.dashboardLabelMatches ? "yes" : "NO"}`);
  }
  for (const source of report.coverage) {
    const c = source.coverage;
    if (!c) continue;
    lines.push(`  coverage ${source.source}: discovered ${c.filesDiscovered}, read ${c.filesRead}, pending ${c.filesPending}, ` +
      `removed since start ${c.filesRemoved}, records ${c.records}, duplicates ${c.duplicates}, malformed ${c.malformed}, oversized ${c.oversized}, ` +
      `state ${source.state}`);
  }
  if (!showValues) lines.push("  (values hidden; add --show-values to print them on this PC)");
  return lines.join("\n") + "\n";
}
