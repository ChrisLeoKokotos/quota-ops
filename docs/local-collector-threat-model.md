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
- normalized usage and reset metadata;
- sanitized Google statusLine files, hashed session watermarks and consented numeric token totals.

## Trust boundaries

1. **AI providers** — remote Claude / OpenAI quota responses; the user-operated, authenticated Google Antigravity CLI.
2. **Provider sessions** — isolated Claude/OpenAI browser profiles; Google's own authenticated CLI context.
3. **Local Google statusLine hook** — a user-configured CLI command receiving untrusted JSON on stdin and writing sanitized, per-account files. It does not authenticate the Google identity or capture credentials.
4. **Collector process** — validates provider state and aggregates consented numeric token observations.
5. **Loopback API** — authenticated local transport on `127.0.0.1:4317`.
6. **Dashboard server** — keeps the local bearer token server-side and proxies normalized snapshots.
7. **Browser UI** — receives normalized quota/token aggregates only.

Credentials must never cross the provider-session boundary into stored snapshots, the collector API or the UI. The Google hook's account ID is a local label and must not be treated as a verified Google account identity.

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

### Google statusLine event injection and privacy

**Threat:** local input forged as an Antigravity statusLine event, a wrong Google CLI identity associated with an account label, maliciously large payloads, unsafe local files, or collection of numeric token history without consent.

**Mitigations and limitations:**

- The hook requires a configured, enabled Google account ID and reads bounded stdin; unknown payload shapes and quotas outside accepted numeric ranges are rejected.
- Quota buckets use fractional remaining capacity only; unknown resets and events older than 15 minutes are not advertised as fresh.
- The raw payload (including email, prompts, workspace/transcript paths and authentication material) is not retained; only allowlisted quota fields and optional numeric counters enter per-account sanitized state.
- Google numeric Token Analytics is separately default-off and must be enabled **before** the event. Disabling stops new counters but does not erase prior observations; local deletion steps are in `PRIVACY.md`.
- The local files use bounded, atomic updates and reject symlinked/special target paths; protection from code running as the **same OS user** is not guaranteed. Account identity is not cryptographically attested.
- The hook is event-driven and cannot poll an inactive/closed CLI. The packaged-runtime setup and real authenticated account flow require owner verification.

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
- an authenticated Antigravity CLI hook is verified with the intended real Google identity, on supported Windows installation paths;
- Google statusLine quota freshness and consent revocation are verified on the packaged Windows build;
- hidden scheduled refresh behavior is verified over repeated cycles;
- session-expiry behavior is verified;
- token rotation is verified;
- collector remains inaccessible from the LAN;
- documentation matches observed behavior.

## Zero-day statement

No software can guarantee the absence of unknown or zero-day vulnerabilities. The design goal is defense in depth, rapid detection, minimal privileges, strict trust boundaries, and small blast radius.
