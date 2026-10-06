import assert from "node:assert/strict";
import test from "node:test";

import {
  parseClaudeUsagePayload,
} from "../collector/usage-parser.ts";

test("parses five-hour and weekly Claude usage windows", () => {
  const parsed = parseClaudeUsagePayload({
    five_hour: {
      utilization: 37.5,
      resets_at: "2026-10-06T15:00:00.000Z",
    },
    seven_day: {
      utilization: 88,
      resets_at: "2026-10-10T12:00:00.000Z",
    },
  });

  assert.deepEqual(parsed, {
    fiveHour: {
      usedPercent: 37.5,
      resetAt: "2026-10-06T15:00:00.000Z",
    },
    weekly: {
      usedPercent: 88,
      resetAt: "2026-10-10T12:00:00.000Z",
    },
  });
});

test("accepts a structured limits response", () => {
  const parsed = parseClaudeUsagePayload({
    limits: [
      {
        kind: "session",
        percent: 15,
        reset_at: "2026-10-06T16:00:00Z",
      },
      {
        kind: "weekly_all",
        percent: 55,
        reset_at: "2026-10-11T16:00:00Z",
      },
    ],
  });

  assert.equal(parsed?.fiveHour.usedPercent, 15);
  assert.equal(parsed?.weekly.usedPercent, 55);
});

test("rejects unrelated JSON", () => {
  assert.equal(parseClaudeUsagePayload({ hello: "world" }), null);
});
