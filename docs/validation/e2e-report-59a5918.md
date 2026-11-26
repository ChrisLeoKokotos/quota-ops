# QO-SEC-03 evidence -- 59a5918

Generated 2026-10-19 16:56. Automated results only;
the manual rows need an interactive provider login.

| ID | Check | Status | Detail |
|---|---|---|---|
| `env.commit` | Commit under test | **INFO** | 59a5918fa2a150d173ce00069f279b2d65da9037 |
| `env.branch` | Branch | **INFO** | desktop/architecture-benchmark |
| `env.os` | Windows version | **INFO** | 10.0.26200 |
| `env.node` | Node.js | **INFO** | v22.22.2 |
| `env.cores` | Logical cores | **INFO** | 32 |
| `env.ram` | RAM (GB) | **INFO** | 31.1 |
| `auto.typecheck` | TypeScript typecheck | **PASS** | no diagnostics |
| `auto.tests` | Unit and security test suite | **PASS** | 145 of 146 passed, 0 failed |
| `auto.verification` | Verification primitives self-test | **PASS** | 18 case(s) verified |
| `auto.audit` | Production dependency audit | **PASS** | 0 vulnerabilities |
| `e2e06.detector` | Detector sees a browser, then reports zero | **PASS** | saw 8 process(es) running, 0 after teardown |
| `e2e06.orphans` | No QuotaOps browser processes right now | **PASS** | 0 running, 0 debug args, 0 debug-range listener(s) |
| `e2e07.security-check` | Collector security check | **PASS** | 6 profile(s) verified |
| `e2e07.consent` | Token Analytics consent state | **PASS** | Claude Code: disabled, Codex: disabled |
| `e2e07.acl` | QuotaOps home is not world-readable | **PASS** | no broad principals; 4 ACE(s) total |
| `net.collector-port` | Collector binds loopback only | **PASS** | 1 loopback listener(s) |
| `net.debug-range` | No listeners in the DevTools port range | **PASS** | none |
| `E2E-01` | First login and collection | **MANUAL** | run it, then record PASS or FAIL |
| `E2E-02` | Session reuse without re-login | **MANUAL** | run it, then record PASS or FAIL |
| `E2E-03` | Session expiry reports login_required | **MANUAL** | run it, then record PASS or FAIL |
| `E2E-04` | Two accounts stay isolated | **MANUAL** | run it, then record PASS or FAIL |
| `E2E-05` | Offline and timeout reporting | **MANUAL** | run it, then record PASS or FAIL |
| `E2E-08` | Desktop shell shows account data | **MANUAL** | run it, then record PASS or FAIL |
| `E2E-09` | Repeated refresh cycles stay stable | **MANUAL** | run it, then record PASS or FAIL |

Automated: 11 PASS, 0 FAIL, 0 SKIP, 0 INCONCLUSIVE. Manual outstanding: 7.

SKIP means the precondition was absent, INCONCLUSIVE means the check
could not run. Neither is evidence of correct behaviour.

This file contains counts and states only -- no credentials, tokens,
cookies, profile paths, session files or raw ACL contents. It is safe
to attach to a pull request as written.
