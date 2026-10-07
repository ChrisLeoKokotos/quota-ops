import assert from "node:assert/strict";
import test from "node:test";

import { parseOpenAIUsagePayload } from "../collector/openai-usage-parser.ts";

test("parses ChatGPT Codex primary and secondary rate-limit windows", () => {
  const parsed = parseOpenAIUsagePayload({
    plan_type: "pro",
    rate_limit: {
      primary_window: {
        used_percent: 27,
        reset_at: 1791390000,
      },
      secondary_window: {
        used_percent: 61.5,
        reset_at: 1791817200,
      },
    },
  });

  assert.equal(parsed?.plan, "pro");
  assert.deepEqual(parsed?.windows.map((window) => ({
    id: window.id,
    label: window.label,
    usedPercent: window.usedPercent,
  })), [
    { id: "five-hour", label: "5-hour", usedPercent: 27 },
    { id: "weekly", label: "Weekly", usedPercent: 61.5 },
  ]);
  assert.equal(parsed?.windows[0]?.resetAt, "2026-10-07T19:00:00.000Z");
});

test("accepts camelCase window names", () => {
  const parsed = parseOpenAIUsagePayload({
    plan: "team",
    rateLimit: {
      primaryWindow: {
        used_percent: 10,
        reset_at: 1791390000000,
      },
    },
  });

  assert.equal(parsed?.plan, "team");
  assert.equal(parsed?.windows[0]?.usedPercent, 10);
});

test("rejects payloads without recognized rate-limit windows", () => {
  assert.equal(parseOpenAIUsagePayload({ plan_type: "pro" }), null);
});
