import assert from "node:assert/strict";
import test from "node:test";
import {
  isChallengeResponseHeader,
  isClaudeChallengeLocation,
  isTrustedChallengeFrameUrl,
  requiresManualClaudeVerification,
} from "../collector/verification-state.ts";

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

// Issue #49 regression: reproduced on a Greek Windows install with an
// anonymous automated session. The page was claude.ai/api/challenge_redirect,
// titled "Περιμένετε...", with a challenges.cloudflare.com frame that the
// light-DOM iframe[src] query did not see. The English-text signals were all
// false, so a real challenge was reported as unsupported.
test("a localized challenge is detected from browser-side signals alone", () => {
  const localized = {
    titleIsChallenge: false,
    visibleChallengePrompt: false,
    trustedChallengeFrame: false,
  };
  assert.equal(requiresManualClaudeVerification(localized), false);
  assert.equal(requiresManualClaudeVerification({
    ...localized,
    challengeLocation: isClaudeChallengeLocation("https://claude.ai/api/challenge_redirect?to=%2Fsettings%2Fusage"),
  }), true);
  assert.equal(requiresManualClaudeVerification({
    ...localized,
    trustedChallengeFrame: isTrustedChallengeFrameUrl("https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/if/ov2/av0/rcv0/0/abc/light/normal"),
  }), true);
  assert.equal(requiresManualClaudeVerification({
    ...localized,
    challengeResponse: isChallengeResponseHeader("challenge"),
  }), true);
});

test("challenge helpers accept only the exact provider hosts and markers", () => {
  assert.equal(isClaudeChallengeLocation("https://claude.ai/settings/usage"), false);
  assert.equal(isClaudeChallengeLocation("https://claude.ai/settings/usage?__cf_chl_tk=x"), true);
  assert.equal(isClaudeChallengeLocation("https://claude.ai.evil.example/api/challenge_redirect"), false);
  assert.equal(isClaudeChallengeLocation("http://claude.ai/api/challenge_redirect"), false);
  assert.equal(isTrustedChallengeFrameUrl("https://challenges.cloudflare.com.evil.example/x"), false);
  assert.equal(isTrustedChallengeFrameUrl("http://challenges.cloudflare.com/x"), false);
  assert.equal(isTrustedChallengeFrameUrl("not a url"), false);
  assert.equal(isChallengeResponseHeader(undefined), false);
  assert.equal(isChallengeResponseHeader(" Challenge "), true);
  assert.equal(isChallengeResponseHeader("managed"), false);
});
