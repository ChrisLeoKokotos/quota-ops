# Security Policy

Security is a core requirement for QuotaOps because the project deals with AI-provider quota metadata and may later integrate with local provider tooling.

**QuotaOps is a product created by SO HOMELY.**

## Supported versions

Until the first stable release, security fixes are provided for the latest code on the default branch only.

| Version | Supported |
| --- | --- |
| Latest default branch | Yes |
| Older commits / snapshots | No |

## Current security boundary

The current MVP:

- runs as a Next.js application;
- stores quota metadata and preferences in browser local storage;
- has no QuotaOps backend or hosted database;
- has no QuotaOps authentication system;
- does not automatically obtain or bypass Claude credentials;
- can optionally reuse user-created local browser profiles for same-PC quota collection;
- does not export provider passwords, API keys, OAuth tokens, or session cookies into QuotaOps snapshots;
- does not upload quota data to SO HOMELY infrastructure;
- exposes the optional collector only on `127.0.0.1:4317`;
- uses browser notifications only after user permission;
- can use browser speech recognition only after user action.

Browser speech recognition may use a remote service operated by the browser or platform vendor. QuotaOps does not relay voice audio to a SO HOMELY backend.

## Reporting a vulnerability

**Do not open a public issue for a suspected vulnerability.**

Use GitHub Private Vulnerability Reporting for this repository when available. If that is unavailable, contact the repository maintainer privately through a verified private contact method from the maintainer's GitHub profile.

Please include, where possible:

- a concise description;
- affected component, version, or commit;
- reproduction steps or proof of concept;
- expected impact;
- suggested mitigation, if known.

Never send real credentials, tokens, session cookies, private keys, or unrelated personal data.

## Credential handling

QuotaOps contributors must never commit or intentionally collect:

- API keys;
- OAuth access or refresh tokens;
- provider session cookies;
- private keys;
- passwords;
- Authorization headers;
- exported provider authentication state;
- unrelated personal or account data.

A future provider collector must preserve the same boundary: provider authentication material stays local and is not returned as normalized quota data.

## Local storage

The MVP stores non-secret operational metadata locally in the browser, including:

- account labels;
- usage percentages;
- reset timestamps;
- update timestamps;
- theme preference;
- notification preference;
- identifiers for reset notifications already shown.

Browser local storage is not a secret vault. Sensitive credentials must never be placed there.

## Notifications

Notifications are optional and permission-gated. Notification text must remain limited to non-secret quota status such as account label, quota window, and reset state.

The current implementation is designed for notifications while QuotaOps is running. Fully background notification delivery is not part of the current MVP.

## Voice input

Voice input is user-triggered and must not run continuously in the background.

Transcripts are untrusted input. The current implementation accepts a narrow usage-update command shape and does not use voice input for authentication or credential entry.

## Security design principles

QuotaOps should:

- remain local-first where practical;
- minimize privileges and credential access;
- store the minimum data required;
- avoid logging sensitive material;
- fail closed when quota state is incomplete or stale;
- make network behavior explicit and auditable;
- avoid hidden telemetry;
- isolate provider-specific integrations behind narrow interfaces;
- require explicit review for background processes, provider authentication, or remote synchronization.

## Supply-chain and CI security

Repository workflows use least-privilege permissions and pinned GitHub Actions. Public pull requests are treated as untrusted.

Changes involving dependencies, workflows, authentication, networking, telemetry, persistence, voice processing, browser permissions, or future collectors require explicit maintainer review.

## Disclosure

Please allow maintainers a reasonable opportunity to investigate and remediate a vulnerability before public disclosure.
