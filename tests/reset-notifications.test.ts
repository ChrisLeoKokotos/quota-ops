import assert from "node:assert/strict";
import test from "node:test";

import { getDueResetEvents } from "../lib/reset-notifications.ts";
import type { QuotaAccount } from "../lib/quota.ts";

const NOW = Date.parse("2026-10-06T12:00:00.000Z");

function account(resetAt: string): QuotaAccount {
  return {
    id: "dev-1",
    label: "Dev 1",
    provider: "claude",
    plan: "Team",
    windows: [
      {
        id: "five-hour",
        label: "5-hour",
        usedPercent: 100,
        resetAt,
      },
      {
        id: "weekly",
        label: "Weekly",
        usedPercent: 50,
        resetAt: "2026-10-08T12:00:00.000Z",
      },
    ],
    updatedAt: "2026-10-06T11:00:00.000Z",
  };
}

test("returns a reset event when the reset just became due", () => {
  const events = getDueResetEvents(
    [account("2026-10-06T11:59:30.000Z")],
    NOW,
    new Set(),
  );

  assert.equal(events.length, 1);
  assert.equal(events[0]?.windowId, "five-hour");
  assert.equal(events[0]?.windowLabel, "5-hour");
});

test("does not repeat a reset event that was already seen", () => {
  const resetAt = "2026-10-06T11:59:30.000Z";
  const key = `dev-1:five-hour:${resetAt}`;

  const events = getDueResetEvents(
    [account(resetAt)],
    NOW,
    new Set([key]),
  );

  assert.equal(events.length, 0);
});

test("ignores stale reset timestamps outside the notification grace window", () => {
  const events = getDueResetEvents(
    [account("2026-10-06T11:30:00.000Z")],
    NOW,
    new Set(),
  );

  assert.equal(events.length, 0);
});
