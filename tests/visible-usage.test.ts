import assert from "node:assert/strict";
import test from "node:test";
import { parseVisibleClaudeUsagePanel, selectClaudeUsageSource } from "../collector/visible-usage.ts";

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

test("uses API data without attempting a DOM fallback", async () => {
  const api = parseVisibleClaudeUsagePanel(observedPanel);
  assert.ok(api);
  let reads = 0;
  const selected = await selectClaudeUsageSource(api, null, async () => {
    reads++;
    return null;
  });
  assert.equal(selected.source, "api");
  assert.deepEqual(selected.usage, api);
  assert.equal(reads, 0);
});

test("uses a strict visible panel only if the expected API was not observed", async () => {
  const panel = parseVisibleClaudeUsagePanel(observedPanel);
  assert.ok(panel);
  let reads = 0;
  const selected = await selectClaudeUsageSource(
    null, "claude_page_api_not_observed", async () => {
      reads++;
      return panel;
    },
  );
  assert.equal(selected.source, "visible");
  assert.deepEqual(selected.usage, panel);
  assert.equal(reads, 1);
});

test("an ambiguous API organization never triggers a fallback to possibly wrong quota", async () => {
  let reads = 0;
  const selected = await selectClaudeUsageSource(
    null, "usage_org_ambiguous", async () => {
      reads++;
      return parseVisibleClaudeUsagePanel(observedPanel);
    },
  );
  assert.deepEqual(selected, { usage: null, source: null });
  assert.equal(reads, 0);
});

test("an invalid or failed visible page remains unknown, never 0%", async () => {
  const invalid = await selectClaudeUsageSource(
    null, "claude_page_api_not_observed", async () => null,
  );
  assert.deepEqual(invalid, { usage: null, source: null });
  const failed = await selectClaudeUsageSource(
    null, "usage_response_not_observed", async () => {
      throw new Error("simulated browser failure");
    },
  );
  assert.deepEqual(failed, { usage: null, source: null });
});
