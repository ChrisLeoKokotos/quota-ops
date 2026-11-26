import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";

import { AttentionHolds } from "../collector/attention-hold.ts";
import type { CollectorAccountResult } from "../collector/types.ts";

// Owner report (20 Nov 2026): five configured, enabled Claude accounts and an
// empty dashboard, because only successful readings became cards.
const account = { id: "dev-1", label: "Dev 1" };
const ok = (checkedAt: string): CollectorAccountResult => ({
  id: account.id, label: account.label, status: "ok", checkedAt, message: null,
  account: { id: account.id, label: account.label, provider: "claude", plan: "Team", updatedAt: checkedAt, windows: [] },
});

test("the last successful reading time is kept and survives a restart", () => {
  const holds = new AttentionHolds(() => Date.parse("2026-11-21T12:00:00.000Z"));
  assert.equal(holds.lastSuccessAt(account.id), null, "never synced");
  holds.record(ok("2026-11-21T11:59:00.000Z"));
  holds.record({ ...ok("2026-11-21T11:59:30.000Z"), status: "verification_required", account: null });
  assert.equal(holds.lastSuccessAt(account.id), "2026-11-21T11:59:00.000Z", "a failed check keeps the last success");
  const restored = new AttentionHolds(() => Date.parse("2026-11-21T12:05:00.000Z"));
  restored.restore(holds.serialize(), new Map([[account.id, account.label]]));
  assert.equal(restored.lastSuccessAt(account.id), "2026-11-21T11:59:00.000Z");
  // No usage values are persisted, only times and statuses.
  assert.doesNotMatch(holds.serialize(), /usedPercent|windows|Team/);
});

test("restored success times are validated (known ids, past ISO times only)", () => {
  const now = Date.parse("2026-11-21T12:00:00.000Z");
  const holds = new AttentionHolds(() => now);
  holds.restore(JSON.stringify({
    version: 1,
    holds: [],
    lastSuccess: { "dev-1": "2026-11-21T13:00:00.000Z", unknown: "2026-11-21T11:00:00.000Z", "dev-2": "nonsense" },
  }), new Map([["dev-1", "Dev 1"], ["dev-2", "Dev 2"]]));
  assert.equal(holds.lastSuccessAt("dev-1"), null, "future times are rejected");
  assert.equal(holds.lastSuccessAt("dev-2"), null);
  assert.equal(holds.lastSuccessAt("unknown"), null);
});

test("every enabled account is in the first snapshot, as configured or held, never as usage", async () => {
  const service = await readFile(new URL("../collector/service.ts", import.meta.url), "utf8");
  assert.match(service, /status: "configured",\s*account: null,/);
  assert.match(service, /results = enabledAtStart\.map\(\(account\) => withLastSuccess\(held\.get\(account\.id\) \?\? configuredResult\(account\)\)\);/);
  assert.match(service, /results = value\.nextResults\.map\(withLastSuccess\);/);
});

test("the desktop IPC projection carries lastSuccessAt as bounded text only", () => {
  const require = createRequire(import.meta.url);
  const { projectSnapshot } = require("../desktop/electron-ipc/security.js") as {
    projectSnapshot: (value: unknown) => { accounts: Array<Record<string, unknown>> };
  };
  const projected = projectSnapshot({
    version: 1,
    generatedAt: "2026-11-21T12:00:00.000Z",
    accounts: [
      { id: "dev-1", label: "Dev 1", status: "configured", checkedAt: "1970-01-01T00:00:00.000Z", message: "Not checked yet in this session.", account: null, lastSuccessAt: null },
      { id: "dev-2", label: "Dev 2", status: "verification_required", checkedAt: "2026-11-21T11:00:00.000Z", message: null, account: null, lastSuccessAt: "2026-11-20T20:00:00.000Z", extra: "dropped" },
    ],
  });
  assert.equal(projected.accounts[0]?.status, "configured");
  assert.equal(projected.accounts[0]?.lastSuccessAt, null);
  assert.equal(projected.accounts[1]?.lastSuccessAt, "2026-11-20T20:00:00.000Z");
  assert.equal("extra" in (projected.accounts[1] ?? {}), false);
});

test("the dashboard shows a card for every configured account and never a percentage without a reading", async () => {
  const dashboard = await readFile(new URL("../components/quota-dashboard.tsx", import.meta.url), "utf8");
  assert.match(dashboard, /function CollectorStatusCard\(/);
  assert.match(dashboard, /"Never successfully synced"/);
  assert.match(dashboard, /collectorStates\.filter\(\(state\) => !accounts\.some\(\(account\) => account\.id === state\.id\)\)/);
  const card = dashboard.slice(dashboard.indexOf("function CollectorStatusCard("), dashboard.indexOf("function AccountCard("));
  assert.doesNotMatch(card, /usedPercent|QuotaRow|%\{|\d+%/, "a status card has no usage figures");
  assert.match(dashboard, /Latest check: \{COLLECTOR_ISSUE_LABELS\[collectorState\.status\]/, "stale cards say they are stale");
  assert.match(dashboard, /configured: "Not checked yet"/);
});
