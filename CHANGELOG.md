# Changelog

All notable changes to QuotaOps are documented here.

The format is inspired by Keep a Changelog. Release versions should follow semantic versioning where practical.

## [Unreleased]

### Added

- Multi-provider quota architecture for Claude, OpenAI / ChatGPT Codex and Google / Antigravity (Google changes in Draft PR #50, not released).
- Provider-neutral quota windows instead of Claude-specific hardcoded fields.
- Experimental same-PC multi-account collector with isolated Chrome / Edge profiles and loopback-only snapshot service.
- Per-account provider-aware login, collect, enable, and disable workflows.
- OpenAI / ChatGPT Codex quota collection through the authenticated local ChatGPT browser session.
- Manual Google / Antigravity quota windows with multiple independently entered model groups.
- Google Antigravity CLI `statusLine` hook for automatic event-driven (not CLI-closed background) quota snapshots, normalized quota buckets, stale detection and per-account local storage.
- Explicitly opted-in Google numeric Token Analytics with hashed session watermarks and deduplication; no pre-consent backfill.
- Synthetic hook-to-collector and collector-to-Chrome dashboard E2E on CI, including Windows hook E2E; real authenticated Google sessions remain unverified.
- Local Token Analytics for Claude Code and Codex.
- Total token activity with Input, Output, Cache read, and Cache write breakdowns.
- Today, 7 days, 30 days, and All time token analytics views.
- Per-provider token totals for Claude and OpenAI, plus locally observed Google counters with separate consent.
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
- Windows desktop (Draft PR #52, unsigned test build): background Claude/OpenAI checks in a separate hidden Windows desktop that is never shown or focused, inside a job object that ends the worker and its browsers with the batch.
- Windows desktop: tray switch for token analytics, with a dialog that explains what is read before anything is read (off by default).
- Windows desktop: `QuotaOps.exe` carries the QuotaOps icon and version information (applied before the ASAR integrity resource and checked after packing), so shortcuts and the taskbar show QuotaOps.
- Windows desktop: the collector restarts after an unexpected stop (at most 3 times in 10 minutes), and a taken port 4317 is explained in the tray instead of failing silently.
- Dashboard: every configured account is visible with its real state (not checked yet, sign-in needed, verification needed, unavailable, unsupported, OK), the last known values with their time, and "Never successfully synced" when there are none.
- Packaged lifecycle E2E scenarios: close/reopen, Pause/Resume, crash recovery, a foreign program on port 4317, and a killed main process.

### Fixed

- Claude usage responses with query parameters were rejected, so reset times were missing. The usage endpoint check still requires the exact host and path.
- Claude Code token totals were incomplete for large histories, because large session files were cut off. Scanning is now incremental, newest first, with per-file offsets, and partial totals say from which date they are complete.
- Attention holds from headless attempts blocked hidden-desktop attempts. Holds now record how the check ran.
- The desktop dashboard never showed token analytics. The collector always reports a Google token source, and the IPC projection rejected the whole snapshot because of it. Google sources are now accepted, as long as each source matches its own provider.

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
- Provider credentials, cookies, access tokens, prompts, responses, and source code are excluded from normalized collector snapshots and stored Google statusLine observations.
- Token Analytics parses local provider session files on-device and exposes only numeric aggregates, timestamps, provider labels, and source health.
- Added replay suppression and deduplication to reduce double-counting from copied local session history.
- GitHub Actions use least-privilege permissions and immutable action SHAs.
- Production dependency audit, Dependency Review, Repository Guard, and CodeQL remain part of the repository security baseline.

## Release policy

Unreleased work remains under `[Unreleased]` until a maintainer intentionally creates a versioned release. A release should promote those entries into a dated version section and pair that version with an intentional tag and GitHub Release.
