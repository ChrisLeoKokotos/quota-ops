import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// The installed app must not need a terminal for token analytics, and turning
// it on stays an explicit, informed choice.
test("the collector accepts only an exact two-flag consent and keeps Antigravity's own opt-in", async () => {
  const service = await readFile(new URL("../collector/service.ts", import.meta.url), "utf8");
  assert.match(service, /url\.pathname === "\/token-analytics\/consent" && keys === "claude-code,codex"/);
  assert.match(service, /value === "1" \? true : value === "0" \? false : null/);
  assert.match(service, /const sources = \{ \.\.\.current\.tokenAnalyticsSources, claudeCode, codex \};/);
});

test("the tray asks before turning token analytics on and says what is read", async () => {
  const main = await readFile(new URL("../desktop/electron-ipc/main.js", import.meta.url), "utf8");
  const body = main.slice(main.indexOf("async function runTokenAnalyticsToggle()"), main.indexOf("/** Open one isolated profile"));
  const dialogAt = body.indexOf("dialog.showMessageBox(");
  const postAt = body.indexOf("token-analytics/consent?");
  assert.ok(dialogAt > 0 && postAt > dialogAt, "consent dialog comes before the request");
  assert.match(body, /if \(choice\.response !== 1\) return;/);
  assert.match(body, /Prompts, responses and file contents are not read/);
  assert.match(main, /"Turn on token analytics\.\.\."/);
});

test("the dashboard distinguishes analytics off from collector offline and shows partial reasons", async () => {
  const dashboard = await readFile(new URL("../components/quota-dashboard.tsx", import.meta.url), "utf8");
  assert.match(dashboard, /Token analytics is off\. Turn it on from the QuotaOps tray menu/);
  assert.match(dashboard, /collectorConnected=\{collectorState === "connected"\}/);
  assert.match(dashboard, /source\.state === "partial" && source\.message/);
  assert.match(dashboard, /Counts cover only sessions on this PC\./);
});
