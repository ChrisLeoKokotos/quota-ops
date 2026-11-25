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
  // Only "Turn on" (response 1) proceeds; the tray and the dashboard button
  // share this one function.
  assert.match(body, /if \(choice\.response !== 1\) return "cancelled";/);
  assert.match(body, /files may contain private prompts, responses and code/);
  assert.match(body, /does not retain or export their content/);
  assert.match(body, /defaultId: 0/);
  assert.match(main, /"Turn on token analytics\.\.\."/);
});

test("the dashboard distinguishes analytics off from collector offline and shows partial reasons", async () => {
  const dashboard = await readFile(new URL("../components/quota-dashboard.tsx", import.meta.url), "utf8");
  // Off is a visible call to action in the dashboard itself (desktop:
  // a button that opens the consent dialog; browser: the CLI command).
  assert.match(dashboard, /Token analytics is off\./);
  assert.match(dashboard, /Turn on token analytics/);
  assert.match(dashboard, /npm run collector:setup -- tokens-auto enable claude-code/);
  assert.match(dashboard, /collectorState=\{collectorState\}/);
  assert.match(dashboard, /source\.state === "partial" && source\.message/);
  assert.match(dashboard, /Counts cover only[\s\S]*sessions on this PC/);
  // The all-time total is the panel's headline, whatever period is selected.
  assert.match(dashboard, /Total tokens processed · All time/);
  assert.match(dashboard, /formatTokenCount\(analytics\.totals\.totalTokens\)/);
});
