// Issue #57: token analytics accuracy. Deterministic fixtures with totals
// worked out by hand; no real history, account id or personal total.
import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createRequire } from "node:module";

import {
  collectLocalTokenAnalytics,
  collectLocalTokenUsage,
  createCodexTokenState,
  parseClaudeTokenRecord,
  parseCodexTokenRecord,
  resetTokenScanCache,
  tokenScanPending,
} from "../collector/token-analytics.ts";
import { applyLedgerView, TokenLedger } from "../collector/token-ledger.ts";
import { referenceClaudeCode, referenceCodex } from "../collector/token-reconcile.ts";
import { localDayKey, summarizeTokenRange, type TokenAnalyticsSnapshot } from "../lib/token-analytics.ts";

const NL = String.fromCharCode(10);
const DAY = 86_400_000;
const now = Date.now();
const iso = (msAgo: number) => new Date(now - msAgo).toISOString();
const lines = (records: unknown[]) => records.map((record) => JSON.stringify(record)).join(NL) + NL;
const require = createRequire(import.meta.url);
const security = require("../desktop/electron-ipc/security.js") as {
  projectSnapshot: (value: unknown) => { tokens: TokenAnalyticsSnapshot | null };
};

async function withHome<T>(run: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), "quotaops-accuracy-"));
  const saved = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME };
  process.env.USERPROFILE = home;
  process.env.HOME = home;
  resetTokenScanCache();
  try {
    await mkdir(join(home, ".quotaops"), { recursive: true });
    return await run(home);
  } finally {
    process.env.USERPROFILE = saved.USERPROFILE;
    process.env.HOME = saved.HOME;
    resetTokenScanCache();
    await rm(home, { recursive: true, force: true });
  }
}

const claudeMessage = (id: string, session: string, msAgo: number, usage: Record<string, unknown>, model = "claude-sonnet-test", stop: string | null = "end_turn") => ({
  type: "assistant", uuid: `u-${id}-${Math.random()}`, sessionId: session, timestamp: iso(msAgo),
  message: { id, model, stop_reason: stop, content: [{ type: "text", text: "PRIVATE" }], usage },
});

async function writeClaudeFixture(home: string): Promise<void> {
  const dir = join(home, ".claude", "projects", "p");
  await mkdir(join(dir, "s-1", "subagents"), { recursive: true });
  // m1 streamed: two partial records then the final one (stop reason). Max per field:
  // input 10, output 300 (incl. 120 thinking), cacheRead 1000, cacheWrite 50 -> 1360.
  await writeFile(join(dir, "s-1.jsonl"), lines([
    claudeMessage("m1", "s-1", 120_000, { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 1000, cache_creation_input_tokens: 50 }, "claude-sonnet-test", null),
    claudeMessage("m1", "s-1", 119_000, { input_tokens: 10, output_tokens: 150, cache_read_input_tokens: 1000, cache_creation_input_tokens: 50 }, "claude-sonnet-test", null),
    claudeMessage("m1", "s-1", 118_000, { input_tokens: 10, output_tokens: 300, cache_read_input_tokens: 1000, cache_creation_input_tokens: 50, output_tokens_details: { thinking_tokens: 120 } }),
  ]));
  // Subagent of s-1, another model: 5 + 20 + 0 + 0 = 25.
  await writeFile(join(dir, "s-1", "subagents", "agent-a.jsonl"), lines([
    claudeMessage("m2", "s-1", 60_000, { input_tokens: 5, output_tokens: 20 }, "claude-haiku-test"),
  ]));
  // An older day: 1 + 9 + 0 + 0 = 10.
  await writeFile(join(dir, "s-2.jsonl"), lines([
    claudeMessage("m3", "s-2", 3 * DAY, { input_tokens: 1, output_tokens: 9 }),
  ]) + "{not json" + NL);
}

async function writeCodexFixture(home: string, withHugeLine = false): Promise<void> {
  const dir = join(home, ".codex", "sessions", "2026", "11", "26");
  await mkdir(dir, { recursive: true });
  const token = (msAgo: number, total: Record<string, number>, last: Record<string, number>) => ({
    timestamp: iso(msAgo), type: "event_msg",
    payload: { type: "token_count", info: { total_token_usage: total, last_token_usage: last } },
  });
  // Parent: two turns. input incl. cached; reasoning is part of output.
  // Turn 1: input 100 (cached 40), output 30 (reasoning 10). Turn 2: input 50 (cached 20), output 20 (reasoning 5).
  await writeFile(join(dir, "rollout-parent.jsonl"), lines([
    { timestamp: iso(100_000), type: "session_meta", payload: { id: "parent-1" } },
    { timestamp: iso(99_000), type: "turn_context", payload: { model: "gpt-test-codex" } },
    token(98_000,
      { input_tokens: 100, cached_input_tokens: 40, output_tokens: 30, reasoning_output_tokens: 10 },
      { input_tokens: 100, cached_input_tokens: 40, output_tokens: 30, reasoning_output_tokens: 10 }),
    ...(withHugeLine ? [{ timestamp: iso(97_500), type: "response_item", payload: { type: "message", content: "x".repeat(3 * 1024 * 1024) } }] : []),
    token(97_000,
      { input_tokens: 150, cached_input_tokens: 60, output_tokens: 50, reasoning_output_tokens: 15 },
      { input_tokens: 50, cached_input_tokens: 20, output_tokens: 20, reasoning_output_tokens: 5 }),
  ]));
  // Child (fork) replays the parent's cumulative usage, then does its own turn:
  // input 10 (cached 0), output 4.
  const createdAt = now - 50_000;
  await writeFile(join(dir, "rollout-child.jsonl"), lines([
    { timestamp: new Date(createdAt).toISOString(), type: "session_meta", payload: { id: "child-1", forked_from_id: "parent-1" } },
    token(49_000,
      { input_tokens: 150, cached_input_tokens: 60, output_tokens: 50, reasoning_output_tokens: 15 },
      { input_tokens: 50, cached_input_tokens: 20, output_tokens: 20, reasoning_output_tokens: 5 }),
    { timestamp: iso(48_000), type: "event_msg", payload: { type: "task_started", started_at: Math.floor(createdAt / 1000) + 2 } },
    token(47_000,
      { input_tokens: 160, cached_input_tokens: 60, output_tokens: 54, reasoning_output_tokens: 15 },
      { input_tokens: 10, cached_input_tokens: 0, output_tokens: 4, reasoning_output_tokens: 0 }),
  ]));
}

async function fullScan(consent = { claudeCode: true, codex: true }): Promise<TokenAnalyticsSnapshot> {
  let snapshot = await collectLocalTokenAnalytics(consent);
  for (let pass = 0; tokenScanPending() && pass < 20; pass++) snapshot = await collectLocalTokenAnalytics(consent);
  return snapshot;
}

test("accounting contract: generated vs total, reasoning as a subset, Codex cache inside input", async () => {
  await withHome(async (home) => {
    await writeClaudeFixture(home);
    await writeCodexFixture(home);
    const snapshot = await fullScan();
    const claude = snapshot.providers.find((item) => item.provider === "claude")?.totals;
    const codex = snapshot.providers.find((item) => item.provider === "openai")?.totals;
    // Claude: generated 300 + 20 + 9 = 329; total 1360 + 25 + 10 = 1395; reasoning 120 (inside output).
    assert.equal(claude?.outputTokens, 329);
    assert.equal(claude?.totalTokens, 1395);
    assert.equal(claude?.reasoningTokens, 120);
    // Codex: parent 150 in / 50 out, child 10 in / 4 out -> input 160, output 54,
    // cache read 60 (part of input), reasoning 15 (part of output), total 214.
    assert.equal(codex?.inputTokens, 160);
    assert.equal(codex?.outputTokens, 54);
    assert.equal(codex?.cacheReadTokens, 60);
    assert.equal(codex?.reasoningTokens, 15);
    assert.equal(codex?.totalTokens, 214);
    assert.equal(snapshot.totals.outputTokens, 329 + 54);
    assert.equal(snapshot.totals.totalTokens, 1395 + 214);
    assert.equal(snapshot.totals.reasoningTokens, 135);
    // Models from the records themselves; the child rollout has no turn_context
    // record, so its usage is labelled "unknown" rather than guessed.
    assert.deepEqual(new Set(snapshot.models?.map((item) => item.model)),
      new Set(["claude-sonnet-test", "claude-haiku-test", "gpt-test-codex", "unknown"]));
    assert.equal(snapshot.models?.find((item) => item.model === "unknown")?.totals.totalTokens, 14);
    // Coverage: counts only.
    const coverage = snapshot.sources.find((item) => item.source === "claude-code")?.coverage;
    assert.equal(coverage?.records, 3);
    assert.equal(coverage?.duplicates, 2, "two streaming partials merged into the final record");
    assert.equal(coverage?.malformed, 1);
    assert.equal(coverage?.filesDiscovered, 3);
    assert.equal(JSON.stringify(snapshot).includes("PRIVATE"), false);
  });
});

test("independent reference equals the production scanner (full vs incremental equivalence)", async () => {
  await withHome(async (home) => {
    await writeClaudeFixture(home);
    await writeCodexFixture(home);
    const snapshot = await fullScan();
    const claudeRef = await referenceClaudeCode(home);
    const codexRef = await referenceCodex(home);
    const claude = snapshot.providers.find((item) => item.provider === "claude")?.totals;
    const codex = snapshot.providers.find((item) => item.provider === "openai")?.totals;
    assert.deepEqual(
      [claudeRef.totals.input, claudeRef.totals.output, claudeRef.totals.cacheRead, claudeRef.totals.cacheWrite, claudeRef.totals.total, claudeRef.totals.reasoning],
      [claude?.inputTokens, claude?.outputTokens, claude?.cacheReadTokens, claude?.cacheWriteTokens, claude?.totalTokens, claude?.reasoningTokens]);
    assert.deepEqual(
      [codexRef.totals.input, codexRef.totals.output, codexRef.totals.cacheRead, codexRef.totals.total, codexRef.totals.reasoning],
      [codex?.inputTokens, codex?.outputTokens, codex?.cacheReadTokens, codex?.totalTokens, codex?.reasoningTokens]);
    // Incremental: append to a session, rescan with warm caches, compare with a cold full scan.
    await appendFile(join(home, ".claude", "projects", "p", "s-2.jsonl"),
      lines([claudeMessage("m4", "s-2", 1_000, { input_tokens: 2, output_tokens: 3 })]));
    const warm = await fullScan();
    resetTokenScanCache();
    const cold = await fullScan();
    assert.deepEqual(warm.totals, cold.totals);
    assert.equal(cold.totals.outputTokens, 329 + 54 + 3);
  });
});

test("a Codex rollout with an oversized line is still counted (was: whole file rejected)", async () => {
  await withHome(async (home) => {
    await writeCodexFixture(home, true);
    const snapshot = await fullScan({ claudeCode: false, codex: true });
    const codex = snapshot.providers.find((item) => item.provider === "openai")?.totals;
    assert.equal(codex?.totalTokens, 214);
    const source = snapshot.sources.find((item) => item.source === "codex");
    assert.equal(source?.state, "ok", "a skipped non-usage line does not make the source partial");
  });
});

test("retained history goes down when a session file is deleted, and says why", async () => {
  await withHome(async (home) => {
    await writeClaudeFixture(home);
    const before = await fullScan({ claudeCode: true, codex: false });
    await unlink(join(home, ".claude", "projects", "p", "s-2.jsonl"));
    const after = await fullScan({ claudeCode: true, codex: false });
    assert.equal(before.totals.totalTokens - after.totals.totalTokens, 10);
    assert.equal(after.basis, "retained_history");
    assert.equal(after.sources.find((item) => item.source === "claude-code")?.coverage?.filesRemoved, 1);
  });
});

test("usage ledger: lifetime totals survive deletion, restarts and repeated ingestion", async () => {
  await withHome(async (home) => {
    await writeClaudeFixture(home);
    const salt = Buffer.alloc(32, 7);
    const path = join(home, ".quotaops", "token-ledger.jsonl");
    const allowed = new Set(["claude-code" as const]);
    const first = await collectLocalTokenUsage({ claudeCode: true, codex: false }, undefined, true);
    const ledger = new TokenLedger(path, salt);
    assert.equal(await ledger.ingest(first.events, allowed), 3);
    assert.equal(await ledger.ingest(first.events, allowed), 0, "idempotent: nothing new to write");
    const view = ledger.view(allowed);
    assert.equal(view.totals.totalTokens, first.snapshot.totals.totalTokens);
    assert.equal(view.totals.outputTokens, 329);

    // The source file disappears; retained history drops, the ledger does not.
    await unlink(join(home, ".claude", "projects", "p", "s-2.jsonl"));
    const second = await collectLocalTokenUsage({ claudeCode: true, codex: false }, undefined, true);
    await ledger.ingest(second.events, allowed);
    const lifetime = applyLedgerView(second.snapshot, ledger.view(allowed));
    assert.equal(lifetime.basis, "observed_lifetime");
    assert.equal(lifetime.totals.totalTokens, 1395);
    assert.equal(lifetime.retainedTotals?.totalTokens, 1385);

    // Restart: a new instance reads the same lifetime totals from disk.
    const reopened = new TokenLedger(path, salt);
    await reopened.load();
    assert.equal(reopened.view(allowed).totals.totalTokens, 1395);
    assert.equal(reopened.view(allowed).records, 3);

    // The file holds numbers and hashes only.
    const text = await readFile(path, "utf8");
    // Raw record and session ids never reach the file (only salted hashes).
    for (const raw of ['"m1"', '"m2"', '"s-1"', '"s-2"', "PRIVATE"]) {
      assert.equal(text.includes(raw), false, raw);
    }
  });
});

test("usage ledger: a grown record is updated, never added twice", async () => {
  await withHome(async (home) => {
    const salt = Buffer.alloc(32, 3);
    const path = join(home, ".quotaops", "token-ledger.jsonl");
    const ledger = new TokenLedger(path, salt);
    const allowed = new Set(["claude-code" as const]);
    const event = (output: number) => ({
      key: "msg-1", source: "claude-code" as const, provider: "claude" as const, account: null,
      attribution: "no_account_record" as const, session: "s", model: "claude-test", date: localDayKey(new Date()),
      totals: { inputTokens: 1, outputTokens: output, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 1 + output },
    });
    await ledger.ingest([event(5)], allowed);
    await ledger.ingest([event(50)], allowed);
    await ledger.ingest([event(20)], allowed); // a stale partial report never lowers it
    assert.equal(ledger.view(allowed).totals.outputTokens, 50);
    assert.equal(ledger.view(allowed).records, 1);
  });
});

test("usage ledger: damaged lines are ignored and counted; consent withdrawal purges; schema is checked", async () => {
  await withHome(async (home) => {
    const salt = Buffer.alloc(32, 9);
    const path = join(home, ".quotaops", "token-ledger.jsonl");
    const ledger = new TokenLedger(path, salt);
    const both = new Set(["claude-code" as const, "codex" as const]);
    const event = (key: string, source: "claude-code" | "codex", output: number) => ({
      key, source, provider: source === "codex" ? "openai" as const : "claude" as const, account: null,
      attribution: "no_account_record" as const, session: null, model: "m", date: "2026-11-20",
      totals: { inputTokens: 0, outputTokens: output, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: output },
    });
    await ledger.ingest([event("a", "claude-code", 10), event("b", "codex", 20)], both);
    // Tamper with one row and add a torn line.
    const text = await readFile(path, "utf8");
    const rows = text.trim().split(NL);
    rows[1] = (rows[1] ?? "").replace("\"o\":10", "\"o\":999");
    await writeFile(path, rows.join(NL) + NL + "{\"f\":\"torn", "utf8");
    const reread = new TokenLedger(path, salt);
    await reread.load();
    const view = reread.view(both);
    assert.equal(view.corrupt, 2);
    assert.equal(view.totals.outputTokens, 20, "only the intact row counts");
    // Codex consent withdrawn: its rows are purged from disk.
    await reread.purge(new Set(["claude-code" as const]));
    const after = new TokenLedger(path, salt);
    await after.load();
    assert.equal(after.view(both).records, 0);
    // Unknown schema is refused instead of misread.
    await writeFile(path, JSON.stringify({ quotaopsTokenLedger: 99 }) + NL, "utf8");
    await assert.rejects(new TokenLedger(path, salt).load(), /schema/);
  });
});

test("ranges use the local calendar day, like the collector's buckets", () => {
  const today = new Date();
  today.setHours(0, 30, 0, 0); // 00:30 local: the UTC date can still be yesterday
  const yesterday = new Date(today.getTime() - DAY);
  const bucket = (date: Date, output: number) => ({
    date: localDayKey(date), provider: "claude" as const,
    inputTokens: 0, outputTokens: output, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: output,
  });
  const snapshot: TokenAnalyticsSnapshot = {
    generatedAt: today.toISOString(), scope: "locally_observed",
    totals: { inputTokens: 0, outputTokens: 11, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 11 },
    providers: [], daily: [bucket(today, 1), bucket(yesterday, 10)], sources: [],
  };
  assert.equal(summarizeTokenRange(snapshot, "today", today.getTime()).totals.outputTokens, 1);
  assert.equal(summarizeTokenRange(snapshot, "7d", today.getTime()).totals.outputTokens, 11);
});

test("large totals stay exact through IPC; reasoning above output fails closed", () => {
  const big = 9_007_199_254_740_000; // below Number.MAX_SAFE_INTEGER
  const totals = { inputTokens: 1, outputTokens: big - 1, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: big, reasoningTokens: 7 };
  const tokens = {
    scope: "locally_observed", generatedAt: "2026-11-26T00:00:00Z", totals,
    providers: [{ provider: "claude", totals }], daily: [], sources: [],
    models: [{ provider: "claude", model: "claude-test", totals }], basis: "observed_lifetime",
    retainedTotals: { ...totals, totalTokens: 5, outputTokens: 4, inputTokens: 1, reasoningTokens: 0 },
    ledger: { since: "2026-11-01T00:00:00Z", records: 3, corrupt: 0 },
  };
  const projected = security.projectSnapshot({ version: 1, generatedAt: "", accounts: [], tokens }).tokens;
  assert.equal(projected?.totals.totalTokens, big);
  assert.equal(projected?.totals.reasoningTokens, 7);
  assert.equal(projected?.basis, "observed_lifetime");
  assert.equal(projected?.models?.[0]?.model, "claude-test");
  const unsafe = security.projectSnapshot({ version: 1, generatedAt: "", accounts: [],
    tokens: { ...tokens, totals: { ...totals, totalTokens: Number.MAX_SAFE_INTEGER + 2 } } }).tokens;
  assert.equal(unsafe, null);
  const tooMuchReasoning = security.projectSnapshot({ version: 1, generatedAt: "", accounts: [],
    tokens: { ...tokens, totals: { ...totals, reasoningTokens: big } } }).tokens;
  assert.equal(tooMuchReasoning, null);
  const badModel = security.projectSnapshot({ version: 1, generatedAt: "", accounts: [],
    tokens: { ...tokens, models: [{ provider: "claude", model: "C:\\Users\\private", totals }] } }).tokens;
  assert.equal(badModel, null);
});

test("record parsers expose reasoning and model without changing older totals", () => {
  const claude = parseClaudeTokenRecord({
    type: "assistant", uuid: "x", timestamp: "2026-11-01T10:00:00Z",
    message: { id: "m", model: "claude-test", usage: { input_tokens: 1, output_tokens: 10, output_tokens_details: { thinking_tokens: 4 } } },
  });
  assert.equal(claude?.model, "claude-test");
  assert.equal(claude?.totals.reasoningTokens, 4);
  assert.equal(claude?.totals.totalTokens, 11, "reasoning is never added");
  const state = createCodexTokenState();
  parseCodexTokenRecord({ type: "session_meta", timestamp: "2026-11-01T10:00:00Z", payload: { id: "s" } }, state);
  parseCodexTokenRecord({ type: "turn_context", timestamp: "2026-11-01T10:00:01Z", payload: { model: "gpt-test" } }, state);
  const codex = parseCodexTokenRecord({
    type: "event_msg", timestamp: "2026-11-01T10:00:02Z",
    payload: { type: "token_count", info: { last_token_usage: { input_tokens: 10, output_tokens: 6, reasoning_output_tokens: 2 } } },
  }, state);
  assert.equal(codex?.model, "gpt-test");
  assert.equal(codex?.totals.reasoningTokens, 2);
  assert.equal(codex?.totals.totalTokens, 16);
});

test("a busy or unreadable configuration never throws the token caches away", async () => {
  const service = await readFile(new URL("../collector/service.ts", import.meta.url), "utf8");
  // Regression (#57): "invalid" used to be treated as a consent change,
  // which reset every cache and republished totals from zero.
  assert.doesNotMatch(service, /observedConsent = "invalid"/);
  const snapshotHandler = service.slice(service.indexOf('if (request.url === "/snapshot")'));
  const catchBlock = snapshotHandler.slice(snapshotHandler.indexOf(".catch("), snapshotHandler.indexOf(".catch(") + 900);
  assert.doesNotMatch(catchBlock, /tokens\.invalidate\(\)/);
  assert.match(catchBlock, /tokens: null/);
});
