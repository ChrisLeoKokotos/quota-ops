# Local Collector Threat Model

QuotaOps is a product created by **SO HOMELY**.

This document defines the security model for the same-PC multi-provider collector.

## Security objective

The collector should automate quota collection without becoming a credential broker, weakening provider authentication, exposing browser sessions to the network, or turning the QuotaOps UI into a privileged local-control surface.

## Protected assets

The collector treats the following as sensitive:

- persistent provider browser profiles;
- provider cookies and local session state inside those profiles;
- the local collector API token;
- collector configuration;
- normalized usage and reset metadata.

## Trust boundaries

1. **AI providers** — remote Claude / Anthropic and OpenAI / ChatGPT content and usage responses.
2. **Isolated browser profile** — provider-authenticated local session.
3. **Collector process** — parses only quota metadata.
4. **Loopback API** — authenticated local transport on `127.0.0.1:4317`.
5. **Next.js server** — reads the local collector token and proxies normalized snapshots.
6. **Browser UI** — receives normalized quota data only.

Provider credentials must not cross from boundary 2 into boundaries 4–6.

## Threats and mitigations

### Remote network access

**Threat:** another machine attempts to query or control the collector.

**Mitigation:** the collector binds only to `127.0.0.1`. It never binds to `0.0.0.0` or a LAN interface.

### Browser-based localhost attacks / DNS rebinding

**Threat:** a malicious website tries to read or abuse the local collector.

**Mitigations:**

- exact Host validation;
- browser Origin requests are rejected by the collector;
- collector API requires a random 256-bit bearer token;
- unauthorized requests do not consume the authenticated request budget;
- dashboard access goes through a same-origin Next.js route;
- the same-origin route requires an explicit dashboard-only request marker.

### Token theft

**Threat:** the local collector token is exposed to browser JavaScript, logs, Git, or remote services.

**Mitigations:**

- token is generated with cryptographic randomness;
- token is stored under the protected QuotaOps home;
- Windows ACL / Unix file permissions protect local state;
- the token remains server-side;
- constant-time comparison is used;
- token rotation is supported;
- the token is never intentionally logged or committed.

### Profile path traversal / symlink escape

**Threat:** configuration points a browser profile outside the protected QuotaOps directory.

**Mitigations:**

- profile paths are constrained to the fixed protected profile root;
- configured paths are validated on read and write;
- symbolic links are rejected;
- real paths are checked after directory creation.

### Provider-response confusion

**Threat:** unrelated provider responses are mistaken for quota data.

**Mitigations:**

- Claude collection accepts only expected Usage endpoint responses from claude.ai;
- OpenAI collection requests only known ChatGPT/Codex quota endpoints from the authenticated chatgpt.com browser context;
- provider access tokens are not included in collector snapshots;
- content type and response shape are validated;
- schema parsing is narrow;
- unrecognized formats fail as `unsupported`.

### Browser compromise surface

**Threat:** provider content exploits the automation browser or a browser extension changes behavior.

**Mitigations:**

- QuotaOps uses the locally installed Chrome / Edge channel rather than bundling a stale browser;
- Chromium sandbox is enabled for Playwright-launched non-Windows fallback collection;
- extensions are disabled for collector profiles;
- provider login remains interactive and provider-controlled;
- scheduled Claude collection uses Playwright private browser transport without a remote-debugging TCP listener. Real Windows E2E verification is still required.

Users should keep Windows and Chrome / Edge fully updated.

### Authentication bypass

**Threat:** automation attempts to bypass expired or missing provider authentication.

**Mitigation:** none is implemented. A missing or expired session returns `login_required`. The user must authenticate normally in the isolated browser profile.

### Local malicious process

**Threat:** malware already running as the same Windows user reads browser profiles, manipulates local processes, or captures user input.

**Residual risk:** QuotaOps cannot securely defend provider sessions from a process that already has equivalent access to the user's Windows account. The collector reduces its own exposure but does not claim to sandbox the entire operating system.

## Fail-closed behavior

The collector must return a health/error state rather than inventing capacity when:

- login is required;
- provider usage data is unavailable;
- endpoint or response format is unexpected;
- profile configuration is unsafe;
- local collector authentication fails.

## Supply-chain controls

The repository uses:

- immutable SHA-pinned GitHub Actions;
- Dependency Review;
- Repository Guard;
- npm production dependency auditing;
- CodeQL;
- Dependabot;
- ignored lifecycle scripts during CI installation.

Direct package dependencies are pinned. A committed dependency lockfile is a release gate before the collector is considered fully production-ready.

## Release gates

The collector should not be described as fully production-ready until all of the following are true:

- CI, Repository Guard, Dependency Review, and CodeQL are green;
- a committed npm lockfile is present and CI uses `npm ci`;
- Windows security-check passes on the target machine;
- one real Claude account passes end-to-end collection (completed on Windows);
- five isolated Claude profiles pass same-PC collection (completed on Windows);
- one real OpenAI / ChatGPT Codex account passes end-to-end collection;
- hidden scheduled refresh behavior is verified over repeated cycles;
- session-expiry behavior is verified;
- token rotation is verified;
- collector remains inaccessible from the LAN;
- documentation matches observed behavior.

## Zero-day statement

No software can guarantee the absence of unknown or zero-day vulnerabilities. The design goal is defense in depth, rapid detection, minimal privileges, strict trust boundaries, and small blast radius.
