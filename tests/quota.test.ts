import assert from "node:assert/strict";
import test from "node:test";

import {
  getAccountStatus,
  getRecommendedAccount,
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
