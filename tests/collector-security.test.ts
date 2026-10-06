import assert from "node:assert/strict";
import test from "node:test";

import {
  collectorTokenMatches,
  isPathWithin,
  isValidCollectorToken,
} from "../collector/security.ts";

test("accepts paths contained within the protected root", () => {
  assert.equal(
    isPathWithin("C:/Users/chris/.quotaops/browser-profiles", "C:/Users/chris/.quotaops/browser-profiles/dev-1"),
    true,
  );
});

test("rejects paths escaping the protected root", () => {
  assert.equal(
    isPathWithin("C:/Users/chris/.quotaops/browser-profiles", "C:/Users/chris/AppData"),
    false,
  );
});

test("collector tokens must have the expected base64url shape", () => {
  const valid = "A".repeat(43);
  assert.equal(isValidCollectorToken(valid), true);
  assert.equal(isValidCollectorToken("short"), false);
});

test("collector token comparison requires an exact match", () => {
  const token = "A".repeat(43);
  assert.equal(collectorTokenMatches(token, token), true);
  assert.equal(collectorTokenMatches(token, "B".repeat(43)), false);
});
