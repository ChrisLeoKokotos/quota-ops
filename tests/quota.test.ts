import assert from "node:assert/strict";
import test from "node:test";

import {
  getAccountStatus,
  getRecommendedAccount,
  getWindowState,
  recommendationScore,
  type QuotaAccount,
} from "../lib/quota.ts";

const NOW = Date.parse("2026-10-06T00:00:00.000Z");

function account(
  id: string,
  fiveHourUsed: number,
  weeklyUsed: number,
): QuotaAccount {
  return {
    id,
    label: id,
    provider: "claude",
    plan: "team",
    fiveHour: {
      usedPercent: fiveHourUsed,
      resetAt: "2026-10-06T04:00:00.000Z",
    },
    weekly: {
      usedPercent: weeklyUsed,
      resetAt: "2026-10-10T12:00:00.000Z",
    },
    updatedAt: "2026-10-06T00:00:00.000Z",
  };
}

test("weekly exhaustion blocks an account", () => {
  assert.equal(getAccountStatus(account("dev-1", 40, 100), NOW), "weekly_limited");
});

test("five-hour exhaustion blocks an account", () => {
  assert.equal(
    getAccountStatus(account("dev-2", 100, 20), NOW),
    "five_hour_limited",
  );
});

test("missing reset timestamps require setup instead of stale-refresh messaging", () => {
  const incomplete = account("dev-setup", 0, 20);
  incomplete.fiveHour.resetAt = null;

  assert.equal(getAccountStatus(incomplete, NOW), "needs_setup");
});

test("expired reset timestamps require refresh instead of inventing capacity", () => {
  const stale = account("dev-3", 60, 60);
  stale.fiveHour.resetAt = "2026-10-05T23:00:00.000Z";

  assert.equal(getAccountStatus(stale, NOW), "refresh_required");
});

test("recommendation prefers the account with the strongest remaining capacity", () => {
  const recommended = getRecommendedAccount(
    [
      account("dev-1", 30, 70),
      account("dev-2", 50, 20),
      account("dev-3", 100, 5),
    ],
    NOW,
  );

  assert.equal(recommended?.id, "dev-2");
});

test("weekly exhaustion remains the primary account status after its reset timestamp passes", () => {
  const blocked = account("dev-weekly-stale", 0, 100);
  blocked.fiveHour.resetAt = new Date(NOW + 60 * 60 * 1000).toISOString();
  blocked.weekly.resetAt = new Date(NOW - 60 * 1000).toISOString();

  assert.equal(getWindowState(blocked.weekly, NOW), "exhausted");
  assert.equal(getAccountStatus(blocked, NOW), "weekly_limited");
  assert.equal(recommendationScore(blocked, NOW), Number.NEGATIVE_INFINITY);
});

test("stale reset remains refresh required when the quota is not exhausted", () => {
  const stale = account("dev-stale", 0, 50);
  stale.fiveHour.resetAt = new Date(NOW + 60 * 60 * 1000).toISOString();
  stale.weekly.resetAt = new Date(NOW - 60 * 1000).toISOString();

  assert.equal(getWindowState(stale.weekly, NOW), "refresh_required");
  assert.equal(getAccountStatus(stale, NOW), "refresh_required");
});
