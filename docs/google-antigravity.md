# Google / Antigravity statusLine integration (preview)

**Status:** Supports manually entered quotas plus automatic, event-driven
Antigravity CLI snapshots via Google's documented statusLine JSON interface.
Optional numeric Token Analytics use a separate explicit consent flag. No
Google credentials, browser sessions, or hidden endpoints are accessed.

## Automatic Antigravity CLI quota collection

1. Register an account and print its hook setup command:

```powershell
npm run collector:setup -- add google google-1 "Antigravity 1"
npm run collector:setup -- google-hook google-1
```

2. Configure the displayed `/statusline` command in the signed-in Antigravity
CLI. This **replaces** any existing custom statusline command. Preserve
existing customizations first and do not install without consent.
3. Trigger a CLI state change. The hook accepts Google JSON on stdin and
writes only sanitized quota windows, plan label, hashed session counters and
numeric token totals beneath `~/.quotaops/google-statusline/`.
4. Run `npm run collector:setup -- collect google-1` to verify the snapshot.
5. Separately opt in to numeric Token Analytics:

```powershell
npm run collector:setup -- tokens-auto enable google-antigravity
```

It is **event-driven**, not a 24/7 background poll. When the CLI is closed
or emits no events for 15 minutes, QuotaOps marks quota availability stale.
Unknown reset times stay unknown. No browser scraping, automated Google login,
private endpoint requests or model switching are implemented.

`remaining_fraction` is converted to used percent; `remaining_amount` with
no denominator is never treated as a percentage. Token analytics uses the
latest monotonic counters per hashed session; local totals are not billing
statements. Cache breakdown from `current_usage` is best-effort and capped
to the newly observed input delta. Raw email, working directories, transcript
paths, prompts, original session IDs, and credentials are never saved.

The hook requires Node.js 22+ and access to the collector runtime files.
The packaged Windows installer does not yet automatically install the hook
in another program's settings; installed-runtime setup needs owner validation.

## Manual fallback

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
- Synthetic automatic statusLine E2E exercises the hook, persistence,
  normalized quotas and token analytics without credentials.
- **Real Google-account E2E remains pending:** no signed-in Antigravity
  session was available in CI or this development environment.

Do not market event-driven Antigravity statusLine as CLI-closed background polling.
