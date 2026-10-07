# Security Architecture

QuotaOps is a product created by **SO HOMELY**.

QuotaOps is intended to observe and reason about AI-provider quota and capacity without becoming a credential broker.

## Current implementation boundary

The current MVP consists of a browser-rendered Next.js application and local quota logic.

It has:

- no hosted QuotaOps backend;
- no hosted database;
- no cloud sync;
- no QuotaOps user authentication;
- no automatic credential collection;
- an optional experimental same-PC local collector.

Non-secret quota metadata and preferences are stored in browser local storage. The collector stores isolated browser profiles under the user's local QuotaOps directory and exposes normalized snapshots only over a loopback-only HTTP service.

## Security goals

QuotaOps should provide useful quota, reset, utilization, and capacity information while minimizing access to authentication material and limiting the impact of a compromised adapter, dependency, workflow, browser feature, or contributor account.

## Trust boundaries

QuotaOps treats the following as separate trust domains:

1. **Provider authentication state** — API keys, OAuth tokens, cookies, refresh tokens, private keys, passwords, and local session material.
2. **Provider adapters / collectors** — future code that obtains usage or quota signals.
3. **Normalized quota data** — utilization, reset timestamps, remaining capacity, provider identifiers, and source health.
4. **Capacity logic** — state derivation, recommendations, notification timing, and future routing.
5. **UI / browser capabilities** — display, local persistence, notifications, speech recognition, and user input.
6. **Repository / CI** — public contributions, dependencies, GitHub Actions, and release tooling.

Raw authentication material must not cross into downstream layers merely because quota data does.

## Security invariants

### Credentials stay local

QuotaOps must not require provider credentials to be uploaded to a SO HOMELY-operated service.

### No raw credential exposure

Public APIs, logs, telemetry, errors, diagnostics, crash reports, exported snapshots, and browser storage must not contain:

- API keys;
- OAuth access or refresh tokens;
- session cookies;
- passwords;
- private keys;
- Authorization headers;
- exported provider authentication state.

### Local-first persistence

The current browser application stores only non-secret quota metadata and user preferences locally.

Local storage is not a credential vault and must never be repurposed for secrets.

### Fail closed on stale or incomplete quota state

Missing reset information produces `needs_setup`.

A known reset timestamp that has passed produces `refresh_required`.

QuotaOps must not fabricate fresh capacity merely because a reset time has elapsed.

### Explicit browser permissions

Notification permission and microphone access must be initiated by the user.

Voice capture must not run continuously in the background.

### Voice processing boundary

QuotaOps uses browser speech recognition when available. The browser or operating system may process audio remotely.

QuotaOps does not run a SO HOMELY speech backend in the current MVP.

Voice transcripts are untrusted input and should only affect narrow, explicitly supported commands.

### Notification boundary

Reset notifications should contain only minimal non-secret operational metadata.

Current notifications are UI/browser based. Reliable fully-background notification behavior belongs in a future security-reviewed local collector.

### Least privilege

Future integrations must request only the permissions necessary to obtain quota signals.

Read-only or quota-specific provider interfaces are preferred over broad account access.

### Explicit network behavior

Every network destination introduced by QuotaOps code must be attributable to a documented feature.

Hidden proxying, credential relay, hidden analytics, or undocumented telemetry is prohibited.

### Safe logging

Logs should contain operational metadata rather than secrets. Error objects from SDKs, browsers, collectors, or HTTP clients must not be logged blindly.

### Untrusted input

Treat as untrusted:

- provider responses;
- voice transcripts;
- browser storage;
- repository contributions;
- configuration files;
- plugin / adapter output;
- external metadata.

Validate types, ranges, timestamps, identifiers, and URLs before using them.

### Adapter isolation

Provider-specific code should be isolated behind narrow interfaces so adding a provider does not grant unrelated parts of QuotaOps access to credentials or session state.

### No authentication bypasses

QuotaOps must not implement or encourage authentication bypasses, token theft, session hijacking, or circumvention of provider access controls.

## Repository and CI threat model

Public pull requests are untrusted.

GitHub Actions triggered by pull requests should:

- use read-only permissions unless a narrowly scoped write permission is required;
- never expose secrets to untrusted PR code;
- avoid `pull_request_target` by default;
- pin actions to immutable commit SHAs;
- avoid unverified downloaded scripts.

Changes to workflows, dependencies, security policy, authentication, networking, persistence, browser permissions, provider adapters, collectors, and release tooling require maintainer review.

## Dependency policy

Dependencies should be minimized and kept current.

New dependencies should be evaluated for:

- maintenance activity;
- security history;
- transitive footprint;
- license compatibility;
- whether the same functionality can reasonably be implemented without the dependency.

## Local collector security

The experimental local collector uses separate persistent browser profiles per account.

Security rules:

- browser profiles remain local to the user's machine;
- no browser cookies, passwords, tokens, or Authorization headers are included in collector snapshots;
- the HTTP service binds to `127.0.0.1`, not `0.0.0.0`;
- the collector API requires a random 256-bit local token using constant-time comparison;
- the token remains server-side and is not exposed to browser JavaScript;
- direct browser access, unexpected Host values, and unexpected Origin values are rejected;
- the Next.js server proxies collector snapshots through a same-origin route;
- local request rate limiting reduces accidental or hostile request floods;
- Windows ACLs or Unix file modes restrict collector state and browser profiles;
- configured browser profiles must remain inside the protected QuotaOps profile root;
- interactive provider login is visible and user-controlled;
- scheduled Windows collection runs hidden/headless against the isolated profile and attaches through an ephemeral DevTools listener bound to `127.0.0.1`;
- the Claude adapter accepts only the exact expected HTTPS Usage endpoint and rejects unrelated responses;
- provider responses are size-limited and parsed into a narrow normalized quota schema;
- unrecognized response formats fail as `unsupported`;
- expired / missing login state fails as a collector health error rather than attempting an authentication bypass;
- profile directories and collector state must never be committed;
- background collection must not require exporting provider session material.

Five isolated Claude profiles have passed individual real-account collection and simultaneous dashboard synchronization on Windows. The collector remains experimental until session-expiry handling, token rotation, LAN isolation, and long-running hidden scheduled refresh behavior are also verified. CI security coverage includes dependency review, repository hygiene checks, dependency auditing, and CodeQL analysis.

## Security changes

Any pull request that changes authentication, networking, telemetry, persistence, speech processing, browser permissions, background execution, or provider credential access must explicitly describe its security impact.

Update this document whenever the trust model materially changes.
