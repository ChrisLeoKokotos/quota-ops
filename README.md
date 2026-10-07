# QuotaOps

Open-source quota, capacity, and local token-usage visibility for AI workflows.

**QuotaOps is a product created by SO HOMELY.**

QuotaOps gives people and teams one local workspace for AI-account capacity, reset windows, and locally observed token activity instead of checking providers and local tooling separately.

## Current product state

QuotaOps is currently a local-first MVP with support for **Claude / Anthropic** and **OpenAI / ChatGPT Codex**.

Today it supports:

- manual and collector-synced AI account entries;
- provider-neutral quota windows with usage percentages and exact reset timestamps;
- live reset countdowns;
- account states such as Available, Low capacity, At limit, Max usage, Needs setup, and Refresh required;
- best-capacity recommendations and contextual attention items;
- experimental same-PC automatic collection for Claude and OpenAI accounts through isolated local browser profiles;
- local Token Analytics from Claude Code and Codex session logs;
- total token activity with Input, Output, Cache read, and Cache write breakdowns;
- Today, 7 days, 30 days, and All time token views;
- per-provider token totals for Claude and OpenAI;
- browser / OS reset notifications while QuotaOps is running and permission is granted;
- optional browser voice input for quick manual usage updates;
- keyboard shortcuts;
- light and dark themes;
- browser-local persistence for non-secret dashboard metadata.

There is **no hosted QuotaOps backend, hosted database, QuotaOps account system, or cloud sync** in the current MVP. The optional collector runs on the same PC and binds only to `127.0.0.1`.

## Capacity vs Token Analytics

QuotaOps intentionally separates two different signals.

**Capacity** represents provider quota windows, utilization, and reset times.

**Token Analytics** represents token usage observed in local Claude Code and Codex session logs. It is explicitly labeled **Locally observed** because it is not a provider-wide billing statement or guaranteed lifetime total.

For Codex, cached input is already part of reported input and is shown as a breakdown without being counted twice in total tokens. Claude Code cache reads and cache creation are surfaced as observed token work alongside input and output.

See [docs/token-analytics.md](docs/token-analytics.md) for counting semantics and limitations.

## Local-first data model

Browser-local application state may include:

- account display names;
- optional locally entered email metadata;
- quota percentages and reset timestamps;
- update timestamps;
- theme and notification preferences;
- reset-notification deduplication state.

The local collector may also read provider-managed local session files to calculate Token Analytics. QuotaOps parses those files locally and exposes only numeric usage aggregates, timestamps, provider labels, and source health through its collector snapshot.

QuotaOps does not intentionally export or persist prompts, responses, source code, provider passwords, API keys, OAuth tokens, session cookies, private keys, or provider authentication state in its dashboard data.

Voice input uses the browser speech-recognition capability when available. Depending on the browser and operating system, recognition may use a remote service operated by the browser or platform vendor. QuotaOps does not send voice audio to a SO HOMELY backend.

## Run locally

Recommended Node version: **22.21.0**.

```bash
git clone https://github.com/ChrisLeoKokotos/quota-ops.git
cd quota-ops
npm ci --ignore-scripts --no-audit --no-fund
npm run dev
```

Then open:

```text
http://localhost:3000
```

Validation:

```bash
npm run typecheck
npm test
npm run build
```

## Local collector

QuotaOps includes an **experimental same-PC collector** for multiple Claude and OpenAI accounts. Each account uses its own persistent local Chrome / Edge profile. Interactive login remains visible and provider-controlled; background collection uses those isolated local profiles and exposes normalized snapshots only on `127.0.0.1:4317`.

The local API is authenticated with a random local token that stays server-side. Browser-direct collector access is rejected, profile paths are constrained to the protected QuotaOps home, and provider adapters normalize quota metadata before it reaches the dashboard.

Claude collection observes the provider's own Usage-page responses. OpenAI collection uses the authenticated local ChatGPT browser session to read Codex quota metadata; provider access tokens remain inside that isolated browser execution and are not returned in QuotaOps snapshots.

Canonical setup and operations guide: [docs/local-collector.md](docs/local-collector.md).

## Token Analytics

To inspect the locally observed token aggregate directly:

```powershell
npm run collector:setup -- tokens
```

QuotaOps currently scans:

- Claude Code logs under the user's local Claude project history;
- Codex active and archived local session logs.

The scanner includes deduplication and child/fork replay suppression so copied session history is not intentionally counted as new work.

See [docs/token-analytics.md](docs/token-analytics.md).

## Notifications

Reset notifications are browser-based and designed to work while QuotaOps is running. Reliable notification delivery while the app is fully closed is not part of the current MVP.

## Keyboard shortcuts

- `N` — add account
- `T` — toggle light / dark theme
- `?` — open shortcut help

## Voice input

When supported by the browser, voice input can update manual usage quickly. Example commands include:

- `Dev 1 weekly 82`
- `Dev 2 five hour 40`

Voice input updates usage percentages only. Reset timestamps are still entered manually.

## Stack

- Next.js 16.3.8
- React 19.3
- TypeScript 6.0
- Playwright Core 1.63
- Next.js App Router
- browser local storage
- browser Notification API
- browser speech-recognition API when available
- local Node.js collector

## Security and privacy

QuotaOps is designed to be local-first and credential-minimizing.

Read:

- [SECURITY.md](SECURITY.md)
- [PRIVACY.md](PRIVACY.md)
- [docs/security-architecture.md](docs/security-architecture.md)
- [docs/local-collector-threat-model.md](docs/local-collector-threat-model.md)
- [docs/repository-security-settings.md](docs/repository-security-settings.md)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## Changelog and releases

Notable unreleased changes are maintained in [CHANGELOG.md](CHANGELOG.md). Release versioning, tagging, and GitHub Release expectations are documented in [RELEASING.md](RELEASING.md).

## Project stewardship

QuotaOps was created by **SO HOMELY** and is maintained through this public repository under the governance model described in [GOVERNANCE.md](GOVERNANCE.md).

## License

Licensed under the Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

Claude, Anthropic, OpenAI, ChatGPT, and Codex are third-party names and products. QuotaOps is not affiliated with or endorsed by Anthropic or OpenAI.
