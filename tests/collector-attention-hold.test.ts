import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { AttentionHolds, BACKGROUND_RETRY_MS } from "../collector/attention-hold.ts";
import type { CollectorAccountResult } from "../collector/types.ts";

// Issue #49: a provider challenge or a signed-out profile needs a person.
// Scheduled cycles must not keep re-opening the profile under automation.
const account = { id: "claude-1", label: "Work" };
function resultWith(status: CollectorAccountResult["status"], checkedAt = "2026-11-18T10:00:00.000Z"): CollectorAccountResult {
  return { id: account.id, label: account.label, status, account: null, checkedAt, message: "provider message" };
}

test("after a verification challenge, scheduled cycles report it without collecting", () => {
  const holds = new AttentionHolds();
  assert.equal(holds.skip(account, "scheduled"), null, "first attempt collects");
  holds.record(resultWith("verification_required"));
  const held = holds.skip(account, "scheduled");
  assert.ok(held, "a scheduled cycle must not relaunch a challenged profile");
  assert.equal(held.status, "verification_required");
  assert.equal(held.checkedAt, "2026-11-18T10:00:00.000Z", "a held result must not look freshly collected");
  assert.equal(held.account, null, "no usage values are invented");
  assert.match(held.message ?? "", /Background checks are paused/);
});

test("a refresh the person asks for tries a held account again, and success clears the hold", () => {
  const holds = new AttentionHolds();
  holds.record(resultWith("verification_required"));
  assert.equal(holds.skip(account, "manual"), null);
  holds.record(resultWith("ok"));
  assert.equal(holds.isHeld(account.id), false);
  assert.equal(holds.skip(account, "scheduled"), null);
});

test("signed-out profiles are held too; transient failures are not", () => {
  const holds = new AttentionHolds();
  holds.record(resultWith("login_required"));
  assert.ok(holds.skip(account, "scheduled"));
  for (const status of ["unavailable", "unsupported"] as const) {
    const other = new AttentionHolds();
    other.record(resultWith(status));
    assert.equal(other.skip(account, "scheduled"), null, `${status} is retried normally`);
  }
});

test("automation never touches a profile a person has open, even on manual refresh", () => {
  const holds = new AttentionHolds();
  assert.equal(holds.beginInteractive(account.id), true);
  assert.equal(holds.beginInteractive(account.id), false, "one interactive window per profile");
  for (const trigger of ["scheduled", "manual"] as const) {
    const skipped = holds.skip(account, trigger);
    assert.ok(skipped);
    assert.equal(skipped.account, null);
    assert.match(skipped.message ?? "", /open for manual verification/);
  }
  holds.endInteractive(account.id);
  assert.equal(holds.skip(account, "manual"), null);
});

test("the verification path uses the normal browser and a config-validated account only", async () => {
  const opener = await readFile(new URL("../collector/manual-verification.ts", import.meta.url), "utf8");
  // No automation: no Playwright, no DevTools pipe or port, no page scripts.
  assert.doesNotMatch(opener, /playwright|remote-debugging|evaluate\(|addInitScript/);
  assert.match(opener, /assertSafeProfileDirectory\(account\.profileDir\)/);
  assert.match(opener, /claude: "https:\/\/claude\.ai\/settings\/usage"/);

  const service = await readFile(new URL("../collector/service.ts", import.meta.url), "utf8");
  assert.match(service, /\/\^\[a-z0-9\]\[a-z0-9_-\]\{0,31\}\$\/\.test\(id\)/);
  assert.match(service, /candidate\.id === id && candidate\.enabled/);
  assert.match(service, /collection_in_progress/);
  assert.match(service, /holds\.skip\(account, trigger, "hidden"\)/);
  assert.match(service, /holds\.skip\(account, trigger, "headless"\)/);
  // No fresh-collection claim when every account failed.
  assert.match(service, /some\(\(result\) => result\.status === "ok"\)/);

  const main = await readFile(new URL("../desktop/electron-ipc/main.js", import.meta.url), "utf8");
  assert.match(main, /accounts\/verify\?id=\$\{encodeURIComponent\(accountId\)\}/);
  assert.match(main, /ACCOUNT_ID_PATTERN\.test\(accountId\)/);
  // The tray must learn a held account within its own 30 s tick, not the
  // scheduler's 5-minute snapshot interval (found by the packaged E2E).
  assert.match(main, /Promise\.all\(\[refreshAttention\(\), refreshCollectorSettings\(\)\]\)\.finally\(refreshTray\)/);
  assert.match(main, /setInterval\(tick, 30_000\)/);
  assert.doesNotMatch(main, /scheduler\?\.lastResult/);
  // The renderer still has no route to collector POST operations.
  const preload = await readFile(new URL("../desktop/electron-ipc/preload.js", import.meta.url), "utf8").catch(() => "");
  assert.doesNotMatch(preload, /verify|monitoring/);
});

test("a held account is retried in the background at most once per day", () => {
  let now = Date.parse("2026-11-18T10:00:00.000Z");
  const holds = new AttentionHolds(() => now);
  holds.record(resultWith("verification_required"));
  now += BACKGROUND_RETRY_MS - 1;
  assert.ok(holds.skip(account, "scheduled"), "still within the retry window");
  now += 2;
  assert.equal(holds.skip(account, "scheduled"), null, "one background retry after a day");
});

test("a consented visible refresh retries a held account", () => {
  const holds = new AttentionHolds();
  holds.record(resultWith("verification_required"));
  assert.equal(holds.skip(account, "visible"), null);
});

test("holds survive a restart and carry statuses and timestamps only", () => {
  const now = Date.parse("2026-11-18T10:00:00.000Z");
  const first = new AttentionHolds(() => now);
  first.record({ ...resultWith("verification_required"), message: "secret page text must not persist" });
  const saved = first.serialize();
  assert.doesNotMatch(saved, /secret page text|account"|usedPercent/);
  const second = new AttentionHolds(() => now + 1_000);
  second.restore(saved, new Map([[account.id, account.label]]));
  assert.ok(second.skip(account, "scheduled"));
  // Unknown accounts, other statuses and future timestamps are dropped.
  const third = new AttentionHolds(() => now);
  third.restore(JSON.stringify({ version: 1, holds: [
    { id: "unknown", status: "verification_required", checkedAt: "2026-11-18T09:00:00.000Z", heldAt: now - 1 },
    { id: account.id, status: "ok", checkedAt: "2026-11-18T09:00:00.000Z", heldAt: now - 1 },
  ] }), new Map([[account.id, account.label]]));
  assert.equal(third.isHeld(account.id), false);
  assert.equal(third.isHeld("unknown"), false);
  const fourth = new AttentionHolds(() => now);
  fourth.restore("not json", new Map());
  assert.equal(fourth.isHeld(account.id), false);
});

test("only a consented visible refresh opens browser windows; background is headless", async () => {
  const service = await readFile(new URL("../collector/service.ts", import.meta.url), "utf8");
  assert.match(service, /const visible = trigger === "visible";/);
  assert.match(service, /collectProviderUsage\(account, \{ signal, visible \}\)/);
  assert.match(service, /trigger === "scheduled" && current\.backgroundCollection === "off"\) return null/);
  assert.match(service, /request\.url === "\/monitoring\/refresh-visible"/);
  // Restored holds are visible immediately after a restart, also when
  // background collection is off and no batch runs.
  assert.match(service, /const held = new Map\(holds\.heldResults\(enabledAtStart\)/);

  const main = await readFile(new URL("../desktop/electron-ipc/main.js", import.meta.url), "utf8");
  const start = main.indexOf("async function runVisibleRefresh()");
  const body = main.slice(start, main.indexOf("async function askVisibleRefreshConsent", start));
  const consent = body.indexOf("askVisibleRefreshConsent(");
  const request = body.indexOf('collectorControl("refreshVisible")');
  assert.ok(consent > 0 && request > consent, "the visible refresh is requested only after the consent dialog");
  assert.match(body, /if \(choice !== 1 \|\| quitting\) return;/);
  // One dialog and one visible batch at a time (no stacked consents).
  assert.match(body, /if \(trayCommandPending \|\| visibleConsentOpen \|\| collectorBusy\) return;/);
  const ask = main.slice(main.indexOf("async function askVisibleRefreshConsent"));
  assert.match(ask.slice(0, 1500), /dialog\.showMessageBox\(/);
  assert.equal((main.match(/collectorControl\("refreshVisible"\)/g) ?? []).length, 1);
  // Clear feedback while the consented run is active and when it ends.
  assert.match(main, /collectorBusy \? \[\{ label: "Checking accounts now\.\.\.", enabled: false \}\]/);
  assert.match(main, /title: "QuotaOps refresh finished"/);
});

test("restored holds are all shown at start, even past the background retry window", () => {
  let now = Date.parse("2026-11-18T10:00:00.000Z");
  const holds = new AttentionHolds(() => now);
  holds.record(resultWith("verification_required"));
  now += BACKGROUND_RETRY_MS * 3;
  assert.equal(holds.skip(account, "scheduled"), null, "background may retry after the window");
  const shown = holds.heldResults([account, { id: "other", label: "Other" }]);
  assert.equal(shown.length, 1);
  assert.equal(shown[0]?.status, "verification_required");
});

test("a failed state rename leaves no temporary file behind", async () => {
  const { mkdtemp, mkdir, readdir, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { persistHolds } = await import("../collector/attention-hold.ts");
  const dir = await mkdtemp(join(tmpdir(), "quotaops-holds-"));
  try {
    const target = join(dir, "collector-state.json");
    await mkdir(target); // a directory where the file should go: rename fails
    const holds = new AttentionHolds();
    holds.record(resultWith("verification_required"));
    await persistHolds(holds, target);
    assert.deepEqual((await readdir(dir)).filter((name) => name.endsWith(".tmp")), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("holds are saved even when a batch stops part-way (Quit or Pause)", async () => {
  const service = await readFile(new URL("../collector/service.ts", import.meta.url), "utf8");
  assert.match(service, /\} finally \{\s*await persistHolds\(holds, statePath\);\s*\}/);
  assert.doesNotMatch(service, /nextTrigger/, "no shared mutable trigger that could be replayed later");
  assert.match(service, /monitoring\.queueRefresh\("visible"\)/);
});

test("a hold recorded headless does not stop a hidden-desktop attempt", () => {
  const holds = new AttentionHolds();
  holds.record(resultWith("verification_required"), "headless");
  assert.ok(holds.skip(account, "scheduled", "headless"), "same presentation: still held");
  assert.equal(holds.skip(account, "scheduled", "hidden"), null, "different presentation: one new attempt");
  holds.record(resultWith("verification_required"), "hidden");
  assert.ok(holds.skip(account, "scheduled", "hidden"));
});

test("holds saved before presentations existed restore as headless", () => {
  const now = Date.parse("2026-11-20T13:00:00.000Z");
  const holds = new AttentionHolds(() => now);
  holds.restore(JSON.stringify({ version: 1, holds: [
    { id: account.id, status: "verification_required", checkedAt: "2026-11-20T12:21:01.751Z", heldAt: now - 60_000 },
  ] }), new Map([[account.id, account.label]]));
  assert.ok(holds.skip(account, "scheduled", "headless"));
  assert.equal(holds.skip(account, "scheduled", "hidden"), null);
  assert.match(holds.serialize(), /"presentation":"headless"/);
});
