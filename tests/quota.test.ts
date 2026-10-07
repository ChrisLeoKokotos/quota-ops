import assert from "node:assert/strict";
import test from "node:test";

import {
  getAccountStatus,
  getRecommendedAccount,
  getWindowState,
  recommendationScore,
  type Provider,
  type QuotaAccount,
} from "../lib/quota.ts";

const NOW = Date.parse("2026-10-06T00:00:00.000Z");

function account(
  id: string,
  fiveHourUsed: number,
  weeklyUsed: number,
  provider: Provider = "claude",
): QuotaAccount {
  return {
    id,
    label: id,
    provider,
    plan: provider === "claude" ? "Team" : "ChatGPT",
    windows: [
      {
        id: "five-hour",
        label: "5-hour",
        usedPercent: fiveHourUsed,
        resetAt: "2026-10-06T04:00:00.000Z",
      },
      {
        id: "weekly",
        label: "Weekly",
        usedPercent: weeklyUsed,
        resetAt: "2026-10-10T12:00:00.000Z",
      },
    ],
    updatedAt: "2026-10-06T00:00:00.000Z",
  };
}

test("one exhausted window limits an account", () => {
  assert.equal(getAccountStatus(account("dev-1", 40, 100), NOW), "limited");
});

test("all exhausted windows mark an account exhausted", () => {
  assert.equal(getAccountStatus(account("dev-2", 100, 100), NOW), "exhausted");
});

test("missing reset timestamps require setup instead of stale-refresh messaging", () => {
  const incomplete = account("dev-setup", 0, 20);
  incomplete.windows[0]!.resetAt = null;

  assert.equal(getAccountStatus(incomplete, NOW), "needs_setup");
});

test("collector zero-usage windows may omit a reset without requiring setup", () => {
  const synced = account("dev-collector", 0, 10);
  synced.source = "collector";
  synced.windows[0]!.resetAt = null;

  assert.equal(getAccountStatus(synced, NOW), "available");
  assert.ok(Number.isFinite(recommendationScore(synced, NOW)));
});

test("collector nonzero windows still require a reset timestamp", () => {
  const incomplete = account("dev-collector-incomplete", 25, 10);
  incomplete.source = "collector";
  incomplete.windows[0]!.resetAt = null;

  assert.equal(getAccountStatus(incomplete, NOW), "needs_setup");
});

test("expired reset timestamps require refresh instead of inventing capacity", () => {
  const stale = account("dev-3", 60, 60);
  stale.windows[0]!.resetAt = "2026-10-05T23:00:00.000Z";

  assert.equal(getAccountStatus(stale, NOW), "refresh_required");
});

test("recommendation prefers the account with the strongest remaining capacity", () => {
  const recommended = getRecommendedAccount(
    [
      account("dev-1", 30, 70),
      account("dev-2", 50, 20, "openai"),
      account("dev-3", 100, 5),
    ],
    NOW,
  );

  assert.equal(recommended?.id, "dev-2");
});

test("exhaustion remains primary after its reset timestamp passes", () => {
  const blocked = account("dev-weekly-stale", 0, 100);
  blocked.windows[0]!.resetAt = new Date(NOW + 60 * 60 * 1000).toISOString();
  blocked.windows[1]!.resetAt = new Date(NOW - 60 * 1000).toISOString();

  assert.equal(getWindowState(blocked.windows[1]!, NOW), "exhausted");
  assert.equal(getAccountStatus(blocked, NOW), "limited");
  assert.equal(recommendationScore(blocked, NOW), Number.NEGATIVE_INFINITY);
});

test("stale reset remains refresh required when the quota is not exhausted", () => {
  const stale = account("dev-stale", 0, 50);
  stale.windows[0]!.resetAt = new Date(NOW + 60 * 60 * 1000).toISOString();
  stale.windows[1]!.resetAt = new Date(NOW - 60 * 1000).toISOString();

  assert.equal(getWindowState(stale.windows[1]!, NOW), "refresh_required");
  assert.equal(getAccountStatus(stale, NOW), "refresh_required");
});

test("generic providers can expose more than two quota windows", () => {
  const multi = account("openai-extra", 20, 30, "openai");
  multi.windows.push({
    id: "model-special",
    label: "Model special",
    usedPercent: 40,
    resetAt: "2026-10-07T12:00:00.000Z",
  });

  assert.equal(getAccountStatus(multi, NOW), "available");
  assert.ok(Number.isFinite(recommendationScore(multi, NOW)));
});
