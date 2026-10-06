# QuotaOps

Open-source quota and capacity management for AI agents.

QuotaOps helps teams track usage limits, reset windows, and available capacity across AI accounts so work can be routed without guessing which account is close to a limit.

## MVP

The first MVP focuses on one concrete workflow: **Claude Team capacity across five independent accounts**.

It tracks:

- 5-hour usage and exact reset time per account;
- weekly usage and exact reset time per account;
- available / low / limited / refresh-required states;
- the best-capacity account for the next workload;
- all MVP data locally in the browser.

If a reset timestamp is missing or in the past, QuotaOps fails closed to **Refresh required** rather than assuming capacity has returned.

## Stack

- Next.js 16.3.8
- React 19.3
- TypeScript 6.0
- App Router
- browser-local persistence for the first MVP

There is intentionally **no backend yet**. The core quota model does not require credentials or a server. A future automatic provider collector will live behind a separate adapter boundary and may use Python where that is the safest integration path.

## Run locally

```bash
npm install
npm run dev
```

Then open `http://localhost:3000`.

Validation:

```bash
npm run typecheck
npm test
npm run build
```

## Security posture

QuotaOps is local-first and credential-minimizing. Never commit or intentionally collect provider passwords, API keys, OAuth tokens, session cookies, local auth state, prompts, or conversation content.

See [SECURITY.md](SECURITY.md) and [docs/security-architecture.md](docs/security-architecture.md).

## Architecture

See [docs/mvp-architecture.md](docs/mvp-architecture.md) for the MVP boundary and normalized quota snapshot contract.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).
