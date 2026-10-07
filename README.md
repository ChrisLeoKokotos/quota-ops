# QuotaOps

Open-source quota and capacity management for AI agents.

**QuotaOps is a product created by SO HOMELY.**

QuotaOps helps people and teams track AI-account usage limits, exact reset windows, and available capacity from one local workspace instead of checking each account manually.

## Current product state

QuotaOps is currently an MVP for **Claude** and **OpenAI / ChatGPT Codex** account capacity.

Today it supports:

- adding and removing real local account entries;
- 5-hour usage percentage and exact reset time per account;
- weekly usage percentage and exact reset time per account;
- live reset countdowns;
- account states such as Available, Low capacity, 5h limited, Weekly max, Needs setup, and Refresh required;
- best-capacity recommendations;
- contextual capacity tips;
- browser / OS reset notifications while QuotaOps is running and notification permission is granted;
- voice commands for quick usage updates when supported by the browser;
- keyboard shortcuts;
- light and dark themes;
- browser-local persistence;
- experimental same-PC automatic collection for multiple Claude and OpenAI accounts through isolated local browser profiles;

There is **no hosted QuotaOps backend, hosted database, account system, or cloud sync** in the current MVP. An optional local collector can run on the same PC and binds only to `127.0.0.1`.

## Local-first data model

Current application data is stored in browser local storage for the local QuotaOps origin. This includes account display names, optional locally entered email metadata, usage percentages, reset timestamps, notification state, reset-notification history, and theme preference.

QuotaOps does not intentionally store provider passwords, API keys, OAuth tokens, session cookies, provider authentication state, prompts, source code, or conversations.

Voice input uses the browser speech-recognition capability when available. Depending on the browser and operating system, speech recognition may use a remote service operated by the browser or platform vendor. QuotaOps does not send voice audio to a SO HOMELY backend.

## Notifications

Reset notifications are currently browser-based. They are designed to work while QuotaOps is running. Reliable notifications while the browser/app is fully closed are not part of the current MVP and are expected to become a responsibility of a future local collector/background process.

## Keyboard shortcuts

- `N` — add account
- `T` — toggle light / dark theme
- `?` — open shortcut help

## Voice input

When supported by the browser, voice input can update usage quickly. Example commands include:

- `Dev 1 weekly 82`
- `Dev 2 five hour 40`

Voice input currently updates usage percentages only. Reset timestamps are still entered manually.

## Stack

- Next.js 16.3.8
- React 19.3
- TypeScript 6.0
- Next.js App Router
- browser local storage
- browser Notification API
- browser speech-recognition API when available

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

QuotaOps includes an **experimental same-PC collector** for multiple Claude and OpenAI accounts. Each account uses its own persistent local Chrome / Edge profile. Interactive login is visible and provider-controlled; background collection uses those isolated local profiles and exposes only normalized snapshots on `127.0.0.1:4317`.

The local API is authenticated with a random local token that stays server-side, browser-direct access is rejected, profile paths are constrained to the protected QuotaOps home, and provider adapters normalize only quota metadata. Claude collection observes the provider's own Usage-page responses. OpenAI collection uses the authenticated local ChatGPT browser session to read Codex quota metadata; access tokens remain inside that isolated browser execution and are not returned in QuotaOps snapshots.

The full setup guide covers `bootstrap-five`, per-account login, one-account verification with `collect`, enable/disable controls, security checks, token rotation, troubleshooting, and the five-account workflow: [docs/local-collector.md](docs/local-collector.md).

The provider adapters are considered experimental because the Claude web Usage response and ChatGPT/Codex usage surfaces are internal product endpoints rather than stable public quota APIs and may change.

See [docs/mvp-architecture.md](docs/mvp-architecture.md) and [docs/security-architecture.md](docs/security-architecture.md).

## Security and privacy

QuotaOps is designed to be local-first and credential-minimizing.

Read:

- [SECURITY.md](SECURITY.md)
- [PRIVACY.md](PRIVACY.md)
- [docs/security-architecture.md](docs/security-architecture.md)
- [docs/repository-security-settings.md](docs/repository-security-settings.md)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## Project stewardship

QuotaOps was created by **SO HOMELY** and is maintained through this public repository under the governance model described in [GOVERNANCE.md](GOVERNANCE.md).

## License

Licensed under the Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

Claude, Anthropic, OpenAI, ChatGPT, and Codex are third-party names and products. QuotaOps is not affiliated with or endorsed by Anthropic or OpenAI.
