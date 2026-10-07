# Contributing to QuotaOps

Thank you for considering a contribution to QuotaOps, a product created by **SO HOMELY**.

## Current scope

QuotaOps is a local-first MVP for AI-account capacity and locally observed token activity.

The current product includes:

- Claude and OpenAI / ChatGPT Codex quota support;
- provider-neutral quota windows;
- reset countdowns and account-state derivation;
- capacity recommendations and attention items;
- browser-local persistence for non-secret dashboard metadata;
- reset notifications;
- optional browser voice input;
- keyboard shortcuts and light / dark themes;
- an experimental same-PC multi-provider collector with isolated browser profiles;
- local Token Analytics for Claude Code and Codex session logs.

There is no hosted QuotaOps backend or cloud sync.

## Ground rules

- Use a fork or feature branch and open a pull request.
- Keep pull requests focused and reasonably small.
- Explain the problem, proposed solution, and tradeoffs.
- Add or update tests when behavior changes.
- Update documentation when user-facing behavior or trust boundaries change.
- Do not commit secrets, credentials, tokens, cookies, personal data, or exported authentication state.
- Do not add telemetry, credential collection, background network activity, authentication bypasses, or new external calls without explicit maintainer review.
- Follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Development setup

Recommended runtime: Node.js 22.21.0.

```bash
npm ci --ignore-scripts --no-audit --no-fund
npm run dev
```

Before opening a pull request, run:

```bash
npm run typecheck
npm test
npm run build
```

## Development workflow

1. Open an issue first for substantial features, provider integrations, collectors, persistence changes, security-sensitive work, or architectural changes.
2. Branch from the current default branch.
3. Make the smallest coherent change.
4. Run typecheck, tests, and production build.
5. Update relevant documentation and `CHANGELOG.md` when the change is user-visible or operationally meaningful.
6. Open a pull request using the repository template.
7. Address review feedback and required checks before merge.

## Security-sensitive changes

The following require explicit maintainer review:

- provider credentials or session state;
- provider usage endpoints or browser automation;
- local collectors or background processes;
- remote synchronization;
- new browser permissions;
- speech / audio processing;
- notifications or background execution;
- persistence or snapshot format changes;
- local token-log parsing;
- new network destinations;
- telemetry;
- GitHub Actions or release tooling.

QuotaOps must not silently upload, proxy, persist, or log provider credentials.

## Token Analytics contributions

Token Analytics must remain explicit about scope.

- Do not present local log totals as provider billing totals.
- Preserve the **Locally observed** label for local session analytics.
- Avoid double-counting cache fields when a provider reports them as a subset of input.
- Handle duplicate, forked, replayed, copied, or archived session records defensively.
- Do not expose prompts, responses, source code, or raw session contents through the dashboard snapshot.
- Add fixtures or tests for new parser behavior.

## UI and product contributions

Keep the interface quiet, information-first, and accessible. Do not introduce third-party brand assets or imply endorsement by AI providers.

Light and dark themes should preserve the current neutral inverse visual language.

## Contribution licensing

By submitting a contribution, you agree that it is intentionally submitted for inclusion in QuotaOps and licensed under Apache License 2.0, consistent with Section 5 of that license.

## AI-assisted contributions

AI-assisted code is welcome, but the contributor remains responsible for correctness, security, licensing, provenance, and reviewability. Do not submit generated code that you cannot explain or validate.

## Questions

See [SUPPORT.md](SUPPORT.md). For vulnerabilities, follow [SECURITY.md](SECURITY.md) and do not open a public issue.
