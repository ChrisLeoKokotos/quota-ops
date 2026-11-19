# Google / Antigravity manual integration (preview)

**Status:** Supported for locally entered quotas only. There is no automated
Google account collector, provider sign-in or Google Token Analytics in
this release candidate. No Google credentials are requested or read.

## Why this is manual

Google documents Antigravity CLI `/usage` (`/quota`) as an interactive
Models & Quota panel. It shows per-model-group remaining quotas, including
five-hour and weekly limits. Google does not document a machine-readable
third-party source for this panel in the reviewed documentation.

- https://antigravity.google/docs/cli/commands/usage/
- https://developers.google.com/gemini-code-assist/docs/deprecations/code-assist-individuals

The old Gemini CLI / Code Assist consumer Google login was deprecated in
June 2026. Do not reuse Google OAuth credentials, query internal endpoints,
parse hidden local authentication files, automate CAPTCHA or emulate
provider identities. A supported future Google adapter requires a documented
data interface and an independent security review.

## Use it

1. In Antigravity CLI, open `/usage` in your own signed-in session.
2. In QuotaOps, click **Add account** → **Google / Antigravity (manual)**.
3. Enter an account label and the model group shown in the CLI.
4. Enter **used percent** for its 5-hour and weekly quota windows. If the
   CLI shows remaining percent, subtract it from 100. Enter the reset
   timestamps only when displayed. Unknown reset stays blank; QuotaOps
   must show `Needs setup` instead of assuming available capacity.
5. To follow another group (for example Gemini Flash as well as Gemini
   Pro), use **Add model group** on the Google account card, then edit the
   new group's quota windows.

The values remain in the browser's local dashboard state and are labelled
`manual`; they are not automatically refreshed. Other provider collectors
still run independently.

## Validation

- `npm test`: Google provider labels, normalization, distinct model
  windows, unknown reset fail-closed, and recommendation integration.
- `node scripts/google-dashboard-e2e.mjs` **after `npm run build`**:
  browser-based, local UI flow through adding two model groups, persistence
  after reload, and manual provenance. Uses synthetic values and no Google
  sessions. Run with a temporary HOME, not an active installed QuotaOps home.
- A **real Google usage-collection E2E does not exist**: Google has not
  documented the automated source required for that claim.

Do not market this manual preview as automatic Gemini / Antigravity sync.
