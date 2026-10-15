# QuotaOps security closure — QO-SEC-01 through QO-SEC-06

**Date:** 2026-10-15
**Evidence commit:** `ec223ff657835fe765489d88dc581d5cc78192b1` (`security/local-only-dashboard-review`, PR #20)
**Baseline review:** `docs/security-review-2026-10-08.md`
**Prepared by:** engineering (Claude Code session)
**Independent review:** **NOT PERFORMED** — see "Approval status"

This document records a disposition per finding. It is not an approval.
Three findings are proposed for closure, two are proposed for closure with
accepted residual risk, and one remains an open release blocker.

---

## QO-SEC-01 — Unauthorized dashboard snapshot access

**Initial threat.** `app/api/collector/snapshot/route.ts` accepted a forgeable
`X-QuotaOps-Client: dashboard` header. Any HTTP client able to set headers could
read account labels, quota percentages and token metadata whenever the Next.js
service was reachable. Host and Origin checks do not authenticate a non-browser
client, and the collector's bearer token protected the collector, not this route.

**Implementation.** Two independent controls replace the marker.

1. *Peer enforcement.* `server/dashboard-server.ts` now owns the listener. It
   binds `127.0.0.1`, refuses a non-loopback `HOSTNAME` at startup, destroys
   non-loopback connections before Next.js sees them, refuses proxied requests,
   and stamps each surviving request with a per-process marker after deleting
   any inbound copy. `npm run dev` and `npm start` route through it, so the
   documented commands cannot bypass the enforcement layer.
2. *Capability.* `lib/dashboard-authorization.ts` mints an HMAC capability from
   a 32-byte per-process secret, verified in constant time with an expiry.
   `/api/collector/capability` re-issues it for a long-running tab, gated by the
   same loopback boundary.

The route fails closed when the trusted server is absent rather than falling
back to header checks. The proxy-header control lives in the server layer
because Next.js synthesizes its own `x-forwarded-*` headers downstream — a
route handler cannot distinguish those from client input. This was found by
testing, not by inspection, and is recorded in the code comment.

**Tests.** 26 negative authorization tests in
`tests/dashboard-authorization.test.ts` and `tests/dashboard-listen-security.test.ts`,
plus a seven-case live HTTP suite in `scripts/windows-security-smoke.ps1`.

| Live case | Result |
|---|---|
| Retired `X-QuotaOps-Client: dashboard` marker | 403 |
| No capability | 403 |
| Forged trusted-peer marker and peer address | 403 |
| Proxied request (`X-Forwarded-For`) | 403 at server layer |
| Tampered capability MAC | 403 |
| Non-loopback `Host` | 403 |
| Cross-origin `Origin` | 403 |
| Valid capability | reaches the collector hop (503, collector not running) |
| Listener binding | `127.0.0.1` only |
| TCP connect to the host's own LAN address | refused |
| `HOSTNAME=0.0.0.0` startup | refused, does not listen |

**Residual risk.** Any process running under the same Windows account can call
the capability endpoint over loopback and read a snapshot. This design bounds
*network* exposure; it is not a defence against same-user local compromise.
A deliberately configured reverse proxy or port forward remains an unsupported
deployment — it is now refused rather than served, but an operator who
terminates TLS elsewhere and rewrites headers is outside what this code can
enforce.

**Not established.** A LAN scan from separate hardware (case 11 probes the
host's own interface, which is weaker evidence) and any hosted CodeQL result.

**Proposed disposition.** Close, with the same-account residual risk accepted.
**Requires:** owner acceptance of that residual risk; independent re-review.

---

## QO-SEC-02 — Session-history access and privacy

**Initial threat.** The collector scanned `~/.claude/projects` and
`~/.codex/sessions`, which can contain prompts, responses and source code. One
switch governed both sources, so a user who wanted Claude Code totals had to
grant access to their Codex history too.

**Implementation.** `tokenAnalyticsSources` records consent per source. The
scanner reads only consented sources. The master switch cannot be true while
both sources are false. Migration preserves intent: a configuration that had
already opted in keeps both sources; one that had not stays opted out of both.
A source that was not read reports `disabled`, never `not_found` — QuotaOps
did not look, so it must not imply it looked and found nothing. The foreground
`tokens` CLI command refuses to scan without consent. Per-source control is
exposed as `tokens-auto <enable|disable|status> [claude-code|codex|all]`.

**Tests.** `tests/privacy-defaults.test.ts` covers fresh defaults, all four
migration cases including malformed consent records, and asserts a
no-consent snapshot contains no file path, no `.jsonl`, no `.claude`/`.codex`
path fragment and no history text.

**Live verification.** On this Windows host, an existing six-profile
configuration with no consent record migrated to both sources disabled, and
`collector:setup -- security-check` passed afterwards.

**Residual risk — explicit.** The scanner runs in the collector process under
the user's own Windows account. Malware or a compromised dependency executing
under that same account can read every file the account can read, including
these histories, regardless of QuotaOps consent settings. Consent controls what
*QuotaOps* reads; it is not an OS privilege boundary.

**Not implemented.** Separating the scanner into a restricted OS process. This
was listed as "where feasible"; it is not done, and the alternative offered
here is consent granularity plus content-free output, not isolation.

**Proposed disposition.** Close with accepted residual risk.
**Requires:** owner's explicit acceptance of the same-account risk, or a
decision to fund process isolation before release.

---

## QO-SEC-03 — Browser-profile and authenticated-session isolation

**Initial threat.** Persistent Chrome/Edge profiles retain provider sessions,
and the previous scheduled collection opened an unauthenticated loopback
DevTools endpoint.

**Progress.** The DevTools TCP transport was removed from scheduled Claude
collection in earlier work on this branch. On this host, after running the
synthetic browser lifecycle test:

- QuotaOps browser processes still running: **0**
- Listeners in the remote-debugging port range 9222–9322: **0**
- `scripts/windows-browser-smoke.ts`: PASS (Chrome opened and closed)
- Verified again under Playwright 1.64.0 (PR #24): PASS

**Not established — this is the blocking gap.** The lifecycle test is
*synthetic*. It never logs into a provider. None of the following is verified:
initial login, existing session reuse, session expiry, account switching,
collection failure paths with real credentials, profile ACL ownership across
accounts, or long-running process cleanup under real authenticated load.

**Proposed disposition.** **OPEN — release blocker.**
**Requires:** owner-run Windows 11 E2E with a disposable test provider account.
Report PASS/FAIL and sanitized reasons only; do not send cookies, tokens,
profile contents, `icacls` dumps or screenshots containing session material.

---

## QO-SEC-04 — JSONL parser resource exhaustion

**Initial threat.** Unbounded line/record parsing within an allowed file size.

**Prior work on this branch.** Bounded reader, 2 MiB per-record limit, 256 MiB
per-file and 512 MiB per-source budgets, synthetic oversized and malformed
record tests.

**Gap found in this review.** Size budgets alone do not bound a scan. A corpus
that stays inside every size limit can still cost unbounded wall-clock time,
and the Claude de-duplication map and Codex seen-id set grew once per distinct
record id — so a large *valid* corpus could exhaust the heap on each polling
cycle, with no malformed file involved.

**Implementation.** A 20 s per-source deadline and a 200,000 tracked-record
ceiling, checked between files, between chunks and between records via a new
`shouldStop` hook on the bounded reader. A scan that hits either budget stops
and reports the source `partial` with a numeric reason, so totals are never
presented as complete after a rejected or abandoned file.

**Tests.** `tests/bounded-jsonl.test.ts` covers mid-file cancellation, a budget
already spent before the first record, and the uncancelled path. Existing tests
continue to cover oversized unbroken lines, malformed records and missing files.
No diagnostic message carries file content; messages name counts and budgets.

**Not done.** Worst-case memory and execution-time profiling on representative
Windows hardware with a pathological-but-valid corpus. The budgets are enforced
and tested; the *measured* worst case is not recorded.

**Proposed disposition.** Close pending the profiling run, or close with
profiling tracked as a follow-up — owner's call.

---

## QO-SEC-05 — Remote runtime security

**Status.** No remote collector exists. The Ollama integration (PR #19)
contacts a fixed loopback origin, and a new test asserts that only
`http://127.0.0.1:11434` is contacted. The dashboard server refuses a
non-loopback `HOSTNAME`, so the local-only release cannot be turned into a
remote-access deployment through configuration.

**Proposed disposition.** Close as "not applicable to this release", with the
gate standing: any remote runtime, GPU host, cloud agent or distributed
collector requires its own threat model, enrollment and identity design,
authenticated transport, destination allowlist, read-only telemetry boundary,
rate and size limits, and negative security tests **before** implementation.

---

## QO-SEC-06 — Dependency and release supply chain

**Evidence on this commit.**

| Control | Result |
|---|---|
| Production dependency tree | 4 direct packages: `next`, `react`, `react-dom`, `playwright-core` |
| `npm audit --omit=dev --audit-level=high` | 0 vulnerabilities |
| Deterministic install | `npm ci` from `package-lock.json` |
| GitHub Actions pinning | all pinned to 40-character commit SHAs |
| Pinning guard | `tests/workflow-pinning.test.ts` (PR #28) fails on an unpinned action, a missing version comment, or CodeQL version drift |
| CI permissions | `contents: read`; `persist-credentials: false` on checkout |
| CodeQL provenance | tag `v4.38.3` dereferences to `24c54180a607b1449ed407dd24f251e4e9147c8d` |
| setup-node provenance | tag `v7.1.0` is commit `949feb2413d6458794dcd2491c4babbbce0c15c1` |

**Not done.** SBOM generation, release checksums, a reproducible release
procedure, and Windows code signing. No distributable artifact exists yet, so
these are not yet applicable — but they are **hard release blockers** for any
published Windows build.

**Proposed disposition.** Close for the current source-only state; the
distribution controls remain blocking for a desktop release.

---

## Approval status

| Finding | Disposition | Blocking? |
|---|---|---|
| QO-SEC-01 | Close with accepted same-account residual risk **and Risk C** | Needs owner acceptance; Risk C is new and rated HIGH |
| QO-SEC-02 | Close with accepted same-account residual risk | Needs owner acceptance |
| QO-SEC-03 | **OPEN** | **Yes** — real-account Windows E2E outstanding |
| QO-SEC-04 | Close; profiling outstanding | Owner's call |
| QO-SEC-05 | Close as not applicable; gate stands | No |
| QO-SEC-06 | Close for source; distribution controls outstanding | Yes, for a desktop release |

## Independent security review — performed 2026-10-15

An adversarial review was carried out by a reviewer with no knowledge of the
implementation decisions, given the code and the threat model but not this
document or any of its conclusions. It found eleven confirmed defects and five
plausible ones. It did not rubber-stamp the design.

**The headline finding is QO-SEC-01 related and rated HIGH:** a transparent
loopback relay defeats the peer check, and the proxy control only catches a
proxy that identifies itself. There is no header-based fix. The overclaim in
the code and tests is corrected; the risk itself is now Risk C in
`docs/residual-risk-decision.md` and needs an owner decision.

Fixed in `2b8921e` and the commit that follows it:

| Finding | Severity | Resolution |
|---|---|---|
| Loopback classifier accepted `::127.0.0.1` and `::ffff:0:127.0.0.1` — **and the test suite asserted this was correct** | MEDIUM | Structural eight-group expansion; 34 cases verified; the wrong assertions replaced |
| Aggregation keys bounded by count but not size — 200k keys of up to 2 MiB each | MEDIUM | Ids over 200 chars replaced by a digest |
| Directory walk unbounded and running before the deadline was created | MEDIUM | Own directory ceiling, and the deadline now starts before the walk |
| Daily buckets unbounded and serialised into every snapshot past the proxy's 256 KiB cap | MEDIUM | Most recent 800 kept; source reports partial |
| One malformed timestamp blanked the whole analytics panel | MEDIUM | Year padded, out-of-range dates rejected at the producer |
| Runtime secrets accepted without validation; `Buffer.from` yields an empty HMAC key for junk | LOW | Shape and length checked; fails closed |
| Collector token cached for the process lifetime; rotation broke both sides | LOW | A 401 drops the cache and retries once |
| `HOSTNAME` check protected nothing and broke startup in POSIX shells | LOW | Replaced by an assertion on the address actually bound |
| Named controls in `dashboard-listen-security.test.ts` were source-text greps | MEDIUM | Replaced by `tests/dashboard-boundary.test.ts`, which drives real TCP connections; mutation-checked |

Accepted as correct without change, with reasons recorded:

- Collector rate limiter counts only authenticated requests (a 256-bit token
  makes brute force irrelevant; the limiter is not the control).
- Windows ACL inheritance is not read back after `icacls`. Genuine gap, but it
  needs a second local user to test properly — folded into the QO-SEC-03
  owner procedure rather than guessed at here.
- `rawHeaders` retains inbound marker copies. Confirmed not reachable in Next
  16.3.8, which reads `req.headers`; recorded as latent.

**The review also judged several controls sound** on inspection, including the
capability HMAC construction and canonicalisation, the collector's bearer
token handling, the snapshot proxy's size and redirect limits, and — the
strongest finding in the implementation's favour — that no prompt text, file
path, token or cookie reaches a snapshot, log, error message or browser
storage. That last one was traced through every producer.

**This does not substitute for human review.** The reviewer was another model
instance with fresh context, which removes the anchoring problem but not the
shared blind spots. A human security reviewer has still not looked at this.

**Hosted checks: not run.** No CodeQL, Dependency Review or Repository Guard
result exists for `ec223ff`. Local tests are not a substitute, and no check
status has been fabricated or marked passing.
