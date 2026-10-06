# Changelog

All notable changes to QuotaOps will be documented in this file.

The format is inspired by Keep a Changelog, and releases should use semantic versioning where practical.

## [Unreleased]

### Added

- Experimental same-PC multi-account collector with isolated local Chrome / Edge profiles, loopback-only snapshot service, and automatic dashboard synchronization.

- Functional Claude Team quota dashboard.
- Real local account creation, editing, and removal.
- 5-hour and weekly usage tracking with exact reset timestamps.
- Live reset countdowns.
- Account state derivation for available, low, exhausted, incomplete, and stale quota states.
- Best-capacity recommendation logic.
- Contextual quota tips and attention items.
- Browser-local persistence.
- Light and dark themes.
- Browser / OS reset notifications while QuotaOps is running.
- In-app reset notifications.
- Optional browser voice input for quick usage updates.
- Keyboard shortcuts for account creation, theme switching, and shortcut help.
- Unit tests for quota logic and reset notification timing.
- Next.js CI validation with typecheck, tests, and production build.
- Repository Guard and Dependency Review workflows.
- Repository governance, contribution, privacy, security, support, and branding documentation.

### Changed

- Removed demo seed data from the daily-use experience.
- Split missing quota metadata into **Needs setup** and expired known reset timestamps into **Refresh required**.
- Simplified expired reset wording to **Reset reached** with an explicit request to update current usage.
- Refined dashboard layout, sidebar, cards, controls, and responsive behavior.
- Changed primary visual accents to neutral inverse styling: dark on light theme and light on dark theme.
- Updated documentation to reflect the current product state and identify QuotaOps as a product created by **SO HOMELY**.

### Security

- Local-first MVP with no QuotaOps backend, hosted database, cloud sync, or provider credential storage.
- GitHub Actions use read-only permissions where applicable and immutable action SHAs.
- Secret Protection, Push Protection, dependency review, and repository branch protections are part of the repository security baseline.
