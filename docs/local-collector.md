# Local Multi-Account Collector

QuotaOps is a product created by **SO HOMELY**.

The local collector is an experimental same-PC automation layer for multiple Claude Team accounts.

## Scope

The collector is designed for a setup where several Claude accounts are used on the same Windows PC.

Each QuotaOps account receives a separate persistent Chrome / Edge profile directory under:

```text
%USERPROFILE%\.quotaops\browser-profiles\
```

QuotaOps does not copy browser cookies, passwords, or provider tokens into its own snapshot model.

The collector reads only normalized quota metadata:

- account label;
- 5-hour usage percentage;
- 5-hour reset timestamp;
- weekly usage percentage;
- weekly reset timestamp;
- collection time and health state.

## Network boundary

The collector HTTP service binds only to:

```text
127.0.0.1:4317
```

It is not exposed to the LAN.

The dashboard requests:

```text
GET /health
GET /snapshot
```

CORS is restricted to the local QuotaOps development origins.

The browser profiles themselves still communicate with Claude / Anthropic because that is how the provider usage page is loaded. No SO HOMELY server is involved.

## Setup

Install dependencies first:

```powershell
npm install
```

Create five isolated local account profiles:

```powershell
npm run collector:setup -- bootstrap-five
```

List them:

```powershell
npm run collector:setup -- list
```

For each account, open its isolated browser profile and log in to the intended Claude account:

```powershell
npm run collector:setup -- login dev-1
npm run collector:setup -- login dev-2
npm run collector:setup -- login dev-3
npm run collector:setup -- login dev-4
npm run collector:setup -- login dev-5
```

When the Claude Usage page is visible, return to the terminal and press Enter so QuotaOps can close that setup browser cleanly.

## Run

Start the collector:

```powershell
npm run collector:start
```

In another terminal, start the dashboard:

```powershell
npm run dev
```

Open:

```text
http://localhost:3000
```

The dashboard checks the local collector every 30 seconds. The collector refreshes provider snapshots every five minutes by default.

## Manual fallback

Manual accounts remain supported.

When a collector account successfully syncs, QuotaOps replaces a manual account with the same label to avoid duplicate Dev 1 / Dev 2 entries. Auto-synced accounts are marked as such and their quota values are treated as collector-owned.

## Experimental provider adapter

Claude Team does not currently expose a documented public quota API intended for this QuotaOps use case.

The collector therefore uses an authenticated local browser profile and observes the Usage page's own JSON usage response. This behavior is isolated in the collector adapter because the provider response shape may change without notice.

If the format changes, QuotaOps returns `unsupported` instead of inventing quota values.

## Failure modes

Possible account health states include:

- `ok`;
- `login_required`;
- `unavailable`;
- `unsupported`.

A failed account refresh does not expose credentials and does not make fabricated capacity available.

## Security rules

- Never commit anything under `~/.quotaops/`.
- Never export or upload the collector browser profile directories.
- Never log cookies, tokens, Authorization headers, or provider session state.
- Keep the HTTP collector bound to `127.0.0.1`.
- Treat usage responses as untrusted input.
- Close the interactive setup browser before starting the background collector for that account.
