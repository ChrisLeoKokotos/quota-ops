import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { collectLocalTokenAnalytics, resetTokenScanCache, tokenScanPending } from "../collector/token-analytics.ts";
import { TokenRunner } from "../collector/token-runner.ts";
import { parseTokenScanStatus } from "../lib/collector-client.ts";
import { tokenPanelState, type TokenAnalyticsSnapshot } from "../lib/token-analytics.ts";

const NL = String.fromCharCode(10);
const ACCOUNT_A = "0b0e5c1e-aaaa-4abc-9def-001122334455";
const ACCOUNT_B = "7f3d9a20-bbbb-4abc-9def-66778899aabb";
const ORG = "11111111-2222-4333-8444-555555555555";
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

async function withHome<T>(run: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), "quotaops-attrib-"));
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

const usage = (id: string, session: string, input: number, output: number) => ({
  type: "assistant", uuid: `u-${id}`, sessionId: session, timestamp: iso(60_000),
  message: { id, content: [{ type: "text", text: "PRIVATE PROMPT" }], usage: { input_tokens: input, output_tokens: output } },
});
const owner = (session: string, account: string) => ({ type: "session-owner", sessionId: session, accountUuid: account, organizationUuid: ORG });
const lines = (records: unknown[]) => records.map((record) => JSON.stringify(record)).join(NL) + NL;

test("Claude Code usage is attributed only to the single account its session records; the rest stays unattributed", async () => {
  await withHome(async (home) => {
    const dir = join(home, ".claude", "projects", "p");
    await mkdir(join(dir, "s-a", "subagents"), { recursive: true });
    // s-a: account A (100 + 10), plus a subagent file of the same session (5 + 5)
    //       whose own file has no owner record: it belongs to s-a.
    await writeFile(join(dir, "s-a.jsonl"), lines([owner("s-a", ACCOUNT_A), usage("m1", "s-a", 100, 10)]));
    await writeFile(join(dir, "s-a", "subagents", "agent-1.jsonl"), lines([usage("m2", "s-a", 5, 5)]));
    // s-b: account B (200 + 20), owner record repeated (still one account).
    await writeFile(join(dir, "s-b.jsonl"), lines([owner("s-b", ACCOUNT_B), usage("m3", "s-b", 200, 20), owner("s-b", ACCOUNT_B)]));
    // s-old: no owner record (older Claude Code): 300 + 30, unattributed.
    await writeFile(join(dir, "s-old.jsonl"), lines([usage("m4", "s-old", 300, 30)]));
    // s-mixed: two accounts named: 40 + 4, unattributed, never split.
    await writeFile(join(dir, "s-mixed.jsonl"), lines([owner("s-mixed", ACCOUNT_A), owner("s-mixed", ACCOUNT_B), usage("m5", "s-mixed", 40, 4)]));
    // Claude Code is signed in to account A now.
    await writeFile(join(home, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: ACCOUNT_A, emailAddress: "private@example.invalid" } }));

    const snapshot = await collectLocalTokenAnalytics({ claudeCode: true, codex: false });
    assert.equal(snapshot.totals.totalTokens, 110 + 10 + 220 + 330 + 44);
    const accounts = snapshot.accounts ?? [];
    const attributed = accounts.filter((item) => item.attribution === "attributed");
    assert.equal(attributed.length, 2);
    const [first, second] = attributed;
    assert.equal(first?.totals.totalTokens, 220); // B, largest first
    assert.equal(first?.current, false);
    assert.equal(second?.totals.totalTokens, 120); // A, with its subagent
    assert.equal(second?.current, true);
    assert.equal(second?.sessions, 1);
    for (const item of attributed) assert.match(item.account ?? "", /^[0-9a-f]{12}$/);
    const none = accounts.find((item) => item.attribution === "no_account_record");
    const mixed = accounts.find((item) => item.attribution === "several_accounts");
    assert.equal(none?.account, null);
    assert.equal(none?.totals.totalTokens, 330);
    assert.equal(mixed?.account, null);
    assert.equal(mixed?.totals.totalTokens, 44);
    // Every token is in exactly one row: nothing is guessed or spread out.
    assert.equal(accounts.reduce((sum, item) => sum + item.totals.totalTokens, 0), snapshot.totals.totalTokens);

    // No raw account or organization id, email or prompt text leaves the scanner.
    const json = JSON.stringify(snapshot);
    for (const secret of [ACCOUNT_A, ACCOUNT_B, ORG, "private@example.invalid", "PRIVATE PROMPT"]) {
      assert.equal(json.includes(secret), false, secret);
    }
    // The salt is per QuotaOps home, so keys are stable across passes.
    const salt = await readFile(join(home, ".quotaops", "token-account-salt"));
    assert.equal(salt.length, 32);
    const again = await collectLocalTokenAnalytics({ claudeCode: true, codex: false });
    assert.deepEqual(again.accounts?.map((item) => item.account), accounts.map((item) => item.account));
  });
});

test("a history without any account record reports everything as unattributed", async () => {
  await withHome(async (home) => {
    const dir = join(home, ".claude", "projects", "p");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "s.jsonl"), lines([usage("m1", "s", 3, 4)]));
    const snapshot = await collectLocalTokenAnalytics({ claudeCode: true, codex: false });
    assert.deepEqual(snapshot.accounts?.map((item) => [item.account, item.attribution, item.totals.totalTokens]),
      [[null, "no_account_record", 7]]);
    assert.equal(tokenScanPending(), false);
  });
});

function fakeTimers() {
  const pending: Array<{ run: () => void; ms: number }> = [];
  return {
    pending,
    setTimer: (run: () => void, ms: number) => { const entry = { run, ms }; pending.push(entry); return entry; },
    clearTimer: (handle: unknown) => { const index = pending.indexOf(handle as never); if (index >= 0) pending.splice(index, 1); },
  };
}

const snapshotOf = (total: number): TokenAnalyticsSnapshot => ({
  generatedAt: new Date().toISOString(),
  scope: "locally_observed",
  totals: { inputTokens: total, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: total },
  providers: [], daily: [],
  sources: [{ source: "claude-code", provider: "claude", state: "ok", files: 1, message: null }],
});

test("token runner: disabled without consent, scanning at once, passes repeat while files are pending", async () => {
  const timers = fakeTimers();
  let consent = false;
  let passes = 0;
  let pendingAfter = 2;
  const runner = new TokenRunner({
    scan: async () => {
      if (!consent) return null;
      passes += 1;
      pendingAfter -= 1;
      return { snapshot: snapshotOf(passes * 100), pending: pendingAfter > 0 };
    },
    ...timers,
    pendingDelayMs: 1_000,
    refreshMs: 300_000,
  });
  await runner.trigger();
  assert.deepEqual(runner.status, { state: "disabled", scannedAt: null, pending: false });
  assert.equal(runner.snapshot, null);
  assert.equal(timers.pending.length, 0, "no scheduled scans without consent");

  consent = true;
  const first = runner.trigger();
  assert.equal(runner.status.state, "scanning", "the state changes before the first pass returns");
  await first;
  assert.equal(runner.status.state, "ready");
  assert.equal(runner.status.pending, true);
  // Read through a function: assert.equal(x, null) above narrowed the getter.
  const current = (): TokenAnalyticsSnapshot | null => runner.snapshot;
  assert.equal(current()?.totals.totalTokens, 100);
  assert.equal(timers.pending[0]?.ms, 1_000, "pending files: next pass soon");

  timers.pending.shift()?.run();
  await new Promise((resolve) => setImmediate(resolve));
  await runner.trigger();
  assert.equal(runner.status.pending, false);
  assert.equal(timers.pending.at(-1)?.ms, 300_000, "complete: refresh every few minutes");

  consent = false;
  await runner.trigger();
  assert.equal(runner.status.state, "disabled");
  assert.equal(runner.snapshot, null, "turning consent off hides the totals at once");
  runner.stop();
});

test("token runner: a failed pass is 'unavailable', keeps the last totals, and retries", async () => {
  const timers = fakeTimers();
  let fail = false;
  const runner = new TokenRunner({
    scan: async () => {
      if (fail) throw new Error("disk");
      return { snapshot: snapshotOf(42), pending: false };
    },
    ...timers,
  });
  await runner.trigger();
  fail = true;
  await runner.trigger();
  assert.equal(runner.status.state, "unavailable");
  assert.equal(runner.snapshot?.totals.totalTokens, 42);
  assert.equal(timers.pending.length, 1);
  runner.stop();
  assert.equal(timers.pending.length, 0);
});

test("the token panel tells every state apart", () => {
  const ready = { state: "ready" as const, scannedAt: "2026-11-21T00:00:00Z", pending: false };
  const complete = snapshotOf(5);
  const partial: TokenAnalyticsSnapshot = {
    ...complete,
    sources: [{ source: "claude-code", provider: "claude", state: "partial", files: 1, message: "still reading" }],
  };
  assert.equal(tokenPanelState(null, null, "offline"), "offline");
  assert.equal(tokenPanelState(null, null, "checking"), "checking", "never 'start the collector' before the first snapshot");
  assert.equal(tokenPanelState(null, { state: "disabled", scannedAt: null, pending: false }, "connected"), "disabled");
  assert.equal(tokenPanelState(null, null, "connected"), "disabled", "older collector without status and no data");
  assert.equal(tokenPanelState(null, { state: "scanning", scannedAt: null, pending: false }, "connected"), "scanning");
  assert.equal(tokenPanelState(null, { state: "unavailable", scannedAt: null, pending: false }, "connected"), "unavailable");
  assert.equal(tokenPanelState(complete, { ...ready, state: "unavailable" }, "connected"), "unavailable");
  assert.equal(tokenPanelState(complete, { ...ready, pending: true }, "connected"), "partial");
  assert.equal(tokenPanelState(partial, ready, "connected"), "partial");
  assert.equal(tokenPanelState(snapshotOf(0), ready, "connected"), "zero");
  assert.equal(tokenPanelState(complete, ready, "connected"), "complete");
  // A source the person did not consent to does not make the rest partial.
  assert.equal(tokenPanelState({
    ...complete,
    sources: [...complete.sources, { source: "codex", provider: "openai", state: "disabled", files: 0, message: null }],
  }, ready, "connected"), "complete");
});

test("the renderer accepts only a well-formed scan status", () => {
  assert.deepEqual(parseTokenScanStatus({ state: "scanning", scannedAt: null, pending: true, x: 1 }),
    { state: "scanning", scannedAt: null, pending: true });
  for (const bad of [null, "ready", { state: "done", scannedAt: null, pending: false }, { state: "ready", scannedAt: 1, pending: false }]) {
    assert.equal(parseTokenScanStatus(bad), null);
  }
});

test("the dashboard can only ask to switch token analytics; consent stays in the native dialog", async () => {
  const preload = await readFile(new URL("../desktop/electron-ipc/preload.js", import.meta.url), "utf8");
  // Exactly two channels, the second carrying a strict boolean.
  assert.deepEqual([...preload.matchAll(/ipcRenderer\.invoke\("([^"]+)"/g)].map((match) => match[1]),
    ["quotaops:snapshot", "quotaops:token-analytics"]);
  assert.match(preload, /enabled === true/);
  const main = await readFile(new URL("../desktop/electron-ipc/main.js", import.meta.url), "utf8");
  const handler = main.slice(main.indexOf('ipcMain.handle("quotaops:token-analytics"'));
  assert.ok(handler.length > 0);
  const body = handler.slice(0, handler.indexOf("});"));
  assert.match(body, /isTrustedIpcSender\(event, trustedSender\)/);
  assert.match(body, /typeof enabled !== "boolean"/);
  assert.match(body, /setTokenAnalytics\(enabled, mainWindow\)/);
  // Turning on goes through the dialog; only "Turn on" (response 1) proceeds.
  const setter = main.slice(main.indexOf("async function setTokenAnalytics("), main.indexOf("/** Open one isolated profile"));
  assert.match(setter, /dialog\.showMessageBox/);
  assert.match(setter, /if \(choice\.response !== 1\) return "cancelled";/);
  assert.ok(setter.indexOf("showMessageBox") < setter.indexOf("collectorPost("), "the dialog comes before any consent write");
});

test("token analytics no longer waits for provider quota batches", async () => {
  const service = await readFile(new URL("../collector/service.ts", import.meta.url), "utf8");
  // The quota batch no longer computes tokens; the runner does, on its own clock.
  assert.doesNotMatch(service, /nextTokens/);
  assert.match(service, /new TokenRunner\(/);
  assert.match(service, /tokens: tokens\.snapshot/);
  assert.match(service, /tokenStatus: tokens\.status/);
  assert.match(service, /void tokens\.trigger\(\);/);
});


test("consent invalidation hides previous data immediately and rejects in-flight old-generation results",async()=>{
  let release!: (value:{snapshot:TokenAnalyticsSnapshot;pending:boolean})=>void;
  let activeSignal:AbortSignal|undefined;
  let pass=0, cleared=0;
  const runner=new TokenRunner({
    ...fakeTimers(),
    clearCache:()=>{cleared++;},
    scan:async signal=>{
      pass++;
      if(pass===1)return {snapshot:snapshotOf(42),pending:false};
      if(pass===2){activeSignal=signal;return new Promise(resolve=>{release=resolve;});}
      return null;
    },
  });
  await runner.trigger();
  const old=runner.trigger();
  runner.invalidate();
  assert.equal(activeSignal?.aborted,true);
  assert.equal(runner.snapshot,null);
  release({snapshot:snapshotOf(999),pending:false});
  await old;
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(runner.snapshot,null);
  assert.equal(runner.status.state,"disabled");
  assert.equal(cleared,1);
  runner.stop();
});


test("rapid consent invalidations coalesce and a failed replacement cannot expose revoked totals",async()=>{
  let pass=0, release!:()=>void;
  const runner=new TokenRunner({...fakeTimers(),scan:async()=>{
    pass++;
    if(pass===1)return {snapshot:snapshotOf(100),pending:false};
    if(pass===2){await new Promise<void>(resolve=>{release=resolve;});return {snapshot:snapshotOf(999),pending:false};}
    throw Error("rescan failed");
  }});
  await runner.trigger();
  const old=runner.trigger();
  runner.invalidate();runner.invalidate();
  assert.equal(runner.snapshot,null);
  release();await old;await new Promise(resolve=>setImmediate(resolve));
  assert.equal(runner.status.state,"unavailable");
  assert.equal(runner.snapshot,null);
  assert.equal(pass,3);
  runner.stop();
});
