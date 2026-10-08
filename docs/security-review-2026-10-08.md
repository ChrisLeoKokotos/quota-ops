# QuotaOps attacker-perspective security architecture review

**Date:** 2026-10-08  
**Baseline:** main at 9ab42a9c6592808f78508c5eb2cba2ff1343274f  
**Scope:** static inspection of collector, Next.js snapshot proxy, token analytics, browser sessions, filesystem permissions and remote-runtime proposal.  
**Method:** attacker-oriented trust-boundary/code review; no user credentials accessed, no live target exploitation, no penetration test. Tests and CI are separate gates.

## Assets and attacker entry points

Protect provider browser cookies and access tokens, session histories (which can contain prompts, responses and source code), operational usage metadata, QuotaOps bearer token, and future remote machine credentials. Consider: LAN clients, a malicious website, a local unprivileged process, compromised npm packages, a compromised logged-in browser, and a malicious/compromised inference endpoint. Treat metadata as sensitive even if it contains no prompts.

## Findings and prioritized actions

### QO-SEC-01 — High: dashboard snapshot exposure if Next.js is reachable over a network

`app/api/collector/snapshot/route.ts` accepts a forgeable `X-QuotaOps-Client: dashboard` marker; it has no user authentication. The Host/Origin restrictions do not authenticate a non-browser HTTP client. The server-side collector bearer token protects the loopback collector, **not** the public Next.js route. When the Next.js service is externally reachable, an HTTP client capable of setting headers can retrieve normalized account labels, quota and token-usage metadata. This review does **not** establish that any current installation is network-exposed.

**Immediate mitigation in this PR:** pin the standard Next.js dev/start host to `127.0.0.1`; document that proxy/port forwarding/public hosting violates the current trust boundary. **Residual:** a user can still manually override the host or expose the service through a proxy. Before supporting remote UI access, implement actual user authorization and an independently verified network boundary; header-only checks must never be presented as authentication.

### QO-SEC-02 — Medium: broad access to raw session histories

`collector/token-analytics.ts` scans `~/.claude/projects`, `~/.codex/sessions`, and archived histories. Parsing is local and exports aggregate counts, but the collector process reads files that may include confidential conversations, code, and personal data. Any compromised dependency or collector execution with the same OS privileges could access that content.

**Before broader rollout:** separate the scanner into a least-privilege process where possible; explicitly disclose access to raw files; prohibit raw-line or raw-object logging; introduce opt-in per source and content-free numeric fixtures in privacy tests. Do not claim metrics-only file access.

### QO-SEC-03 — Medium: authenticated browser-profile and local debugging risk

Persistent Chrome/Edge profiles retain provider sessions. Scheduled Claude browser collection temporarily opens a loopback DevTools endpoint and OpenAI usage collection operates in an authenticated page. Another compromised process running with the same Windows identity may access those sessions or the debug port. Loopback binding and disabling extensions mitigate remote/browser exposure but are not OS isolation.

**Before stable release:** verify DevTools lifetime/termination and Windows identity boundaries with E2E tests; consider separate restricted OS identity for collectors and clear documentation of residual same-user compromise risk. Keep session tokens and API keys out of snapshots, errors and logs.

### QO-SEC-04 — Medium: large JSONL line and memory exhaustion

`collector/token-analytics.ts` limits per-file size (256 MiB) and number of files, but reads JSONL lines from a stream without a per-record maximum. A giant line or huge JSON object within the allowed file size can impose excessive parsing/heap usage, and scans repeat on the polling cycle.

**Follow-up:** enforce bounded lines/records, bounded cumulative scan budget, failure counters and cancellation; test adversarial synthetic data and partial-read behavior. Do not return untrusted line content in diagnostic errors.

### QO-SEC-05 — Medium: future remote runtime/API exposure

PR #19 currently discovers only a fixed loopback Ollama endpoint; it does not yet implement remote DGX/AMD or cloud-synced telemetry. A generic configurable host would expand the attack surface to SSRF, credential forwarding, untrusted responses, network egress and interception.

**Release gate for remote support:** explicit enrollment, least-privilege read-only agent, outbound-only mutual authentication where appropriate, host identity pinning, strict destination allowlists, TLS or authenticated private transports, no prompts/responses by default, no secrets in telemetry, payload size/time/rate limits, provenance/freshness metadata, credential rotation, revocation and retention limits. No internet-facing Ollama inference endpoints by default.

### QO-SEC-06 — Medium: supply-chain / release integrity

Pinned GitHub Actions, dependency review, CodeQL, repository guard and npm audit reduce risk but do not prove a package safe. A malicious dependency executing within the collector's process could read all files accessible to that process, including profiles and local histories.

**Follow-up:** minimize dependencies, review updates, publish reproducible builds and checksums/provenance, separate collector privileges, and conduct release-artifact inspection.

## Privacy / security invariants

1. No collection, storage, or transmission of prompt/response bodies as QuotaOps telemetry. Session files are read for numeric parsing today; the distinction must be disclosed.
2. No OAuth tokens, session cookies, API keys or private keys in collector HTTP snapshots, browser storage, logs, or exported diagnostics.
3. Default local-only operation: neither the collector nor the dashboard is externally reachable in the supported configuration.
4. Unknown/failed metrics must remain unknown/stale, not zero, online or available.
5. Any new remote adapter requires explicit threat-model update, negative security tests, and independent review before merge.

## Verification and limitations

This is a static review, **not** an exploit demonstration, live host audit, automated dependency audit or proof of absence of zero-days. The highest-priority verified design flaw is a missing independent authentication boundary at the Next.js proxy if network reachable. This PR mitigates the default host binding, but does not make remotely hosted QuotaOps safe. CI and runtime-network checks remain required.
