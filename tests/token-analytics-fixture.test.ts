import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { collectLocalTokenAnalytics, resetTokenScanCache } from "../collector/token-analytics.ts";
import { summarizeTokenRange } from "../lib/token-analytics.ts";

// End-to-end over files on disk, with totals worked out by hand. The scanner
// reads %USERPROFILE%\.claude\projects and %USERPROFILE%\.codex\{sessions,
// archived_sessions}; the test points USERPROFILE/HOME at a temporary home.
const DAY = 24 * 60 * 60 * 1000;
const now = Date.now();
const iso = (msAgo: number) => new Date(now - msAgo).toISOString();
const PROMPT = "PRIVATE PROMPT TEXT that must never reach the snapshot";
const NL = String.fromCharCode(10);

async function withHome<T>(run: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), "quotaops-tokens-"));
  const saved = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME };
  process.env.USERPROFILE = home;
  process.env.HOME = home;
  resetTokenScanCache();
  try {
    return await run(home);
  } finally {
    process.env.USERPROFILE = saved.USERPROFILE;
    process.env.HOME = saved.HOME;
    await rm(home, { recursive: true, force: true });
  }
}

const lines = (records: unknown[]) => records.map((record) => JSON.stringify(record)).join("\n") + "\n";

async function writeFixture(home: string): Promise<void> {
  // Claude Code: two projects. m1 appears twice (streaming duplicate) and in
  // a resumed (forked) session file: it must count once.
  const claude = join(home, ".claude", "projects");
  await mkdir(join(claude, "project-a"), { recursive: true });
  await mkdir(join(claude, "project-b"), { recursive: true });
  const m1 = {
    type: "assistant", uuid: "u-1", sessionId: "s-1", timestamp: iso(60_000),
    message: { id: "msg_m1", content: [{ type: "text", text: PROMPT }],
      usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200 } },
  };
  await writeFile(join(claude, "project-a", "s-1.jsonl"), lines([
    { type: "user", uuid: "u-0", timestamp: iso(70_000), message: { content: PROMPT } },
    m1,
    m1,
    { type: "assistant", uuid: "u-2", sessionId: "s-1", timestamp: iso(10 * DAY),
      message: { id: "msg_m2", usage: { input_tokens: 10, output_tokens: 5 } } },
  ]));
  await writeFile(join(claude, "project-b", "s-2-resumed.jsonl"), lines([
    m1,
    { type: "assistant", uuid: "u-3", sessionId: "s-2", timestamp: iso(40 * DAY),
      message: { id: "msg_m3", usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 } } },
  ]));

  // Codex: one active session (today) and one archived session (20 days ago).
  const sessions = join(home, ".codex", "sessions", "2026", "11", "21");
  const archived = join(home, ".codex", "archived_sessions");
  await mkdir(sessions, { recursive: true });
  await mkdir(archived, { recursive: true });
  const codexSession = (id: string, at: string, last: Record<string, number>) => lines([
    { timestamp: at, type: "session_meta", payload: { id } },
    { timestamp: at, type: "response_item", payload: { type: "message", content: [{ type: "input_text", text: PROMPT }] } },
    { timestamp: at, type: "event_msg", payload: { type: "token_count", info: { last_token_usage: last, total_token_usage: last } } },
  ]);
  await writeFile(join(sessions, "rollout-active.jsonl"),
    codexSession("c-1", iso(30_000), { input_tokens: 300, cached_input_tokens: 200, output_tokens: 30 }));
  await writeFile(join(archived, "rollout-archived.jsonl"),
    codexSession("c-2", iso(20 * DAY), { input_tokens: 50, output_tokens: 5 }));
}

test("token totals from local files match hand-computed values for every range", async () => {
  await withHome(async (home) => {
    await writeFixture(home);
    const snapshot = await collectLocalTokenAnalytics({ claudeCode: true, codex: true });

    // Claude: m1 once (100+50+1000+200 = 1350), m2 (15), m3 (10). Codex:
    // active 300 input incl. 200 cached + 30 output = 330; archived 55.
    const today = summarizeTokenRange(snapshot, "today", now);
    const week = summarizeTokenRange(snapshot, "7d", now);
    const month = summarizeTokenRange(snapshot, "30d", now);
    const all = summarizeTokenRange(snapshot, "all", now);

    assert.equal(today.totals.totalTokens, 1350 + 330);
    assert.equal(week.totals.totalTokens, 1350 + 330);
    assert.equal(month.totals.totalTokens, 1350 + 15 + 330 + 55);
    assert.equal(all.totals.totalTokens, 1350 + 15 + 10 + 330 + 55);

    // Breakdown: Claude cache is extra observed input; Codex cache is part of input.
    assert.deepEqual(
      { input: all.totals.inputTokens, output: all.totals.outputTokens, cacheRead: all.totals.cacheReadTokens, cacheWrite: all.totals.cacheWriteTokens },
      { input: 100 + 10 + 1 + 300 + 50, output: 50 + 5 + 2 + 30 + 5, cacheRead: 1000 + 3 + 200, cacheWrite: 200 + 4 },
    );
    const byProvider = Object.fromEntries(all.providers.map((p) => [p.provider, p.totals.totalTokens]));
    assert.equal(byProvider.claude, 1375);
    assert.equal(byProvider.openai, 385);

    // Source health is reported per source.
    const states = Object.fromEntries(snapshot.sources.map((s) => [s.source, s.state]));
    assert.equal(states["claude-code"], "ok");
    assert.equal(states.codex, "ok");

    // Numbers only: no prompt text and no local paths in what the UI receives.
    const json = JSON.stringify(snapshot);
    assert.doesNotMatch(json, /PRIVATE PROMPT/);
    // Plain substring checks: the home path raw and as it would appear
    // JSON-escaped (doubled backslashes). A regex built from a sliced,
    // escaped path broke on short paths (CI: C:\Users\RUNNER~1\...).
    assert.equal(json.includes(home), false);
    assert.equal(json.includes(JSON.stringify(home).slice(1, -1)), false);
  });
});

test("a missing history directory is reported as not found, never as zero work", async () => {
  await withHome(async () => {
    const snapshot = await collectLocalTokenAnalytics({ claudeCode: true, codex: true });
    const states = Object.fromEntries(snapshot.sources.map((s) => [s.source, s.state]));
    assert.equal(states["claude-code"], "not_found");
    assert.equal(states.codex, "not_found");
  });
});

test("later passes read only appended lines and forget deleted files", async () => {
  await withHome(async (home) => {
    const { appendFile, rm: remove } = await import("node:fs/promises");
    await writeFixture(home);
    const first = await collectLocalTokenAnalytics({ claudeCode: true, codex: false });
    assert.equal(summarizeTokenRange(first, "all", now).totals.totalTokens, 1375);
    const file = join(home, ".claude", "projects", "project-a", "s-1.jsonl");
    await appendFile(file, JSON.stringify({ type: "assistant", uuid: "u-9", timestamp: iso(1_000),
      message: { id: "msg_m9", usage: { input_tokens: 7, output_tokens: 3 } } }) + NL);
    const second = await collectLocalTokenAnalytics({ claudeCode: true, codex: false });
    assert.equal(summarizeTokenRange(second, "all", now).totals.totalTokens, 1385);
    await remove(join(home, ".claude", "projects", "project-b"), { recursive: true, force: true });
    const third = await collectLocalTokenAnalytics({ claudeCode: true, codex: false });
    // m1 is still in project-a; m3 (10) left with project-b.
    assert.equal(summarizeTokenRange(third, "all", now).totals.totalTokens, 1375);
  });
});

test("a skipped oversized usage record makes the source partial; a long user line does not", async () => {
  await withHome(async (home) => {
    const dir = join(home, ".claude", "projects", "p");
    await mkdir(dir, { recursive: true });
    const hugeUser = JSON.stringify({ type: "user", message: { content: "x".repeat(17 * 1024 * 1024) } });
    await writeFile(join(dir, "a.jsonl"), hugeUser + NL + JSON.stringify({ type: "assistant", uuid: "u", timestamp: iso(1_000),
      message: { id: "m", usage: { input_tokens: 1, output_tokens: 1 } } }) + NL);
    const userOnly = await collectLocalTokenAnalytics({ claudeCode: true, codex: false });
    assert.equal(userOnly.sources.find((s) => s.source === "claude-code")?.state, "ok");
    const hugeAssistant = JSON.stringify({ type: "assistant", message: { id: "big", content: "y".repeat(17 * 1024 * 1024), usage: { input_tokens: 5 } } });
    await writeFile(join(dir, "b.jsonl"), hugeAssistant + NL);
    const withAssistant = await collectLocalTokenAnalytics({ claudeCode: true, codex: false });
    const source = withAssistant.sources.find((s) => s.source === "claude-code");
    assert.equal(source?.state, "partial");
    assert.match(source?.message ?? "", /very large Claude Code record/);
  });
});
