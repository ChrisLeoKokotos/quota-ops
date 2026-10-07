# Local Multi-Account Collector

QuotaOps is a product created by **SO HOMELY**.

This document is the canonical setup and operations guide for the current same-PC Claude Team collector.

## What the collector does

QuotaOps can track several Claude accounts on one Windows PC without combining their browser sessions.

Each account gets its own persistent Chrome / Edge profile under:

```text
%USERPROFILE%\.quotaops\browser-profiles\
```

The collector keeps only normalized capacity metadata in its snapshot model:

- account id and display label;
- 5-hour usage percentage;
- 5-hour reset timestamp when the provider supplies one;
- weekly usage percentage;
- weekly reset timestamp;
- collection time and health state.

Provider login state remains inside the isolated browser profile. QuotaOps does not copy provider passwords, cookies, or provider access credentials into collector snapshots.

## Requirements

Recommended environment:

- Windows 11;
- Node.js 22.21.0;
- current Google Chrome or Microsoft Edge;
- one or more Claude accounts that can open `Settings > Usage`.

Install the repository dependencies from the committed lockfile:

```powershell
npm ci --ignore-scripts --no-audit --no-fund
```

## First-time setup

Create the default five account profiles:

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

Connect accounts one at a time.

For Dev 1:

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
    "plan": "team",
    "fiveHour": {
      "usedPercent": 0,
      "resetAt": null
    },
    "weekly": {
      "usedPercent": 42,
      "resetAt": "2026-10-10T12:00:00.000Z"
    }
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
http://localhost:3000
```

The dashboard polls the local collector every 30 seconds.

The collector refreshes enabled provider profiles every five minutes by default and processes accounts sequentially.

## Visible login vs hidden scheduled refresh

Interactive login is intentionally visible because provider authentication and verification must remain user-controlled.

Scheduled Windows collection is different: QuotaOps starts the locally installed Chrome / Edge against the isolated profile in hidden/headless mode, attaches through an ephemeral DevTools listener bound to `127.0.0.1`, reads the Usage response, then closes the browser process.

Scheduled refresh should therefore not open five visible browser windows every cycle.

If Claude requires a fresh login, run the explicit `login <id>` command again. QuotaOps does not bypass provider authentication.

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
npm run collector:setup -- add <id> <label>
npm run collector:setup -- login <id>
npm run collector:setup -- collect <id>
npm run collector:setup -- enable <id> [id...]
npm run collector:setup -- disable <id> [id...]
npm run collector:setup -- security-check
npm run collector:setup -- rotate-token
npm run collector:start
```

Examples:

```powershell
npm run collector:setup -- collect dev-3
npm run collector:setup -- disable dev-4 dev-5
npm run collector:setup -- enable dev-4 dev-5
```

## Collector health states

Possible per-account statuses are:

- `ok` — normalized usage was collected;
- `login_required` — the isolated profile needs normal provider authentication;
- `unsupported` — the Usage page loaded but the expected provider response could not be recognized;
- `unavailable` — the local browser collection path could not complete.

QuotaOps fails closed: a failed refresh does not invent capacity.

## Network boundary

The collector HTTP service binds only to:

```text
127.0.0.1:4317
```

It is not intended to be reachable from the LAN.

The collector API requires a random local bearer token stored under the protected QuotaOps home directory. The token stays server-side. Browser JavaScript talks to the Next.js same-origin route, which proxies the normalized snapshot to the loopback collector.

The temporary Windows DevTools listener used for scheduled collection is also bound to `127.0.0.1` and exists only for the lifetime of that collection browser.

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

If it returns `unsupported`, open that isolated profile with `login <id>` and confirm `Settings > Usage` is available. Provider response formats are not treated as a stable public API and can change.

If it returns `unavailable`, confirm Chrome or Edge is installed and current, close any stale isolated profile window, then retry.

If the dashboard shows `Manual fallback`, confirm `npm run collector:start` is still running.

If port `4317` is already in use, stop the older collector process before starting another instance.

Do not attempt to bypass provider verification or anti-bot checks.

## Current validation status

The current Windows MVP has been exercised end to end with five isolated Claude profiles:

- each account passed individual `collect <id>` validation;
- all five accounts were enabled together;
- all five appeared as auto-synced in the dashboard;
- the collector remained local-first and returned normalized quota metadata.

The collector remains experimental because the Claude web Usage response is not a documented public quota API. Session-expiry handling, token rotation, LAN-isolation verification, and hidden scheduled-refresh behavior remain release-gate checks before calling the collector fully production-ready.

See [local-collector-threat-model.md](local-collector-threat-model.md) for the formal trust boundaries and residual risks.
