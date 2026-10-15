# QuotaOps engineering handoff — 15 October 2026

**Session scope:** repository audit, security remediation, PR backlog resolution, local validation.
**Environment:** Windows 11 Home 26200, Node v22.22.2, npm 10.9.7, PowerShell, real Chrome.
**Hosted CI:** unavailable for the whole session. No check status was fabricated, and no failing check was marked as passing.

This is an engineering record, not a release approval. Nothing was merged.

---

## A. Pull request disposition matrix

| PR | Final status | Decision and rationale | Head commit | Local validation | Hosted CI | Remaining limitations |
|---|---|---|---|---|---|---|
| **#11** `@types/node` 26.6.4 | **Recommend close** | Typechecks and tests clean, but raises the compiler's assumed runtime two majors above the supported one (`.node-version` 22.21.0). No concrete break found — every post-22 API probed exists in 22.22.2 — so this is a structural risk, not a defect: the typings stop guarding against post-22 API use. | unchanged | typecheck PASS, 41 tests PASS | not run | Owner's judgement call; upgrade is clean today |
| **#12** TypeScript 7.0.2 | **Compatible, ready after rebase** | Zero diagnostics under the existing strict config. No `any` widening, no strictness relaxed. | unchanged | typecheck PASS, 41 tests PASS, build PASS | not run | Validated against `main`'s source only — re-run after #20 adds three new modules |
| **#19** Ollama runtime | **Advanced; 3 review threads answered** | All three threads now have executable evidence. Added `runtimesForDisplay` so the "clear stale runtime" behaviour is a tested invariant rather than a catch-block side effect. | `5aa77bb` | `npm ci` PASS, typecheck PASS, 58 tests PASS, build PASS | not run | No real Ollama install on this host; branch behind `main`, needs reconciliation with #20 |
| **#20** Security | **Advanced; stays Draft** | QO-SEC-01 authorization boundary rebuilt, QO-SEC-02 per-source consent added, QO-SEC-04 scan budgets added. | `0691acc` | typecheck PASS, **86 tests** PASS (was 49), build PASS, Windows smoke PASS, browser smoke PASS, audit 0 vulns | not run | QO-SEC-03 open; no independent review; residual risks need owner acceptance |
| **#21** Windows launcher | **Blocked on #20 integration** | Found a blocking interaction: the BAT calls `next dev` directly, which bypasses the new peer-enforcement layer and leaves the snapshot route failing closed. One-line fix identified. Readiness check still only proves the dashboard responds, not that the collector is operational. | unchanged | dependency and port pre-flight logic reviewed | not run | Double-click, occupied-port, Ctrl+C and orphan-process behaviour unverified |
| **#22** Desktop EXE | **Architecture only — no EXE** | Design document; no shell, no packaging, no installer, no artifact. Contributed an architectural input: the desktop shell must supervise `server/dashboard-server.ts`, and can remove QO-SEC-01's same-account residual risk via IPC or an ephemeral port. | unchanged | n/a | not run | Every packaging, testing and signing requirement unmet |
| **#23** Next.js 16.4.0 | **Compatible; must carry two files** | Clean typecheck/test/build. Determined that the repository's long-standing uncommitted `next-env.d.ts` and `tsconfig.json` changes are **byte-identical** to 16.4.0's generated output — they belong in this PR. | unchanged | typecheck PASS, 41 tests PASS, build PASS | not run | Snapshot-proxy retest must happen against #20's head, not `main` |
| **#24** Playwright 1.64.0 | **Compatible** | Exercised the real launch path, not just types: copied #20's browser smoke in and ran it against real Chrome. Passed; no orphan processes, no debug listener. | unchanged | typecheck PASS, 41 tests PASS, browser smoke PASS | not run | Authenticated collection still unverified (QO-SEC-03) |
| **#25** CodeQL `init` | **Superseded by #28** | Comment posted explaining the failure is a configuration mismatch, not a code finding. Left open until #28 merges. | unchanged | n/a | CodeQL failing (expected) | Close once #28 lands |
| **#26** CodeQL `analyze` | **Superseded by #28** | As above. | unchanged | n/a | CodeQL failing (expected) | Close once #28 lands |
| **#27** `setup-node` 7.1.0 | **Safe to merge** | Tag `v7.1.0` verified as commit `949feb2…`. Inputs unchanged, Node pin explicit, cache key unchanged, `persist-credentials: false`, workflow `permissions: contents: read`. | unchanged | provenance verified | not run | Needs one successful hosted run |
| **#28** CodeQL coordinated *(new)* | **Open, created this session** | Upgrades `init` and `analyze` together to the same verified SHA, adds a Dependabot group, adds a pinning guard test. | `65543d4` | YAML parse PASS, guard test 3/3 PASS, guard verified to reject a reintroduced split | not run | Needs a real CodeQL run before merge |

---

## B. Security closure report

Full dispositions: `docs/security-closure-2026-10-15.md`. Evidence commit `ec223ff` / `0691acc`.

| Finding | Work done | Disposition |
|---|---|---|
| **QO-SEC-01** Dashboard snapshot access | Forgeable `X-QuotaOps-Client` marker removed. `server/dashboard-server.ts` owns the listener: binds loopback, refuses non-loopback `HOSTNAME`, destroys non-loopback connections, refuses proxied requests, stamps a per-process marker after deleting inbound copies. HMAC capability minted per process, constant-time verified, re-issued through a loopback-gated endpoint. Route fails closed without the trusted server. 26 negative tests + 7 live refusals + LAN probe. | **Close with accepted residual risk** — a same-account process can still reach the loopback listener |
| **QO-SEC-02** Session-history privacy | Per-source consent (`tokenAnalyticsSources`); unread sources report `disabled`, never `not_found`; migration preserves intent both ways; CLI exposes per-source control; foreground `tokens` refuses without consent. Verified live against the existing six-profile config. | **Close with accepted residual risk** — scanner is not OS-isolated |
| **QO-SEC-03** Browser/session isolation | Confirmed 0 orphan browser processes and 0 listeners on 9222–9322 after collection, under both Playwright 1.63 and 1.64. | **OPEN — release blocker.** Lifecycle test is synthetic; real authenticated collection unverified |
| **QO-SEC-04** JSONL resource exhaustion | Found that size budgets did not bound scan *time* or aggregation state — a large **valid** corpus could exhaust the heap each polling cycle. Added a 20 s per-source deadline and a 200k tracked-record ceiling with cancellation; exhaustion reports `partial`, never complete. | **Close**; worst-case profiling outstanding |
| **QO-SEC-05** Remote runtime | No remote collector exists. Ollama is loopback-fixed and now test-asserted to contact only `127.0.0.1:11434`. Dashboard host is not configurable. | **Close as not applicable**; gate stands for any future remote work |
| **QO-SEC-06** Supply chain | 4 production dependencies, `npm audit --omit=dev` 0 vulnerabilities, all actions pinned to 40-char SHAs, CodeQL and setup-node provenance verified against upstream tags, new pinning guard test. | **Close for source**; SBOM, checksums, reproducible release and signing remain blockers for a desktop release |

**Independent review: not performed.** The closure document was written by the party that implemented the changes.

---

## C. Desktop release report

| Item | Status |
|---|---|
| Architecture | Proposed only (#22): Electron + bundled Next.js standalone + supervised collector |
| Installer / build location | **None — no artifact exists** |
| Application version | n/a |
| Checksum | n/a |
| Signing status | **No certificate available — owner dependency** |
| Supported Windows versions | undetermined |
| Install / upgrade / uninstall validation | not run |
| Known limitations | Every packaging, hardening, clean-machine and distribution requirement is unmet |

A real Windows desktop EXE was **not** implemented this session. Recorded as a blocker, not described as complete.

---

## D. Final repository status

| Item | Value |
|---|---|
| `main` HEAD | `9ab42a9c6592808f78508c5eb2cba2ff1343274f` — unchanged, nothing merged |
| Open PRs | **12** (11 original + #28) |
| Open issues | 0 |
| New branches pushed | `ci/codeql-coordinated-upgrade`, plus commits onto `security/local-only-dashboard-review` and `feat/local-runtime-ollama` |
| Working tree | Clean except the owner's `next-env.d.ts` and `tsconfig.json` — **preserved untouched**, now identified as Next.js 16.4.0 output belonging to #23 |
| Local CI matrix (`0691acc`) | typecheck PASS · 86 tests PASS · build PASS · `git diff --check` clean · Windows security smoke PASS · browser smoke PASS · `security-check` PASS (6 profiles) · `tokens-auto status` disabled · `npm audit --omit=dev` 0 vulns |
| Hosted CI | **Unavailable all session.** No CodeQL, Dependency Review or Repository Guard result exists for any head produced here |
| Branch protection | Not modified, not bypassed |

**Tests: 49 → 86** on the security branch, plus 10 new Ollama collector tests and 3 workflow-pinning tests on their branches.

---

## E. Owner dependencies

These need a person; they are not work that can be completed autonomously.

1. **Windows E2E with a disposable provider account** — the single blocking item for QO-SEC-03. Verify initial login, existing session reuse, session expiry, account switching, collection failures, profile ACLs and long-running process cleanup. Report PASS/FAIL and sanitized reasons only; send no cookies, tokens, profile contents, `icacls` dumps or screenshots containing session material.
2. **Acceptance of two residual risks** — QO-SEC-01 and QO-SEC-02 both end at the same boundary: a process running under your Windows account can reach the loopback listener and read the same files. Both are proposed for closure *with that accepted*, and both need your explicit decision.
3. **Independent security re-review** — by someone other than the implementer, covering the capability design and the six dispositions. PR #20 should stay Draft until then.
4. **GitHub Actions billing** — required checks cannot run. Local validation does not substitute for CodeQL, and branch protection was deliberately not weakened to work around this.
5. **Code-signing certificate and release identity** — blocking for any published Windows desktop build.
6. **Decision on #11** — whether to take Node 26 typings now or keep typings aligned to the supported runtime.

---

## Recommended merge order

1. **#28** (CodeQL) and **#27** (setup-node) once Actions run — they unblock every other PR's checks.
2. **#20** after QO-SEC-03 E2E, residual-risk acceptance and independent review.
3. **#21** with the one-line `npm run dev` fix, then **#19** reconciled onto the new snapshot route.
4. **#23** carrying `next-env.d.ts` and `tsconfig.json`, then **#24**, re-running the Windows smoke after each.
5. **#12** after re-typechecking against the merged tree. **#11** closed unless you decide otherwise.
6. **#22** merged as an architecture document; desktop implementation in its own PR with its own security review.

Close **#25** and **#26** as superseded once **#28** merges.
