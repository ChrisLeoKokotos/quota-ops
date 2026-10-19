import assert from "node:assert/strict";
import test from "node:test";
import { parseVisibleClaudeUsagePanel } from "../collector/visible-usage.ts";

const observedPanel = `Your usage limits Team
Current session
Resets in 4 hr 4 min
100% used
Weekly limits
Learn more about usage limits
All models
Resets Fri 11:00 PM
100% used
Limit resets
Full reset
Expires Oct 22
`;

test("accepts the actual labelled Claude Team Usage layout without inventing resets", () => {
  assert.deepEqual(parseVisibleClaudeUsagePanel(observedPanel), {
    fiveHour: { usedPercent: 100, resetAt: null },
    weekly: { usedPercent: 100, resetAt: null },
  });
});

test("reads exact 0% and fractional percentages only when both sections are labelled", () => {
  assert.deepEqual(parseVisibleClaudeUsagePanel(observedPanel
    .replace("100% used", "0% used")
    .replace("Resets Fri 11:00 PM\n100% used", "Resets Fri 11:00 PM\n42.5% used")), {
    fiveHour: { usedPercent: 0, resetAt: null },
    weekly: { usedPercent: 42.5, resetAt: null },
  });
});

test("rejects incomplete login pages and unrelated progress counters", () => {
  assert.equal(parseVisibleClaudeUsagePanel("Login to Claude\n100% used"), null);
  assert.equal(parseVisibleClaudeUsagePanel("Your usage limits Team\nCurrent session\n100% used"), null);
  assert.equal(parseVisibleClaudeUsagePanel(null), null);
});

test("rejects missing usage windows, duplicate values and invalid percentages", () => {
  assert.equal(parseVisibleClaudeUsagePanel(observedPanel.replace("Weekly limits", "Other limits")), null);
  assert.equal(parseVisibleClaudeUsagePanel(observedPanel.replace("All models", "Another model")), null);
  assert.equal(parseVisibleClaudeUsagePanel(observedPanel.replace("Current session", "Current session\n99% used")), null);
  assert.equal(parseVisibleClaudeUsagePanel(observedPanel.replace("100% used", "101% used")), null);
  assert.equal(parseVisibleClaudeUsagePanel(observedPanel.replace("100% used", "-1% used")), null);
});

test("does not borrow a percentage from a different weekly model or reset panel", () => {
  assert.equal(parseVisibleClaudeUsagePanel(
    observedPanel.replace("All models\nResets Fri 11:00 PM\n100% used", "All models\nResets Fri 11:00 PM")),
    null);
});

test("rejects excessive input rather than scanning arbitrary private page text", () => {
  assert.equal(parseVisibleClaudeUsagePanel(observedPanel + "x".repeat(4096)), null);
});
