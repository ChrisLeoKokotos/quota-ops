# QuotaOps Windows public-download release gate

**Status: BLOCKED.** Do not publish the existing 0.1.0 unsigned test installer
as a stable download. A successful unit suite is not equivalent to an
operational collector or a trustworthy Windows installer.

## Known blockers

1. **Claude collector:** Five enabled Claude profiles returned
   `unsupported / claude_page_api_not_observed` in the installed build.
   A real visible single-profile test still returned `unsupported` after the
   updated Usage headings were implemented (14 Nov 2026). The user observed a
   provider-owned "Verify you are human" challenge in automated browser use.
   Do not automate, circumvent, or disable human verification. The candidate
   `verification_required` result makes the obstacle explicit and keeps
   account data unknown, not zero. It does not guarantee scraping will work.
2. **Quit/utility lifecycle:** Windows tray Quit reportedly left Electron
   and collector processes running past the 45-second shutdown deadline;
   see GitHub issue #47 and the dedicated isolated `--quit` smoke draft.
   Determine whether the tray action fires and whether the utility drains
   before release. Never force-kill unrelated user processes.
3. **Code signing and distribution:** A verified Windows Authenticode
   certificate/publisher identity, a protected build/release workflow and
   isolated signed old-to-new upgrade testing are not yet supplied. The
   updater is disabled in unsigned builds, by design.
4. **Dependency audit:** Hosted CI identified **critical** advisories for
   Next.js `16.3.8` (GHSA-2464-fhr4-w9xw, GHSA-673q-mjm6-r5xr,
   GHSA-p3m5-59mp-jv5r). The code branch pins `16.4.6`, but the root
   `package-lock.json` has NOT YET been regenerated and tested. Until the
   lockfile is reviewed, committed and CI audit passes, the release is blocked.
5. **Review:** Security and QA approval, provenance of npm dependency lock,
   CI checks on the actual proposed release SHA, and a release owner
   decision are outstanding.

## Acceptance tests (all required)

- On Windows 11 run `npm ci --ignore-scripts --no-audit --no-fund`,
  `npm run typecheck`, `npm test`, production static build, and
  `npm audit --audit-level=high --omit=dev` plus the desktop runtime
  dependency audit. A Windows symlink test skipped for policy reasons
  must be covered by an equivalent authorized CI run.
- Confirm that real-session collection is `ok` across representative
  Claude profiles **or** explicitly expose provider verification/unsupported
  states, disable any misleading automatic usage claims, and retain a
  usable user-entered quota path. Never show fabricated percentages.
  Test login-required, expired session, offline provider, changing Usage
  layout, verification challenge and empty data.
- Build installer; inspect embedded icon, ASAR integrity and exact resources.
  Run `node scripts/windows-packaged-startup-smoke.mjs` and
  `node scripts/windows-packaged-startup-smoke.mjs --quit`, with QuotaOps
  installed app closed, in a disposable Windows home with zero provider
  accounts. Both tests must pass. Then manually click Tray → Quit in an
  isolated installed build and verify process tree and port 4317 disappear.
- Verify user-data preservation with disposable test profiles through
  install, restart, repair, uninstall and upgrade. The real five browser
  profiles and `collector.token` must never be copied into a release.
- Sign NSIS installer and executable with the authorized publisher; verify
  Authenticode via Windows; independently review the exact builder config.
  Publish `latest.yml` and its matching checksums only from a protected
  release job. Never embed GitHub PAT, signing passwords or keys in source.
  For stronger manifest authentication evaluate v27 signed manifests before
  auto-update activation. v26 SHA-512 on its own is not feed authentication.
- Perform one explicit older-signed-build → newer-signed-build test,
  including consent, cancellation, offline, corrupt metadata, signature
  mismatch and collector shutdown. Existing unsigned 0.1.0 builds require
  manual installation of the initial signed version.

## Release sequence

1. Resolve known blockers and security review in Draft PRs; do not merge
   solely because local unit tests pass.
2. Get release approval and the correct certificate identity. Build candidate
   with a fresh version and protected Windows signing credentials; do not
   circulate the unsigned diagnostics build.
3. Internally test a signed release candidate with clean, disposable profiles
   and a clear unsupported-provider/manual workflow.
4. Publish a signed public GitHub Release with setup EXE, SHA-256 and
   provenance only after sign-off. Keep auto-update opt-in and verified.
5. Monitor regression reports and use a newer version to recover a broken
   release. Never silently mutate an already published installer.

## Candidate changes currently under validation

- Draft PR #46: Claude Usage layout compatibility and explicit provider
  manual verification status (candidate, **not** real-session proven).
- Draft PR #48: isolated packaged Quit lifecycle test (candidate, **not**
  owner-executed).
- Draft PR #40: disabled-by-default code-gated Windows auto-update.
- Draft PR #39: Windows installer shell.

No draft PR or this document is itself a public release.
