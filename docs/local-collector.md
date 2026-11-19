# Local Multi-Account Collector

QuotaOps is a product created by **SO HOMELY**.

This document is the canonical setup and operations guide for the current same-PC multi-provider collector.

## What the collector does

QuotaOps can track several Claude, OpenAI/Codex and Google/Antigravity accounts on one PC. **Claude and OpenAI** use isolated browser sessions; **Google** uses CLI `statusLine` events instead of a browser login. Google account labels in the local config do not independently attest which signed-in Google identity emitted an event.

Each Claude/OpenAI account gets its own persistent Chrome / Edge profile under:

```text
%USERPROFILE%\.quotaops\browser-profiles\
```

The collector snapshot contains normalized capacity metadata plus locally observed token aggregates:

- account id, display label, provider, and plan label;
- one or more named quota windows;
- usage percentage and reset timestamp for each quota window;
- collection time and health state;
- local Token Analytics totals, daily buckets, provider totals, and source health.

Claude/OpenAI authentication stays inside each browser profile. Google authentication stays inside the provider CLI. QuotaOps neither reads Google credentials nor copies provider passwords, cookies or access tokens into collector snapshots.

## Requirements

Recommended environment:

- Windows 11;
- Node.js 22.21.0;
- current Google Chrome or Microsoft Edge;
- one or more Claude accounts with `Settings > Usage` and/or ChatGPT accounts with Codex quota available;
- optionally, an authenticated Antigravity CLI with the `statusLine` feature for Google event collection. No browser is needed for the Google hook itself.

Install the repository dependencies from the committed lockfile:

```powershell
npm ci --ignore-scripts --no-audit --no-fund
```

## Token Analytics privacy opt-in

Background scans of local Claude Code and Codex session histories are **off by default**, including existing collector configurations migrated to this version. Session history can contain private prompts, responses and source code; only numeric usage aggregates belong in QuotaOps snapshots.

To opt in to **one source at a time**:

```powershell
npm run collector:setup -- tokens-auto enable claude-code
npm run collector:setup -- tokens-auto enable codex
npm run collector:setup -- tokens-auto enable google-antigravity
```

Run `npm run collector:setup -- tokens-auto status` to review consent, or
`npm run collector:setup -- tokens-auto disable all` to revoke it for all
three. The no-scope `enable` command enables **only Claude Code and Codex**;
it never silently enables Google. The `tokens` command reads only consented
sources. Disabling stops future observation but does not delete previously
stored `google-statusline` counters; see [PRIVACY.md](../PRIVACY.md) for
local deletion. Google quota collection is independent of this token consent.
To count Google tokens from a session, enable consent **before** its first
statusLine event; pre-consent events are not recovered automatically.

## First-time setup

Optionally create **five default Claude** accounts (not a global account limit):

```powershell
npm run collector:setup -- bootstrap-five
```

Run the local security check:

```powershell
npm run collector:setup -- security-check
```

List the configured profiles:

```powershell
npm run collector:setup -- list
```

A configured account is either `enabled` or `disabled`. Disabled accounts remain configured locally but are skipped by the background collector.

## Connect an account

Connect Claude/OpenAI browser accounts one at a time. **Do not use `login` for Google**: follow the [Antigravity CLI hook setup](google-antigravity.md) instead.

For Claude Dev 1:

```powershell
npm run collector:setup -- login dev-1
```

QuotaOps opens the isolated system-browser profile for that account. Complete Claude's normal login and any provider verification in that browser.

When `Settings > Usage` is visible:

1. close that isolated browser window completely;
2. return to PowerShell;
3. press Enter.

QuotaOps does not ask for the password in the terminal.

Repeat with `dev-2`, `dev-3`, and so on as needed.

## Verify one account before enabling it

After login, test the account directly:

```powershell
npm run collector:setup -- collect dev-1
```

A successful result contains:

```json
{
  "id": "dev-1",
  "status": "ok",
  "account": {
    "provider": "claude",
    "plan": "Team",
    "windows": [
      {
        "id": "five-hour",
        "label": "5-hour",
        "usedPercent": 0,
        "resetAt": null
      },
      {
        "id": "weekly",
        "label": "Weekly",
        "usedPercent": 42,
        "resetAt": "2026-10-10T12:00:00.000Z"
      }
    ]
  }
}
```

A 5-hour window may legitimately return `0%` with `resetAt: null` when no active 5-hour reset is exposed by the provider.

## Enable and disable accounts

Enable an account after its individual collection test succeeds:

```powershell
npm run collector:setup -- enable dev-1
```

Disable one or more accounts:

```powershell
npm run collector:setup -- disable dev-2 dev-3 dev-4 dev-5
```

Enable several accounts:

```powershell
npm run collector:setup -- enable dev-2 dev-3
```

Check the final state:

```powershell
npm run collector:setup -- list
```

For a five-account setup, the target state is `dev-1` through `dev-5` all marked `enabled`.

## Run QuotaOps

Start the collector in one PowerShell window:

```powershell
npm run collector:start
```

Start the dashboard in a second window:

```powershell
npm run dev
```

Open:

```text
the URL the start command prints (an OS-allocated loopback port)
```

The dashboard polls the local collector every 30 seconds.

The scheduler checks enabled account snapshots every five minutes by default and processes them sequentially. Claude/OpenAI checks may launch headless browsers. Google checks read the most recent sanitized local statusLine event; Google CLI state is generated independently when that CLI is active.

## Visible login vs hidden scheduled refresh

Interactive login is intentionally visible because provider authentication and verification must remain user-controlled.

Background Claude/OpenAI collection runs **headless** (not off-screen/minimized); provider human-verification challenges are not bypassed. The tray offers a consented visible refresh and a manual verification path. Claude collection observes the Usage-page response; OpenAI uses the authenticated ChatGPT browser context for Codex quota metadata without returning the provider token in the snapshot. Google collection does not launch Chrome or Edge: its CLI invokes a locally configured `statusLine` hook; QuotaOps then reads only sanitized quota state. A Google event older than **15 minutes** or without recognized quota buckets is `unavailable`, never a fabricated fresh sync.

If Claude/OpenAI requires a fresh login, run explicit `login <id>` and complete provider authentication. Google sign-in is performed directly in Antigravity CLI; `login google-1` is intentionally unsupported. QuotaOps does not bypass provider authentication.

## Local account details

The dashboard lets you maintain local display metadata for every account.

You can edit:

- display name;
- optional email address.

These values are local QuotaOps metadata. The email is not fetched from Claude and is not required for quota collection.

Custom display name and email are preserved across collector refreshes while usage and reset data remain collector-owned.

## Command reference

```text
npm run collector:setup -- bootstrap-five
npm run collector:setup -- list
npm run collector:setup -- add <provider> <id> <label>
npm run collector:setup -- login <id>
npm run collector:setup -- collect <id>
npm run collector:setup -- tokens
npm run collector:setup -- tokens-auto <enable|disable|status> [claude-code|codex|google-antigravity|all]
npm run collector:setup -- google-hook <id>
npm run collector:setup -- enable <id> [id...]
npm run collector:setup -- disable <id> [id...]
npm run collector:setup -- security-check
npm run collector:setup -- rotate-token
npm run collector:start
```

Examples:

```powershell
npm run collector:setup -- collect dev-3
npm run collector:setup -- add openai openai-1 "OpenAI 1"
npm run collector:setup -- login openai-1
npm run collector:setup -- collect openai-1
npm run collector:setup -- enable openai-1
npm run collector:setup -- add google google-1 "Antigravity 1"
npm run collector:setup -- google-hook google-1
npm run collector:setup -- collect google-1
npm run collector:setup -- tokens-auto enable google-antigravity
```

## Collector health states

Possible per-account statuses are:

- `ok` — normalized usage was collected;
- `login_required` — the isolated profile needs normal provider authentication;
- `unsupported` — the Usage page loaded but the expected provider response could not be recognized;
- `verification_required` — a Claude browser challenge needs human attention;
- `unavailable` — local browser collection failed **or** Google statusLine state is absent, stale or has no usable quota buckets.

QuotaOps fails closed: a failed refresh does not invent capacity.

## Network boundary

The collector HTTP service binds only to:

```text
127.0.0.1:4317
```

It is not intended to be reachable from the LAN.

The collector API requires a random local bearer token stored under the protected QuotaOps home directory. The token stays server-side. Browser JavaScript talks to the Next.js same-origin route, which proxies the normalized snapshot to the loopback collector.

Scheduled Claude browser collection now uses Playwright's private browser transport instead of a Chrome DevTools TCP listener. This path still requires real Windows E2E validation before stable release.

## Local files

QuotaOps collector state lives under:

```text
%USERPROFILE%\.quotaops\
```

Important paths include:

```text
%USERPROFILE%\.quotaops\collector.json
%USERPROFILE%\.quotaops\collector.token
%USERPROFILE%\.quotaops\browser-profiles\dev-1
%USERPROFILE%\.quotaops\browser-profiles\dev-2
%USERPROFILE%\.quotaops\google-statusline\google-1.json
...
```

Do not commit or upload the `.quotaops` directory or browser profiles.

## Security hardening

Run:

```powershell
npm run collector:setup -- security-check
```

On Windows, QuotaOps hardens its local home directory with ACLs for the current Windows identity, SYSTEM, and local Administrators.

On Unix-like systems, protected directories use mode `0700` and token/config files use mode `0600`.

To rotate the local collector credential:

```powershell
npm run collector:setup -- rotate-token
```

Restart both the collector and Next.js server after token rotation.

## Troubleshooting

If `collect <id>` returns `login_required`, run `login <id>` and complete normal provider authentication.

If it returns `unsupported`, open that isolated profile with `login <id>`. For Claude, confirm `Settings > Usage` is available. For OpenAI, confirm chatgpt.com is signed in and the account has Codex quota available. Provider response formats are not treated as stable public APIs and can change.

If Claude/OpenAI returns `unavailable`, confirm Chrome/Edge is current and close stale isolated profile windows. If Google returns `unavailable`, verify the signed-in Antigravity CLI has the correct `/statusline` command, emitted a recent event, and exposed quota buckets; Chrome/Edge is not part of that path.

For Token Analytics verification, run `npm run collector:setup -- tokens`. The result is explicitly locally observed and can differ from provider-wide billing or account totals.

If the dashboard shows `Manual fallback`, confirm `npm run collector:start` is still running.

If port `4317` is already in use, stop the older collector process before starting another instance.

Do not attempt to bypass provider verification or anti-bot checks.

## Current validation status (PR #50 candidate, 19–20 Nov 2026)

The GitHub CI has passed TypeScript, unit tests, production build, Windows security checks, the statusLine hook-to-collector E2E on Windows, and a synthetic Google event → collector → dashboard → Chrome E2E. The Windows signing run uses a **throwaway test certificate** and is not approval for a public release.

- **Google:** synthetic integration passes, but real signed-in Antigravity CLI collection, installed hook configuration, multi-account identity binding, and packaged-Windows end-to-end behavior are **not yet validated**.
- **Claude:** historical five-profile evidence exists, but the newer headless build encountered Cloudflare/human verification; the final five real signed-in profiles remain an **owner-run blocker**.
- **OpenAI/Codex:** parser and CI tests pass; authenticated end-to-end quota collection on the release candidate must still be confirmed.
- **All providers:** 24-hour real-account soak, independent security review and release-signing checks remain outstanding.

The provider adapters and Google CLI event shapes can change. Do not equate green synthetic tests with proven reliability on real authenticated accounts.

See [token-analytics.md](token-analytics.md) for token counting semantics and [local-collector-threat-model.md](local-collector-threat-model.md) for the formal trust boundaries and residual risks.

Historical test reports describe their *as-of dates*; use [the current Draft PR #50](https://github.com/ChrisLeoKokotos/quota-ops/pull/50) and [release gates](release/v0.2.0-readiness-report.md) for the current candidate rather than treating old results as new evidence.
