# Security Architecture

QuotaOps is intended to observe and reason about AI-provider quota and capacity without becoming a credential broker.

This document defines security invariants that implementations and provider adapters are expected to preserve.

## Security goals

QuotaOps should provide useful quota, reset, utilization, and capacity information while minimizing access to authentication material and limiting the impact of a compromised adapter, dependency, workflow, or contributor account.

## Trust boundaries

QuotaOps treats the following as separate trust domains:

1. **Provider authentication state** — API keys, OAuth tokens, cookies, refresh tokens, private keys, and local session material.
2. **Provider adapters / collectors** — code that obtains usage or quota signals.
3. **Normalized quota data** — utilization, reset timestamps, remaining capacity, model/provider identifiers, and health state.
4. **Scheduling / orchestration** — consumers that use normalized quota data to make routing decisions.
5. **UI / API / integrations** — surfaces that display or export normalized quota information.

Raw authentication material must not cross into downstream layers merely because quota data does.

## Security invariants

### Credentials stay local

QuotaOps must not require provider credentials to be uploaded to a QuotaOps-operated service.

Provider credentials should remain on the user's machine or in the provider-supported secret store used by the local client.

### No raw credential exposure

Collectors and adapters should return normalized usage state rather than raw authentication material.

Public APIs, logs, telemetry, errors, diagnostics, crash reports, and exported snapshots must not contain:

- API keys;
- OAuth access or refresh tokens;
- session cookies;
- passwords;
- private keys;
- Authorization headers;
- exported provider authentication state.

### Least privilege

An integration must request only the permissions necessary to obtain the intended quota signal.

Read-only or usage-specific provider interfaces are preferred over general account or workspace access.

### Explicit network behavior

Every network destination used by QuotaOps must be attributable to a documented feature or provider adapter.

Hidden proxying, credential relay, or undocumented telemetry is prohibited.

### Local-first data handling

Quota history and operational state should be stored locally by default.

If remote synchronization or hosted functionality is introduced later, it must be opt-in or otherwise clearly disclosed, minimize collected data, and receive a dedicated security and privacy review.

### Safe logging

Logs should contain operational metadata rather than secrets.

Sensitive values must be redacted before logging. Error objects from SDKs or HTTP clients must not be logged blindly because they may include headers, URLs, or credentials.

### Untrusted input

Provider responses, repository contributions, configuration files, plugin output, and external metadata are untrusted input.

QuotaOps must validate types, ranges, timestamps, identifiers, and URLs before using them for scheduling or persistence.

### Fail closed

When authentication state, quota state, or provider responses cannot be validated safely, QuotaOps should report the state as unavailable or unknown rather than fabricating capacity.

### Adapter isolation

Provider-specific code should be isolated behind narrow interfaces so that adding a provider does not grant unrelated parts of QuotaOps access to its credentials or local state.

### No authentication bypasses

QuotaOps must not implement or encourage authentication bypasses, token theft, session hijacking, or circumvention of provider access controls.

Where a provider offers a documented usage or quota interface, that interface is preferred. Unsupported integrations require explicit security and compatibility review before inclusion.

## Repository and CI threat model

Public pull requests are untrusted.

GitHub Actions triggered by pull requests must:

- use read-only permissions unless a narrowly scoped write permission is required;
- never expose repository or provider secrets to untrusted PR code;
- avoid `pull_request_target` by default;
- pin external actions to immutable commit SHAs;
- avoid executing downloaded scripts without integrity or provenance checks.

Changes to workflows, security policies, authentication code, provider adapters, dependency manifests, and release tooling require maintainer review.

## Dependency policy

Dependencies should be minimized and kept current.

New dependencies should be evaluated for:

- maintenance activity;
- security history;
- transitive dependency footprint;
- license compatibility;
- whether the functionality can reasonably be implemented without the dependency.

High-severity vulnerable dependency introductions should block merge once the repository's required checks are enabled.

## Storage

Persistent quota data should avoid unnecessary account identifiers.

If sensitive operational history is stored, the implementation should document:

- location;
- schema;
- retention;
- deletion behavior;
- file permissions;
- whether encryption is used.

## Security changes

A pull request that changes authentication, networking, telemetry, persistence, release automation, or provider credential access must explicitly describe its security impact.

This document should be updated whenever the trust model materially changes.
