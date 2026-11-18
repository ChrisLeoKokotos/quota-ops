/**
 * Explicit, fail-closed classification of a provider-owned human verification
 * challenge. This code never solves, clicks, or attempts to bypass a challenge.
 *
 * Only booleans leave this module; page text, titles, cookies, profile paths,
 * frame URLs and challenge tokens are examined in-process and discarded.
 *
 * Issue #49: the first detector relied on English page text and on
 * `iframe[src]` in the light DOM. On a Greek Windows install Claude's
 * challenge page is titled "Περιμένετε..." and its Turnstile frame is not a
 * light-DOM `iframe[src]`, so a real challenge was reported as
 * `unsupported / claude_page_api_not_observed`. The signals below are
 * language-independent and come from the browser, not from page text.
 */
export interface ClaudeVerificationSignals {
  /** English challenge title (kept; language-dependent). */
  titleIsChallenge: boolean;
  /** English challenge prompt text (kept; language-dependent). */
  visibleChallengePrompt: boolean;
  /** A frame, light DOM or not, served by challenges.cloudflare.com. */
  trustedChallengeFrame: boolean;
  /** The page itself is a challenge interstitial location. */
  challengeLocation?: boolean;
  /** A navigation response was marked `cf-mitigated: challenge`. */
  challengeResponse?: boolean;
}

export function requiresManualClaudeVerification(
  signals: ClaudeVerificationSignals,
): boolean {
  return signals.titleIsChallenge === true ||
    signals.visibleChallengePrompt === true ||
    signals.trustedChallengeFrame === true ||
    signals.challengeLocation === true ||
    signals.challengeResponse === true;
}

/** https://challenges.cloudflare.com/... (exact host, HTTPS only). */
export function isTrustedChallengeFrameUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.hostname === "challenges.cloudflare.com";
  } catch {
    return false;
  }
}

/** Claude's own challenge interstitial, independent of display language. */
export function isClaudeChallengeLocation(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.hostname !== "claude.ai") return false;
    return parsed.pathname.startsWith("/api/challenge_redirect") ||
      [...parsed.searchParams.keys()].some((key) => key.startsWith("__cf_chl_"));
  } catch {
    return false;
  }
}

/** Cloudflare marks challenge responses with `cf-mitigated: challenge`. */
export function isChallengeResponseHeader(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().toLowerCase() === "challenge";
}
