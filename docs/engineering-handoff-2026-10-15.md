# QuotaOps engineering handoff — 15 October 2026

**Scope:** repository audit, security remediation, PR backlog resolution, local and hosted validation, independent security review.
**Environment:** Windows 11 Home 26200, Node v22.22.2, npm 10.9.7, PowerShell, real Chrome.

This is an engineering record, not a release approval. **Nothing was merged.**
`main` is unchanged at `9ab42a9c6592808f78508c5eb2cba2ff1343274f`.

**Hosted CI:** unavailable for the first part of the session, then **restored**.
All four workflows now pass on every branch produced here. No check status was
fabricated at any point, and no failing check was marked as passing.

| Branch | Head | CI | CodeQL | Dependency review | Repository hygiene |
|---|---|---|---|---|---|
| `security/local-only-dashboard-review` (#20) | `3c0368d` | PASS | PASS | PASS | PASS |
| `ci/codeql-coordinated-upgrade` (#28) | `c182af7` | PASS | PASS | PASS | PASS |
| `feat/windows-one-click-launcher` (#21) | `44191c9` | PASS | PASS | PASS | PASS |
| `feat/local-runtime-ollama` (#19) | `5aa77bb` | PASS | PASS | PASS | PASS |

Every open PR is `BLOCKED` on `REVIEW_REQUIRED`. The "Protect main" ruleset
(deletion, non-fast-forward, linear history, pull request, required status
checks) requires a review, and nothing here bypasses it.

**Unresolved review threads across #19, #20, #21 and #28: zero.**

---

## A. Pull request disposition matrix

| PR | Status | Decision and rationale | Head | Local validation | Hosted CI | Remaining |
|---|---|---|---|---|---|---|
| **#11** `@types/node` 26.6.4 | **Recommend close** | Clean typecheck and tests, but raises the compiler's assumed runtime two majors above the supported one (`.node-version` 22.21.0). No concrete break found — every post-22 API probed exists in 22.22.2 — so this is structural: the typings stop guarding against post-22 API use. | unchanged | typecheck PASS, 41 tests | not run (`BEHIND`) | Your call; the upgrade is clean today |
| **#12** TypeScript 7.0.2 | **Compatible** | Zero diagnostics under the existing strict config. No `any` widening, no strictness relaxed. | unchanged | typecheck PASS, 41 tests, build PASS | not run (`BEHIND`) | Validated against `main` only — re-run after #20 |
| **#19** Ollama | **Ready pending reconciliation** | All three review threads closed with executable evidence, not inspection. `runtimesForDisplay` makes the stale-runtime clearing a tested invariant rather than a catch-block side effect. | `5aa77bb` | `npm ci`, typecheck, 58 tests, build — all PASS | **4/4 PASS** | Behind `main`; needs reconciling with #20's snapshot route; never run against a real Ollama install |
| **#20** Security | **Advanced; stays Draft** | QO-SEC-01 boundary rebuilt, QO-SEC-02 per-source consent, QO-SEC-04 scan budgets, eleven fixes from adversarial review, and Risk C option C2 (OS-allocated dashboard port). | `c1f256d` | typecheck, **114 tests**, build, Windows smoke, browser lifecycle, audit 0 vulns — all PASS | see table above | QO-SEC-03 E2E; independent **human** review |
| **#21** Windows launcher | **Reconciled with #20** | Discovers the dynamic dashboard port through the runtime descriptor and confirms the listener's identity. Branch now contains #20, so it builds and was validated as a merged tree. | `44191c9` | typecheck, 114 tests, build, probe verified in 5 states | see table above | Real double-click, Ctrl+C, orphan cleanup |
| **#22** Desktop EXE | **Architecture only — no EXE** | Design document. No shell, no packaging, no installer, no artifact. | unchanged | n/a | not run | Every packaging, testing and signing requirement unmet |
| **#23** Next.js 16.4.0 | **Compatible** | Clean typecheck/test/build. Must carry the regenerated `next-env.d.ts` and `tsconfig.json`. | unchanged | typecheck, 41 tests, build PASS | not run | Snapshot-proxy retest must run against #20's head |
| **#24** Playwright 1.64.0 | **Compatible** | Exercised the real launch path against real Chrome, not just types. No orphan processes, no debug listener. | unchanged | typecheck, 41 tests, browser smoke PASS | not run | Authenticated collection still unverified (QO-SEC-03) |
| **#25** CodeQL `init` | **Superseded by #28** | Failure is a configuration mismatch, not a code finding. | unchanged | n/a | CodeQL failing (expected) | Close once #28 merges |
| **#26** CodeQL `analyze` | **Superseded by #28** | As above. | unchanged | n/a | CodeQL failing (expected) | Close once #28 merges |
| **#27** `setup-node` 7.1.0 | **Safe to merge** | Tag `v7.1.0` = commit `949feb2…`. Inputs unchanged, Node pin explicit, `persist-credentials: false`, `permissions: contents: read`. | unchanged | provenance verified | not run | One hosted run |
| **#28** CodeQL coordinated | **Ready to merge** | Both P2 findings fixed. **CodeQL passes** — the evidence #25/#26 could never produce individually. | `c182af7` | typecheck, 56 tests, build PASS; guard mutation-verified | **4/4 PASS** | Your approval only |

---

## B. Security closure

Full dispositions: `docs/security-closure-2026-10-15.md`.

| Finding | Work | Disposition |
|---|---|---|
| **QO-SEC-01** Dashboard access | Forgeable marker removed. Trusted server owns the listener: binds loopback, destroys non-loopback peers before Next.js sees them, stamps a per-process marker. HMAC capability, constant-time verified, renewable. Port now OS-allocated per launch with identity-verified discovery. | **Closed** — Risk A accepted (A1), Risk C mitigated by C2, both recorded 2026-10-15 |
| **QO-SEC-02** History privacy | Per-source consent; unread sources report `disabled`, never `not_found`; migration preserves intent both ways; CLI exposes per-source control. | **Closed** — Risk B accepted (B1), recorded 2026-10-15 |
| **QO-SEC-03** Browser isolation | **The previous cleanup evidence was worthless** — it matched Chrome's executable path and always returned 0. Replaced with a detector that identifies QuotaOps browsers by `--user-data-dir` and reads launch arguments for a debugging port, plus a regression test that proves the detector sees a running browser. | **OPEN — release blocker.** Authenticated E2E still not run |
| **QO-SEC-04** Resource exhaustion | Time deadline, record ceiling, key-size cap, directory ceiling, daily-bucket cap. Exhausting any reports `partial`, never complete. | **Close**; worst-case profiling outstanding |
| **QO-SEC-05** Remote runtime | No remote collector. Ollama is loopback-fixed and test-asserted to contact only `127.0.0.1:11434`. | **Close as not applicable**; gate stands |
| **QO-SEC-06** Supply chain | 4 production dependencies, 0 vulnerabilities, all actions pinned to 40-char SHAs with verified provenance, pinning guard test. | **Close for source**; SBOM, checksums, signing remain blockers for a desktop release |

### Independent security review — performed, and it found real defects

A reviewer with the code and threat model but **not** my conclusions found
eleven confirmed defects. Highlights:

- **HIGH — a transparent loopback relay defeats the peer check.** `netsh
  interface portproxy`, a default nginx `proxy_pass`, `ssh -R`, Docker and
  tunnelling tools all connect from loopback and add no `X-Forwarded-*`
  header. No header-based fix exists. The code and tests claimed an enforced
  control; that wording is corrected and the risk is now **Risk C**.
- **The loopback classifier accepted two non-loopback addresses — and the test
  suite asserted this was correct.** Fixed structurally; 34 cases verified.
- **The security tests were source-text greps.** Each would have passed with
  its named control removed. Replaced with real TCP tests, mutation-verified.

Also fixed: unbounded key size, an unbounded directory walk running before the
deadline existed, unbounded daily buckets exceeding the proxy's size cap, one
malformed timestamp blanking the analytics panel, unvalidated runtime secrets
yielding an empty HMAC key, token rotation breaking both sides, and a
`HOSTNAME` check that protected nothing while breaking POSIX startup.

Judged sound: the capability HMAC construction, the collector's bearer token
handling, the snapshot proxy's limits, and — traced through every producer —
that no prompt text, file path, token or cookie reaches a snapshot, log, error
message or browser storage.

**Caveat:** the reviewer was another model instance with fresh context. That
removes anchoring, not shared blind spots. **A human security reviewer has
still not looked at this.**

---

## C. Windows desktop status

| Item | Status |
|---|---|
| Real EXE | **No** |
| Installer artifact | **None** |
| Build environment | not established |
| Checksums | n/a |
| Signing | **No certificate — owner dependency** |
| Clean-machine tests | not run |

Architectural input recorded on #22: the desktop shell must supervise
`server/dashboard-server.ts`, and replacing the HTTP hop with IPC would remove
both Risk A's loopback exposure and Risk C's relay exposure — a real security
argument for the desktop edition.

---

## D. Repository status

| Item | Value |
|---|---|
| `main` HEAD | `9ab42a9c6592808f78508c5eb2cba2ff1343274f` — unchanged |
| Open PRs | 12 |
| Open issues | 0 |
| Unresolved review threads | 0 across #19, #20, #21, #28 |
| Working tree | clean except `next-env.d.ts` and `tsconfig.json` — **preserved untouched**, identified as Next-generated artifacts belonging to #23 |
| Tests | **49 → 99** on the security branch |
| Branch protection | not modified, not bypassed |

---

## E. Owner dependencies

1. **Approve #28.** All four checks green, both P2 findings fixed, threads
   resolved. It unblocks CodeQL for everything else. Then #25 and #26 close as
   superseded.
2. **QO-SEC-03 E2E** — `docs/qo-sec-03-windows-e2e-procedure.md`. ~45 minutes,
   disposable account, PASS/FAIL and counts only. Step 3 can now actually fail.
   The last functional blocker.
3. **Independent human security review** — `docs/independent-review-package.md`
   is ready and asks specific questions. The earlier adversarial review was
   another model instance; it is not human sign-off.

Risks A, B and C were decided on 15 October 2026 (A1, B1, C2). C2 is
implemented. No further decision is needed on those.
5. **Code-signing certificate** — blocking for any published desktop build.
6. **Decision on #11** — Node 26 typings now, or typings aligned to the
   supported runtime.

---

## Recommended merge order

1. **#28**, then **#27** — CI infrastructure first.
2. **#20** after QO-SEC-03, the three risk decisions and human review.
3. **#21** (already integrated against #20), then **#19** reconciled.
4. **#23** carrying its two generated files, then **#24**; re-run the Windows
   smoke after each.
5. **#12** after re-typechecking the merged tree. **#11** closed unless you
   decide otherwise.
6. **#22** as an architecture document; desktop implementation in its own PR
   with its own security review.
