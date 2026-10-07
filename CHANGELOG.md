# Changelog

All notable changes to QuotaOps are documented here.

The format is inspired by Keep a Changelog. Release versions should follow semantic versioning where practical.

## [Unreleased]

### Added

- Multi-provider quota architecture for Claude and OpenAI / ChatGPT Codex.
- Provider-neutral quota windows instead of Claude-specific hardcoded fields.
- Experimental same-PC multi-account collector with isolated Chrome / Edge profiles and loopback-only snapshot service.
- Per-account provider-aware login, collect, enable, and disable workflows.
- OpenAI / ChatGPT Codex quota collection through the authenticated local ChatGPT browser session.
- Local Token Analytics for Claude Code and Codex.
- Total token activity with Input, Output, Cache read, and Cache write breakdowns.
- Today, 7 days, 30 days, and All time token analytics views.
- Per-provider token totals for Claude and OpenAI.
- Local token analytics CLI command: `npm run collector:setup -- tokens`.
- Claude Code deduplication for repeated local message records.
- Codex child/fork replay suppression and archived-session scanning.
- Browser / OS reset notifications while QuotaOps is running.
- In-app reset notifications.
- Optional browser voice input for quick manual usage updates.
- Keyboard shortcuts for account creation, theme switching, and shortcut help.
- Light and dark themes.
- Unit tests covering quota logic, provider parsers, reset notifications, voice commands, and token analytics.
- Repository Guard, Dependency Review, CI validation, and CodeQL analysis.
- Repository governance, contribution, privacy, security, support, branding, and release-process documentation.

### Changed

- Generalized account status handling to Available, Low capacity, At limit, Max usage, Needs setup, and Refresh required.
- Updated the Available state to use a green success treatment in the dashboard.
- Reworked recommendation logic to operate on provider-neutral quota windows.
- Preserved migration of older Claude account data into the normalized quota-window model.
- Preserved migration of collector configs that predate the explicit provider field.
- Updated the local collector to support Claude and OpenAI accounts in the same workspace.
- Hardened OpenAI collection so provider access tokens remain inside the isolated browser execution and are not returned in snapshots.
- Updated CodeQL Actions to v4.38.2 for both initialization and analysis.
- Refined dashboard layout, sidebar, cards, controls, responsive behavior, and neutral visual language.
- Updated project documentation to describe QuotaOps as a product created by **SO HOMELY** and to reflect the current multi-provider product state.

### Security

- Collector API remains loopback-only on `127.0.0.1` and authenticated with a random 256-bit local token.
- Strict Host / Origin validation, rate limiting, HTTP timeouts, protected profile roots, Windows ACL / Unix permission hardening, and response-size limits remain part of the collector boundary.
- Provider credentials, cookies, access tokens, prompts, responses, and source code are excluded from normalized collector snapshots.
- Token Analytics parses local provider session files on-device and exposes only numeric aggregates, timestamps, provider labels, and source health.
- Added replay suppression and deduplication to reduce double-counting from copied local session history.
- GitHub Actions use least-privilege permissions and immutable action SHAs.
- Production dependency audit, Dependency Review, Repository Guard, and CodeQL remain part of the repository security baseline.

## Release policy

Unreleased work remains under `[Unreleased]` until a maintainer intentionally creates a versioned release. A release should promote those entries into a dated version section and pair that version with an intentional tag and GitHub Release.
