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
- can reuse isolated local browser profiles for same-PC quota collection;
- keeps interactive provider login visible and user-controlled while scheduled Windows quota refreshes run hidden/headless;
- does not export provider passwords, API keys, OAuth tokens, or session cookies into QuotaOps snapshots;
- does not upload quota data to SO HOMELY infrastructure;
- exposes the optional collector only on `127.0.0.1:4317`;
- serves the dashboard on a loopback port allocated at launch, refuses non-loopback TCP peers before the application sees them, and authorizes snapshot access with a per-process capability rather than a request header;
- authenticates collector API requests with a random 256-bit local token kept out of browser JavaScript;
- rejects direct browser access, unexpected Host / Origin values, and provider responses outside the exact accepted Usage endpoint;
- keeps collector profiles inside a protected local root with Windows ACL / Unix mode hardening;
- uses browser notifications only after user permission;
- can use browser speech recognition only after user action.

Browser speech recognition may use a remote service operated by the browser or platform vendor. QuotaOps does not relay voice audio to a SO HOMELY backend.

## What QuotaOps does not protect against

These limits are deliberate and were accepted by the maintainer on 15 October 2026. They are stated here so the guarantees above are not read more broadly than they hold.

- **Code running as your own Windows user.** Such a process can reach the loopback dashboard and collector, read the collector token, and read the isolated browser profiles that hold provider sessions. The loopback boundary and the ACL hardening bound *network* and *other-user* exposure, not same-account compromise.
- **Session-history file permissions.** Per-source consent governs what QuotaOps reads. The files themselves stay readable by anything running under your account.
- **A transparent local relay.** A forwarder such as `netsh interface portproxy`, a default nginx `proxy_pass`, `ssh -R` or a tunnelling tool connects to the dashboard from loopback on a remote caller's behalf and adds no forwarding header, so it is indistinguishable from a local client. Allocating the dashboard port at launch defeats a relay configured in advance against a fixed port; it does not defeat one aimed at the port currently in use. Exposing QuotaOps through any proxy or port forward is an unsupported deployment.

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
- optional user-entered account email metadata;
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

The repository uses Dependency Review, Repository Guard, production dependency auditing, and CodeQL analysis. The goal is defense in depth; no static or dependency scanner can guarantee the absence of unknown vulnerabilities.

Changes involving dependencies, workflows, authentication, networking, telemetry, persistence, voice processing, browser permissions, or future collectors require explicit maintainer review.

## Disclosure

Please allow maintainers a reasonable opportunity to investigate and remediate a vulnerability before public disclosure.
