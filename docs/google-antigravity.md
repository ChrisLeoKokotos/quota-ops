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
3. To collect **numeric token counters**, explicitly opt in **before**
   generating any events:

```powershell
npm run collector:setup -- tokens-auto enable google-antigravity
```

   If you do not opt in, the hook still records **quota snapshots only**,
   without adding session counters. Pre-consent token activity is not backfilled.
4. Trigger an Antigravity CLI state change. The hook consumes JSON on stdin and
   stores allowlisted quota windows, reset timestamps and plan data under
   `~/.quotaops/google-statusline/`. Only with prior consent are hashed
   session watermarks and numeric counters retained.
5. Run `npm run collector:setup -- collect google-1` to verify the local quota
   snapshot; use `npm run collector:setup -- tokens` to inspect consented
   numeric analytics. The app refreshes from the local snapshot, not directly
   from Google's servers.

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

The hook requires Node.js 22+ and access to the collector runtime files. Configure one collector account ID for each **known, signed-in CLI context**; the hook does not securely infer or attest the Google identity from an email field.
The packaged Windows installer does not install the hook in another
program's settings. The packaged hook is
`%LOCALAPPDATA%\Programs\QuotaOps\resources\collector-runtime\collector\google-hook.ts`.
On 21 Nov 2026 it was checked with synthetic events: it works with system
Node 22 and with `QuotaOps.exe` in Node mode (`ELECTRON_RUN_AS_NODE=1`). The
printed `/statusline` command calls `node`, so Node.js 22+ must be on `PATH`.
A real signed-in Antigravity CLI using the installed hook has not been tested.

## Consent, retention and deletion

Run `npm run collector:setup -- tokens-auto status` to inspect consent and
`npm run collector:setup -- tokens-auto disable google-antigravity` to stop
new Google numeric token observations. `tokens-auto disable all` disables
all three analytics sources. **Neither command deletes previously saved
numeric counters.** To erase one Google account's local state, exit the
Antigravity CLI hook and stop QuotaOps collection, then delete
`%USERPROFILE%\\.quotaops\\google-statusline\\google-1.json` (replace the
ID). This also deletes that account's last quota snapshot; a new event will
create a fresh quota-only file while consent is off. Deleting the browser's
manual account does not delete this collector file.

The local state is capped (up to 512 KiB per account, at most 512 tracked
sessions and 800 daily buckets). The original JSON, raw session identifiers,
transcripts, prompts and account email are not persisted by the hook. A
hashed session identifier and **numeric** counters are stored only if token
consent was enabled before ingestion. The local machine's own account
permissions remain a residual risk; this is not an encrypted vault.

## Manual fallback

### Why manual entry is still supported

Google documents Antigravity CLI `/usage` (`/quota`) as an interactive
Models & Quota panel. It shows per-model-group remaining quotas, including
five-hour and weekly limits. Google documents a separate statusLine JSON stream for active CLI sessions,
but it does not document a third-party quota polling API for when the CLI is
closed.

- https://antigravity.google/docs/cli/commands/usage/
- https://developers.google.com/gemini-code-assist/docs/deprecations/code-assist-individuals

The old Gemini CLI / Code Assist consumer Google login was deprecated in
June 2026. Do not reuse Google OAuth credentials, query internal endpoints,
parse hidden local authentication files, automate CAPTCHA or emulate
provider identities. The statusLine adapter uses the documented interface; any future CLI-closed
collector still requires a supported data interface and independent review.

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
- `node scripts/google-statusline-e2e.mjs` exercises real hook processes,
  persistence, consent revocation and normalized quotas with synthetic JSON.
- Synthetic automatic statusLine E2E exercises the hook, persistence,
  normalized quotas and token analytics without credentials.
- `node scripts/google-auto-dashboard-e2e.mjs` after `npm run build`
  checks the collector service and trusted dashboard in real Chromium.
- A separate real Chromium browser E2E checks the local collector service,
  authenticated dashboard proxy and auto-synced Google UI.
- CI includes Windows hook-to-collector and packaged desktop smoke tests,
  not an authenticated Google session or verified installed hook.
- **Real Google-account E2E remains pending:** no signed-in Antigravity
  session was available in CI or this development environment.

Do not market event-driven Antigravity statusLine as CLI-closed background polling.
