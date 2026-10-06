# Contributing to QuotaOps

Thank you for considering a contribution to QuotaOps, a product created by **SO HOMELY**.

## Current scope

QuotaOps is currently a local-first MVP for Claude Team quota and reset management. The repository includes:

- account onboarding and removal;
- 5-hour and weekly quota windows;
- reset countdowns and state derivation;
- capacity recommendations and tips;
- local persistence;
- light / dark themes;
- reset notifications;
- optional browser voice input;
- keyboard shortcuts.

There is no backend or automatic provider collector yet.

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
npm install
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
5. Update relevant documentation.
6. Open a pull request using the repository template.
7. Address review feedback and required checks before merge.

## Security-sensitive changes

The following require explicit maintainer review:

- provider credentials or session state;
- provider usage endpoints or browser automation;
- local collector processes;
- remote synchronization;
- new browser permissions;
- speech / audio processing;
- notifications or background execution;
- persistence format changes;
- new network destinations;
- telemetry;
- GitHub Actions or release tooling.

QuotaOps must not silently upload, proxy, persist, or log provider credentials.

## UI and product contributions

Keep the interface quiet, information-first, and accessible. Do not introduce third-party brand assets or imply endorsement by AI providers.

Light and dark themes should preserve the current neutral inverse visual language: dark primary elements on light theme and light primary elements on dark theme.

## Tests

Behavioral logic should be testable outside UI rendering where practical. In particular, quota state, reset behavior, recommendation logic, and notification timing should remain deterministic.

## Contribution licensing

By submitting a contribution, you agree that it is intentionally submitted for inclusion in QuotaOps and licensed under Apache License 2.0, consistent with Section 5 of that license.

## AI-assisted contributions

AI-assisted code is welcome, but the contributor remains responsible for correctness, security, licensing, provenance, and reviewability. Do not submit generated code that you cannot explain or validate.

## Questions

See [SUPPORT.md](SUPPORT.md). For vulnerabilities, follow [SECURITY.md](SECURITY.md) and do not open a public issue.
