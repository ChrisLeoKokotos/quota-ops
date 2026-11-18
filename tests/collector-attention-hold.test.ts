import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { AttentionHolds } from "../collector/attention-hold.ts";
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
  assert.match(held.message ?? "", /Automatic checks are paused/);
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
  assert.match(service, /holds\.skip\(account, trigger\)/);
  // No fresh-collection claim when every account failed.
  assert.match(service, /some\(\(result\) => result\.status === "ok"\)/);

  const main = await readFile(new URL("../desktop/electron-ipc/main.js", import.meta.url), "utf8");
  assert.match(main, /accounts\/verify\?id=\$\{encodeURIComponent\(accountId\)\}/);
  assert.match(main, /ACCOUNT_ID_PATTERN\.test\(accountId\)/);
  // The renderer still has no route to collector POST operations.
  const preload = await readFile(new URL("../desktop/electron-ipc/preload.js", import.meta.url), "utf8").catch(() => "");
  assert.doesNotMatch(preload, /verify|monitoring/);
});
