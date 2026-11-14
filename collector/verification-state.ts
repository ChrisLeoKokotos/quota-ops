/**
 * Explicit, fail-closed classification of a provider-owned human verification
 * challenge. This code never solves, clicks, or attempts to bypass a challenge.
 *
 * Browser-side observation returns only these three booleans; neither page
 * text nor cookies, titles, profile paths or challenge tokens leave the page.
 */
export interface ClaudeVerificationSignals {
  titleIsChallenge: boolean;
  visibleChallengePrompt: boolean;
  trustedChallengeFrame: boolean;
}

export function requiresManualClaudeVerification(
  signals: ClaudeVerificationSignals,
): boolean {
  return signals.titleIsChallenge === true ||
    signals.visibleChallengePrompt === true ||
    signals.trustedChallengeFrame === true;
}
