# Contributing to QuotaOps

Thank you for considering a contribution to QuotaOps.

## Ground rules

- Use a fork or feature branch and open a pull request.
- Keep pull requests focused and reasonably small.
- Explain the problem, the proposed solution, and any tradeoffs.
- Add or update tests when behavior changes.
- Update documentation when user-facing behavior changes.
- Do not commit secrets, credentials, tokens, cookies, personal data, or exported authentication state.
- Do not add telemetry, credential collection, authentication bypasses, or new external network calls without explicit maintainer review.
- Follow the project's [Code of Conduct](CODE_OF_CONDUCT.md).

## Development workflow

1. Create an issue first for substantial features, architecture changes, provider integrations, or security-sensitive work.
2. Create a branch from the current default branch.
3. Make the smallest coherent change.
4. Run the project's tests, linting, and security checks when available.
5. Open a pull request using the repository template.
6. Address review feedback before merge.

## Security-sensitive changes

Changes that interact with provider credentials, OAuth/session state, local auth files, usage endpoints, network transport, or persisted usage data require explicit maintainer review.

QuotaOps should remain local-first and credential-minimizing. A contribution must not silently upload, proxy, persist, or log provider credentials.

## Contribution licensing

By submitting a contribution, you agree that your contribution is intentionally submitted for inclusion in QuotaOps and is licensed under the project's Apache License 2.0, consistent with Section 5 of that license.

## AI-assisted contributions

AI-assisted code is welcome, but the contributor remains responsible for correctness, security, licensing, provenance, and reviewability. Do not submit generated code that you cannot explain or validate.

## Questions

For usage or contribution questions, see [SUPPORT.md](SUPPORT.md). For vulnerabilities, follow [SECURITY.md](SECURITY.md) instead of opening a public issue.
