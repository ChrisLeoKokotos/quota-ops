# QuotaOps production hardening — 18 Nov 2026

Scope: issue #47 (tray Quit leaves processes), issue #49 (Claude collection
fails behind human verification), issue C (memory/CPU), release readiness.
Branch `fix/windows-quit-lifecycle-smoke` (Draft PR #48), which already
contains Draft PR #46. Windows 11 Home 10.0.26300 (Greek display language),
packaged `win-unpacked` build, isolated temporary home, disposable
never-signed-in profiles only. No real profile, token or `~/.quotaops` file
was read or used.

Status words: **PASS** (ran, met the bar), **FAIL** (ran, did not), **BLOCKED**
(needs the owner or an external input), **NOT RUN**.

---

## A. Root-cause report

### #47 — Quit leaves QuotaOps and port 4317 running

**Reproduction attempts** on build `83979a6`, whose Quit logic is identical
to the distributed Draft PR #39 build:

| Exp. | How Quit was triggered | Collector state | Result |
|---|---|---|---|
| E1 | test timer `app.quit()` | ignores shutdown (stub) | exit 45.1 s (parent kill), 0 left |
| E9 | **real tray menu → Quit** | ignores shutdown (stub) | exit 45.0 s (parent kill), 0 left |
| E12 | real tray → Quit | real collector, browser launch stalled | exit 45.0 s (parent kill); browser alive throughout |
| E12b | real tray → Quit | real collector, collection in flight | exit 5.5 s, graceful |
| E10 | menu held open 46 s across the 30 s menu rebuild | idle | delivered, exit < 1 s |
| E11 | tray menu open, then the shipped minimized/off-screen Chrome starts | — | **menu dismissed** (1 → 0 in 4 s) |
| focus | shipped headed launch | — | **foreground moves from the user's app to Chrome** |

A *delivered* Quit never lived longer than 45 s, so the field report
(≥ 50 s, unchanged PIDs, collector still answering `/health`) was **not
reproduced**. The collector still answering HTTP means it never received
the shutdown message; the most consistent explanation is that the Quit
click was not delivered. A confirmed mechanism matches "while collector
active": every per-account headed launch takes the foreground and dismisses
an open tray menu. **Likely, not proven** for that incident (the user's build
had no lifecycle diagnostics).

**Confirmed defects and corrections**

| # | Defect (evidence) | Correction | Commit |
|---|---|---|---|
| D1 | `waitUntilIdle()` unbounded; invalidation checked only between accounts; no cancellation reached the browser (`MonitoringController` repro: "STILL WAITING after 8 s"; E12 45 s) | `stop()` aborts the in-flight signal; `waitUntilIdle(ms)`; shutdown = cancel → drain ≤ 8 s → close → exit; hard exit 12 s | `534599d` |
| D2 | Launch used Playwright's 180 s default per channel (Chrome, then Edge); `page.evaluate`, OpenAI in-page fetch and `close()` unbounded | 30 s launch, 5 s evaluate, 20 s fetch, 10 s close; abort closes the context and races the unabortable launch | `a3768ce`, `088bc20` |
| D3 | `server.close()` waited for idle keep-alive sockets (5 s) | `closeAllConnections()` | `534599d` |
| D4 | 45 s parent kill the only bound; window stayed, Quit looked ignored | Quit hides window and removes tray icon at once; parent backstop 20 s | `3e84647` |
| D5 | Smoke used `accounts: []` and `app.quit()` from a timer; a static test asserted `waitUntilIdle()` was called, enshrining the bug | Real tray E2E (idle, in flight, after error, verify path); regression tests | `2b1767a`, `a1081ab`, `37bc810` |
| D6 | **Open:** headed collection steals focus — tray menu dismissed, keystrokes typed during a collection go to the hidden provider window | Owner decision (E) | — |

Why tests missed it: unit fakes always settled; the only packaged test had
zero accounts and never touched the tray; no hung-provider case existed.

### #49 — Five Claude accounts `unsupported / claude_page_api_not_observed`

Reproduced without credentials: an automated session on a disposable profile
ends at `claude.ai/api/challenge_redirect`, title **"Περιμένετε..."**, with a
`challenges.cloudflare.com` frame; no usage API request is ever made.

1. Distributed build (#39): **no challenge detection** → `unsupported /
   claude_page_api_not_observed`, the exact report.
2. PR #46's detector also failed here: English-only title/prompt text and a
   light-DOM `iframe[src]` query; the Greek title and the shadow-DOM Turnstile
   frame matched nothing. Still `unsupported`. Fixed with browser-side,
   language-independent signals (`cf-mitigated: challenge` navigation, the
   challenge location, `page.frames()` host) — `9086833`. Same session now:
   `verification_required`, no values.
3. Root cause of the failure itself: provider human verification of automated
   sessions. Selectors or headings cannot fix it; no bypass is attempted.
4. Contributing defects fixed: scheduled cycles re-opened every challenged
   profile every 300 s; the installed app had no in-app way to open a profile;
   `generatedAt` advanced when every account failed ("Local sync just now");
   raw status codes; the tray learned held accounts only every 5 min.
   (`2484b05`, `969f16f`, `faf99fb`)

User path now: tray **Needs your attention → Manual verification required:
<account>…** opens that profile in normal Chrome/Edge (no Playwright, DevTools
or page script). Automation stays off it while open; after the window closes
the account is checked once. Scheduled cycles skip held accounts; Refresh now
tries once.

**Not verified:** whether Claude accepts the automated session after a person
verifies. If it keeps challenging, automated collection for that account is
not possible within the rules; the app reports that honestly. Needs the
owner's real accounts.

---

## B. Performance (issue C)

`scripts/windows-packaged-resource-profile.mjs`; private bytes per role;
CPU % of the whole machine (all cores = 100 %). Before = `83979a6`,
after = this branch.

| Scenario | Build | Total private MB median / max | Main | Renderer | GPU | Collector | Browser max | CPU % mean / max |
|---|---|---|---|---|---|---|---|---|
| Idle 5 min (window hidden at 150 s) | before | 317.9 / 366.5 | 69.6 | 37.9 | 97.7 | 100.8–118.1 | — | 0.0 / 0.1 |
| Idle 5 min (window hidden at 150 s) | after | 314.4 / 361.2 | 69.7 | 34.9 | 97.1 | 101.0–118.1 | — | 0.0 / 0.1 |
| 1 account, 11 refresh cycles (30 s) | before | 348.6 / 1153.0 | 69.6 | 33.9 | 96.6 | 108.2–126.3 | 797.7 (11 procs) | 0.6 / 3.4 |
| 1 account, 11 refresh cycles (30 s) | after | 348.4 / 1127.6 | 70.3 | 35.6 | 96.9 | 102.1–122.8 | 786.9 (11 procs) | 0.6 / 2.5 |
| 5 accounts, one cycle (57 s, sequential) | after | 359.5 / 1235.5 | 69.6 | 34.5 | 126.5 | 116.3–138.5 | 902.3 (11 procs) | 0.7 / 5.4 |
| Idle 2 min, default | after | 318.9 / 358.7 | 73.3 | 34.4 | 98.7 | 96.9–115.1 | — | 0.0 / 0.0 |
| Idle 2 min, `--disable-gpu` | after | **241.6** / 259.0 | 72.9 | 34.9 | **21.3** | 97.5–115.0 | — | 0.0 / 0.1 |

Findings:
- No leak over 11 cycles: between-cycle total 317–355 MB, collector
  102–123 MB, handles back to baseline; every browser process exits each cycle.
- Peaks come from the provider browser (≈ 0.8–0.9 GB, one profile at a time).
- Hiding to tray frees nothing (renderer stays loaded).
- The fix changes lifecycle, not memory: before/after within noise.
- Idle exceeds the 300 MB target (≈ 315 MB private, ≈ 455 MB working set).
  Disabling GPU acceleration measured −77 MB (→ 242 MB); not shipped because
  UI rendering under software compositing was not measured. `playwright-core`
  costs ≈ 63 MB RSS once loaded and stays loaded after the first collection.
- Quit latency (real tray): idle 0.09–0.14 s; during collection 0.26–0.60 s
  (before: 5.5 s); stalled browser launch 0.3 s (before: 45.0 s parent kill);
  collector ignoring shutdown 20.0 s backstop (before: 45.0 s).
- NOT RUN: idle 30 min and 2 h (would hold port 4317 for hours on the
  owner's machine).

---

## C. Test evidence (final build `b413e07` + test-only `37bc810`)

| Gate | Result |
|---|---|
| `npm run typecheck` | PASS |
| `npm test` | PASS — 250 tests, 249 pass, 0 fail, 1 skipped (symlink creation not permitted on this account) |
| Regression tests fail on old code | PASS — bounded drain and abort-signal tests fail against `83979a6` `monitoring.ts`; localized-challenge test documents old detector returning false |
| Hosted CI on `3221764` (App validation, Windows security smoke) | PASS; later commits pending CI after push |
| Packaged startup smoke / `--quit` smoke | PASS / PASS |
| Real tray Quit, idle | PASS 3/3 (+5/5 on previous build) |
| Real tray Quit, collection in flight | PASS 3/3 |
| Real tray Quit, after provider error | PASS 2/2 |
| Verification path (tray item → normal browser → no automation while open → one re-check → Quit) | PASS 1/1 |
| Tray Quit with stalled browser launch | PASS — exit 0.3 s, 0 browsers |
| Tray Quit with collector ignoring shutdown (stub) | PASS — 20.0 s backstop, 0 left |
| Port 4317 released, no QuotaOps/browser processes left | PASS in every run above |
| Window hidden immediately on Quit | PASS (1 → 0 visible). Tray icon removal: code-level only, not observable by UI Automation here |
| `npm audit --omit=dev` (root, desktop runtime) | PASS — 0 vulnerabilities |
| Real Claude accounts | BLOCKED (owner) |

---

## D. Commits (Draft PR #48)

| SHA | Change |
|---|---|
| `a3768ce` | fix(collector): bound and cancel provider browser sessions (#47) |
| `3e84647` | fix(desktop): acknowledge Quit immediately and shorten collector deadline (#47) |
| `534599d` | fix(collector): bounded, cancelling shutdown instead of unbounded drain (#47) |
| `2b1767a` | test(windows): packaged E2E that invokes the real System Tray Quit item (#47) |
| `2484b05` | fix(collector): stop automated retries of challenged profiles; add tray verification path (#49) |
| `969f16f` | fix(dashboard): name collector states plainly instead of raw status codes (#49) |
| `088bc20` | fix(collector): bound profile close so a stuck close cannot stall collection (#47) |
| `a1081ab` | test(windows): tray E2E scenarios for Quit after provider error and verification path |
| `96803eb` | docs(win): describe bounded Quit instead of the 45-second backstop |
| `3221764` | test(windows): reproducible per-role resource profile of the packaged app |
| `faf99fb` | fix(desktop): show held accounts in the tray within 30 s (#49) |
| `9086833` | fix(collector): detect Claude challenges independent of display language (#49) |
| `b413e07` | test(windows): verify-path accepts the challenge or sign-in tray item |
| `37bc810` | test(windows): fresh-menu detection; verify-path process end |

Fixes and tests are separate commits; no refactoring beyond the extracted
`browser-session.ts` and `shutdown.ts` seams the fixes required.

---

## E. Release readiness

| Gate | Status |
|---|---|
| Quit terminates the whole owned tree, port released | PASS |
| No automated retry of challenged profiles; honest states; no fabricated values | PASS (automated); real accounts BLOCKED |
| Unit, typecheck, audit | PASS |
| Hosted CI on the release SHA | PENDING for commits after `3221764` |
| Real-account Claude E2E (5 profiles) | BLOCKED — owner |
| Focus theft by headed collection (D6) | FAIL — owner decision: (a) headless on Windows, removes theft but earlier notes say headless missed the Usage API; (b) keep headed but collect only on request or on a long interval; (c) accept and document |
| Idle memory < 300 MB | FAIL (≈ 315 MB); `--disable-gpu` measured 242 MB — owner approval to ship |
| Long idle 30 min / 2 h | NOT RUN |
| Authenticode signing of installer and EXE | BLOCKED — no certificate (both `NotSigned`) |
| Branded `QuotaOps.exe` icon | BLOCKED — unchanged (`signAndEditExecutable: false`) |
| Clean / constrained Windows 11 machine | BLOCKED — owner |
| Independent human security review | BLOCKED — owner |
| Auto-update | Disabled in unsigned builds, as required |
| PR stack reviewed and merged | BLOCKED — main ← #36 ← #37 ← #38 ← #39 ← #40 ← #46 ← #48, all Draft, unreviewed |

**No release candidate is presented**: signing, real-account E2E and review
gates are not met. Publishing approval is not requested.

---

## F. Distribution plan

Proposed version: **0.2.0** (user-visible behaviour changed: bounded Quit,
verification path). Candidates are tagged `v0.2.0-rc.N`; nothing is
published without the release owner's approval.

| Audience | What they get | Requirements | Update path | Status |
|---|---|---|---|---|
| **git clone** (developers) | Tagged source; `npm ci --ignore-scripts`, `npm run collector:setup`, `npm run collector:start`, `npm run dev` | Node 22.6+ (type stripping), Chrome or Edge | `git fetch --tags`, check out the new tag, `npm ci` | Usable from a tag once the PRs merge |
| **ZIP** | A `git archive` source ZIP attached to the Release, listed in `SHA256SUMS` (not GitHub's auto-archive, whose bytes we do not control) | Same as git clone | Download the next ZIP; `~/.quotaops` is kept | Ready when tagged; no packaged app in a ZIP while unsigned |
| **.exe installer** | NSIS per-user installer (no admin), `SHA256SUMS`, release notes | Windows 10/11 x64, Chrome or Edge | Manual install of each version; testers on unsigned 0.1.0 must install the first signed build by hand; auto-update stays **disabled** until a signed old→new upgrade is tested | **BLOCKED**: no Authenticode certificate; unsigned EXE shows SmartScreen "Windows protected your PC" |

Every Release lists: SHA-256 of each asset, the exact commit, how to verify
(`Get-FileHash`, `Get-AuthenticodeSignature`), known limitations (Claude may
require manual verification and then cannot be read automatically; headed
collection briefly takes focus unless changed), and that uninstall keeps
`%USERPROFILE%\.quotaops` (profiles, token, config) with the manual removal
step.

Release sequence: merge reviewed Draft PRs → protected CI on the release
SHA → signed RC built by a protected job → owner runs real-account and
clean-machine checks → owner approves → Draft GitHub Release → publish.
Never replace a published asset; fix forward with a new version.

Testers who already run the unsigned 0.1.0 (#39) build should be told now:
its Quit can take up to 45 s and is not delivered if the tray menu closes
while a collection starts; a challenged account shows "unsupported".
