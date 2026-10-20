# QuotaOps desktop release — preliminary code/security review (AI-assisted)

**Scope:** PR #35 + #36 + #37 + #38 + #39, Electron 44 IPC desktop,
collector bearer loopback HTTP, Playwright persistent profiles, packaged
Electron utility process, NSIS installer. 20 Oct 2026.

**Approval:** **NOT APPROVED FOR RELEASE.** This is an implementer-side,
AI-assisted review, **not** the required independent human security review.
The detailed existing IPC threat model is at
`docs/desktop/ipc-security-review-package.md`.

## Assets and trust boundaries

1. Provider cookies/sessions stay only in per-account browser profiles under
   the existing per-user QuotaOps home. The installer must never copy these.
2. Renderer: `app://quotaops`, sandboxed and isolated, with one read-only
   `quotaops:snapshot` IPC channel. Collector token stays in main process.
3. Main → collector: fixed authenticated loopback URLs only, bounded snapshot
   projection, a 43-character local token, Host/Origin checks. The three new
   control POSTs have no renderer IPC route.
4. Packaged collector: Electron utility process runs Node 24's TypeScript
   stripping from resources outside ASAR. It has privileged filesystem/network
   access; treat its source and packaged dependencies as privileged code.
5. Build/update: unsigned NSIS from pinned third-party electron-builder,
   no auto-updater or automatic publication. All artifacts must be reviewed,
   hashed and ultimately code-signed before distribution.

## Findings and dispositions

| ID | Severity | Observation | Disposition |
| --- | --- | --- | --- |
| QO-DESK-01 | HIGH | Tray Pause previously stopped only GET /snapshot; independent backend continued provider browsing. | Implemented cross-process authenticated control and batch invalidation in #38; real Windows E2E **pending** |
| QO-DESK-02 | HIGH | The alleged standalone desktop formerly needed a manually started collector, so the installable EXE would not run independently. | Bundled supervised utility process in #39; packaged E2E **pending** |
| QO-DESK-03 | MEDIUM | Scheduler could publish results of a refresh started before Pause. | Generation invalidation + regression in #38; local CI **pending** |
| QO-DESK-04 | MEDIUM | Collector snapshot previously updated `generatedAt` on every read, making cached data appear newly collected. | Timestamp advances on completed provider batches only in #38; UI stale-state integration **pending** |
| QO-DESK-05 | HIGH release-blocking | NSIS installer unsigned; publisher identity is not established, and SmartScreen may warn. | **OPEN**. Only private test installer allowed. Decide certificate/signing and verify Authenticode before public distribution |
| QO-DESK-06 | MEDIUM | Windows symlink containment test skipped under non-Developer Mode environment. | **OPEN**. Run on capable Windows setup or add junction-based equivalent and record outcome |
| QO-DESK-07 | MEDIUM | Packaged utility process loads TS and `playwright-core` from extraResources, expanding the privileged packaged file set. | Narrowed to collector/lib TypeScript + Playwright dependency. Inspect actual installed files, signatures/hashes and ASAR resources; independent review **OPEN** |
| QO-DESK-08 | MEDIUM | Stop during an active Playwright session could orphan browsers if the child is killed abruptly. | Added utility-parent drain and 45s backstop in #39. Browser cleanup after quit **OPEN** pending Windows tests |
| QO-DESK-09 | LOW/operational | Chrome or Edge not installed, expired provider sessions, no visible dashboard freshness during first collection. | Documented; check `login_required`, `unsupported` and `unavailable` paths on installed build |
| QO-DESK-10 | MEDIUM supply chain | Test installer builder is pinned via npm exec but not installed from a checked-in lock. | **OPEN** for release: commit lockfile/CI build attestation and verify transitive dependencies; do not ship this proof as trusted production binary |
| QO-DESK-11 | MEDIUM | Token analytics were previously passed from a loopback peer to the renderer as an unprojected object, contrary to the field-by-field boundary claim. | Added explicit numeric-only field projection, array caps and malicious-payload tests in #39; packaged E2E **pending** |

## Threat review checklist

- No new renderer IPC command handler should exist for pause, browser launch,
  file access, shell commands or token reads.
- Check `shell.openExternal` stays empty-allowlist; verify top-level and
  subframe navigation, remote fetching and inline script execution are blocked.
- Verify the actual packaged renderer CSP using runtime probes, not just config.
- Check collector HTTP POST controls cannot be reached without exact bearer,
  loopback Host, and absent Origin; no CORS opt-in.
- Check a third-party local listener on 4317 does not allow untrusted data or
  commands to cross the IPC boundary. Same-user malicious processes remain
  an owner-accepted residual risk, not a remotely resolved vulnerability.
- Verify single-instance semantics and that installed main process launches
  **only** a fixed bundled service path, never caller-supplied executables.
- Confirm real account cookies, profile directories, secrets, local prompts,
  login storage and debug traces are absent from the installer.
- Check one active profile is not opened concurrently by background collection
  and a manual login command.
- Confirm Pause blocks subsequent browser launches, drops late results,
  and reports an acknowledged state. Already active sessions drain; document it.
- Verify quitting removes listener and QuotaOps-owned child browser processes,
  even on timeout and after repeated restarts.
- Run CodeQL/dependency/secret scans and the complete repo smoke tests on the
  reviewed SHA. Green local unit tests are not equivalent to a secure installer.

## Existing evidence (earlier heads, not proof of this release)

- Five real Claude Team accounts collected and displayed in the live
  dashboard, default collector, and Electron development app.
- Local `npm run typecheck`: PASS.
- Local `npm test`: 173 pass, 0 fail, 1 Windows symlink skip.
- `node desktop/build-static.mjs`: PASS, 3 CSP hashes exported.
- No real Windows packaged NSIS E2E, independent review, signed EXE, small-RAM
  hardware gate, or hosted CI results yet for #38/#39.

## Required approvals before non-test distribution

1. Reproducible Windows install/upgrade/uninstall tests, self-contained
   collection, pause/resume/quit and privacy negative cases.
2. Full local tests, actual packaged security smoke and process measurements.
3. Review of this exact commit by an independent authorized human who signs
   off the changed collector-control and utility-process boundaries.
4. Successful hosted CodeQL/checks at the exact reviewed SHA and branch
   protection/authorized reviewer enforcement.
5. Installer signing, integrity hash, SBOM/dependency and supply-chain audit.

No merge, public release, user-data migration or update should occur until
the owner has recorded the evidence for every gate.
