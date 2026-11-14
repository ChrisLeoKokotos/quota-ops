import assert from "node:assert/strict";
import test from "node:test";
import { requiresManualClaudeVerification } from "../collector/verification-state.ts";

test("provider verification is explicit only when challenge evidence exists", () => {
  assert.equal(requiresManualClaudeVerification({
    titleIsChallenge: true,
    visibleChallengePrompt: false,
    trustedChallengeFrame: false,
  }), true);
  assert.equal(requiresManualClaudeVerification({
    titleIsChallenge: false,
    visibleChallengePrompt: true,
    trustedChallengeFrame: false,
  }), true);
  assert.equal(requiresManualClaudeVerification({
    titleIsChallenge: false,
    visibleChallengePrompt: false,
    trustedChallengeFrame: true,
  }), true);
  assert.equal(requiresManualClaudeVerification({
    titleIsChallenge: false,
    visibleChallengePrompt: false,
    trustedChallengeFrame: false,
  }), false);
});

test("a normal page is not incorrectly classified as a human verification", () => {
  assert.equal(requiresManualClaudeVerification({
    titleIsChallenge: false,
    visibleChallengePrompt: false,
    trustedChallengeFrame: false,
  }), false);
});
