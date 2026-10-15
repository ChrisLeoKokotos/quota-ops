# Independent security review package — QuotaOps

**Prepared:** 15 October 2026
**For:** an independent human security reviewer
**Subject:** PR #20, head `3844210`, branch `security/local-only-dashboard-review`
**Status of this request:** mandatory gate. PR #20 does not leave Draft without it.

A model-assisted adversarial review was run earlier. It found eleven confirmed
defects, including two in the implementer's own tests, and all are fixed. It is
**not** human sign-off and is not offered as one. What follows is the material
needed to review the implementation, not just the documentation.

---

## 1. What the product is

QuotaOps monitors AI provider quota usage (Claude, OpenAI) and local AI
runtimes. It runs entirely on the user's Windows machine. There is no QuotaOps
backend, no hosted database and no account system.

Two processes:

| Process | Binding | Purpose |
|---|---|---|
| Collector | `127.0.0.1:4317`, fixed | Drives browser automation against provider sites; parses local session-history JSONL |
| Dashboard | `127.0.0.1:<OS-allocated>` | Next.js UI; proxies snapshots from the collector |

**Assets:** provider browser cookies and access tokens; local session histories
(which contain prompts, responses and source code); the collector bearer token;
usage metadata.

**Attacker classes considered:** a LAN client; a malicious website open in the
user's browser; an unprivileged local process running as the same Windows user;
a compromised npm dependency; a misconfigured or hostile local relay.

---

## 2. Where to look

Authorization and network boundary:

| File | Role |
|---|---|
| `server/dashboard-server.ts` | Trusted host: binds loopback, allocates the port, owns the descriptor lifecycle |
| `lib/dashboard-boundary.ts` | Per-request boundary: peer check, proxy check, marker stamping |
| `lib/dashboard-authorization.ts` | Loopback classifier, capability mint/verify, request evaluation |
| `lib/dashboard-runtime.ts` | Per-process secrets, shape-validated |
| `lib/dashboard-descriptor.ts` | Runtime descriptor: write, read, probe, cleanup |
| `app/api/collector/snapshot/route.ts` | Snapshot proxy |
| `app/api/collector/capability/route.ts` | Capability re-issue |

Collector and secrets: `collector/security.ts`, `collector/service.ts`,
`collector/config.ts`, `collector/paths.ts`.

Parsing, limits and privacy: `collector/bounded-jsonl.ts`,
`collector/token-analytics.ts`.

---

## 3. The authorization design, in one pass

A snapshot request must satisfy all of:

1. **TCP peer is loopback.** Checked against `socket.remoteAddress`, never a
   header. Non-loopback connections are destroyed before Next.js sees them.
2. **No self-identifying proxy headers.** Hygiene only — see §5.
3. **Trusted marker present.** A 256-bit per-process value the server stamps
   after deleting every inbound copy. Not forgeable from outside the process.
4. **Host and Origin are loopback and same-origin.**
5. **Valid capability.** HMAC-SHA256 over `qo1.<expiry>` with a 32-byte
   per-process secret, constant-time compared, expiry checked after the MAC.

Without the trusted server, both routes fail closed — there is no header-only
fallback.

**Questions worth pressing on:**

- The capability endpoint is gated by 1–4 but deliberately not by 5, because an
  expired capability is the condition it exists to repair. Is that right?
- The capability adds nothing against a local process that can simply call the
  capability endpoint. Is it earning its complexity, or is the peer check doing
  all the work?
- `evaluateTrustedLocalRequest` skips the Origin check entirely when the header
  is absent. The earlier review traced the browser-attacker paths and found no
  read, but `Sec-Fetch-Site` is consulted nowhere.

---

## 4. The six original findings

Full text: `docs/security-review-2026-10-08.md`. Dispositions:
`docs/security-closure-2026-10-15.md`.

| ID | Summary | State |
|---|---|---|
| QO-SEC-01 | Dashboard snapshot readable via a forgeable header | Closed; Risk A accepted, Risk C mitigated |
| QO-SEC-02 | Broad access to raw session histories | Closed; Risk B accepted, consent per source and default-off |
| QO-SEC-03 | Browser-profile and authenticated-session isolation | **OPEN** — authenticated E2E not yet run |
| QO-SEC-04 | JSONL resource exhaustion | Closed; time, record, key-size, directory and bucket budgets |
| QO-SEC-05 | Future remote runtime exposure | Closed as not applicable; gate stands |
| QO-SEC-06 | Dependency and release supply chain | Closed for source; signing and SBOM remain blockers for a desktop release |

---

## 5. The transparent-relay finding — the part most worth your attention

**Rated HIGH by the earlier review. Mitigated, not closed.**

The boundary asks one question: did this TCP connection arrive from
`127.0.0.0/8`? Any relay that forwards from loopback answers yes on a remote
caller's behalf:

```
netsh interface portproxy add v4tov4 listenport=8080 connectaddress=127.0.0.1 connectport=<dashboard>
```

…or an nginx `proxy_pass` with no `proxy_set_header` lines, `ssh -R`, `socat`,
a Docker mapping, a VS Code or ngrok tunnel. **None add an `X-Forwarded-*`
header**, so the proxy check never fires. It catches a proxy that identifies
itself. There is no header-based way to catch one that does not.

**What was done (Risk C, option C2, owner-approved):** the dashboard takes an
OS-allocated port each launch. A relay configured in advance against a fixed
3000 now reaches nothing.

**What was not done:** a relay aimed at the port currently in use is still
served. The port is not a secret — any process that can list listening sockets
finds it.

Both halves are asserted in `tests/dashboard-relay-exposure.test.ts`. The test
named *"C2 limit: a relay aimed at the active port is still served"* **passes on
purpose**, so a green suite can never be misread as "relays are blocked".

**Please assess:** whether C2 is a reasonable stopping point for a local-first
product, or whether C3 (a per-launch secret path) or the desktop IPC direction
should be required before release.

---

## 6. Owner decisions already taken

Recorded 15 October 2026 in `docs/residual-risk-decision.md`. **Not open for
re-litigation**, but their *consequences* are in scope for you.

| Risk | Decision |
|---|---|
| **A** — a process running as the same Windows user reaches the loopback services, the collector token and the browser profiles | **A1 — accepted.** Documented as a limit of the local-only architecture |
| **B** — consent governs what QuotaOps reads, not the files' Windows permissions | **B1 — accepted.** Consent stays per-source and default-off |
| **C** — transparent loopback relay | **C2 — implemented.** Mitigation, not elimination |

`PRIVACY.md` and `SECURITY.md` now state these limits in plain language. Worth
checking that the published wording matches what the code actually does.

---

## 7. The dynamic-port implementation

`server/dashboard-server.ts`, `lib/dashboard-descriptor.ts`.

- `listen(0)` — the OS allocates and binds in one step, so there is no
  check-then-bind race. No fallback to 3000, deliberately.
- Next.js needs the port at construction and the port is known only after
  binding, so the server binds first and answers `503 dashboard_starting`
  until `prepare()` resolves. No second listener is used to discover a port.
- Discovery: `~/.quotaops/dashboard-runtime.json`, written atomically at 0600,
  holding version, port, pid, a per-launch instance id and a timestamp. **No
  capability secret, no bearer token.**
- A reader never trusts the file: it fetches `/__quotaops/instance` and
  requires the listener to echo the recorded instance id. A reused pid or a
  crash-leftover file therefore reads as stale.
- A second instance refuses to start beside a live one rather than overwriting
  its descriptor; cleanup removes the file only when it is still ours.

**Questions worth pressing on:**

- `/__quotaops/instance` is served before the boundary's capability check
  (it is behind the peer and marker checks). It discloses a pid and a random
  id. Acceptable?
- `QUOTAOPS_DESCRIPTOR_PATH` exists as a test seam. It changes where discovery
  looks but cannot grant access, since identity is verified at the listener.
  Agree?

---

## 8. Test evidence

`npm test` — **114 tests, 0 failures** at `3844210`.

| Area | File |
|---|---|
| Authorization evaluator, loopback classifier, capability | `tests/dashboard-authorization.test.ts` |
| Boundary behaviour over real TCP, mutation-checked | `tests/dashboard-boundary.test.ts` |
| Descriptor liveness, staleness, ownership | `tests/dashboard-descriptor.test.ts` |
| Transparent relay — benefit **and** limit | `tests/dashboard-relay-exposure.test.ts` |
| Capability renewal and retry | `tests/collector-client-capability.test.ts` |
| Consent, migration, metrics-only output | `tests/privacy-defaults.test.ts` |
| JSONL bounds and cancellation | `tests/bounded-jsonl.test.ts` |
| Collector token and path containment | `tests/collector-security.test.ts` |

Windows scripts:

- `scripts/windows-security-smoke.ps1` — loopback-only listener, seven refused
  unauthorized requests, capability round trip, LAN probe.
- `scripts/windows-browser-processes.ps1` — identifies QuotaOps browsers by
  `--user-data-dir`, reports inconclusive rather than zero when a process
  cannot be inspected, and reads launch arguments for a debugging port.
- `scripts/windows-browser-lifecycle-check.ts` — proves the detector sees a
  running browser before asserting a clean teardown.

**A caution on the suite:** several tests open real TCP connections. Running
`npm test` repeatedly in a tight loop on Windows exhausts the ephemeral port
range (16,384 ports) and produces `fetch failed`. That is the environment, not
the code — but it will look like flakiness if you hit it.

---

## 9. Dependency audit

| Check | Result |
|---|---|
| Production dependencies | 4: `next@16.3.8`, `react@19.3.0`, `react-dom@19.3.0`, `playwright-core@1.63.0` |
| `npm audit --omit=dev --audit-level=high` | 0 vulnerabilities |
| GitHub Actions | all pinned to 40-character commit SHAs, provenance verified against upstream tags |
| CI permissions | `contents: read`; `persist-credentials: false` |
| Guard | `tests/workflow-pinning.test.ts` (PR #28) fails on an unpinned action or CodeQL version drift |

---

## 10. Known limitations, stated plainly

1. **QO-SEC-03 is unverified.** Every browser test is synthetic — none logs in.
   Real authenticated collection, session expiry, account switching and profile
   ACLs are untested. Procedure: `docs/qo-sec-03-windows-e2e-procedure.md`.
2. **A relay on the active port still reaches the dashboard.** §5.
3. **Same-account compromise is out of scope by decision.** Risk A.
4. **Session-history file permissions are unchanged by consent.** Risk B.
5. **No desktop artifact exists.** No installer, no signing certificate.
6. **Windows ACLs are set but never read back.** `icacls` applies inheritance
   on `~/.quotaops`; nothing verifies the resulting ACEs, and pre-existing
   children keep their original ACLs. Folded into the owner's E2E, not fixed.
7. **`rawHeaders` retains inbound marker copies.** Confirmed unreachable in
   Next 16.3.8, which reads `req.headers`. Latent if that changes.
8. **`script-src 'unsafe-inline'`** is present in the production CSP. No
   injection sink was found, so this is defence-in-depth only.

---

## 11. What is being asked of you

Assess the **implementation**, not the write-up:

- network trust boundaries and the relay residual;
- the capability design — including whether it earns its place;
- collector token and session confidentiality;
- filesystem privileges and the unverified ACL gap;
- browser lifecycle and process cleanup;
- JSONL CPU and memory bounds;
- dependency and supply-chain exposure;
- interactions with PR #19 (Ollama), PR #21 (launcher) and future desktop
  packaging.

Release-blocking findings will be fixed before merge, not documented around.

A finding that the design is wrong — rather than that a detail is wrong — is
more useful here than a clean bill of health.
