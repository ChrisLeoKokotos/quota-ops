# QuotaOps Windows automatic updates — Draft release gate

**Status: code wired, OFF in all existing unsigned installers. No update server
or signed QuotaOps release has been activated; no user update has been attempted.**

## User experience

- In a **signed, explicitly enabled** Windows NSIS build, the Electron
  **main process** checks for an update when the app starts and every 12 hours
  thereafter, including while minimized to the System Tray.
- A new version shows in the tray menu. The owner selects **Download update**.
  Download progress and errors remain in the main process; the renderer and
  collector do not receive release URLs, update metadata, tokens or download
  permissions.
- Once downloaded, **Install update and restart...** opens a confirmation
  dialog. Rejecting it installs nothing. Accepting it cancels monitoring,
  requests a graceful shutdown of the bundled collector, waits up to 45 seconds
  (existing Quit backstop), then invokes the NSIS updater.
- Closing the window, choosing Quit or rebooting does **not** silently install.
  Updates must be explicitly confirmed. The per-user
  `%USERPROFILE%\.quotaops` directory is separate from the installed
  `AppData\Local\Programs\QuotaOps` binary; no updater operation deliberately
  deletes, recreates, migrates or rotates its accounts, tokens or browser profiles.
  Always back up that directory before early real-world upgrade E2E.

## Implementation and trust model

- `electron-updater` is pinned to **6.8.9** as a packaged *runtime*
  dependency. Its transitive dependency lockfile must be generated with npm
  and reviewed before a build is allowed. No updater code runs in the Next
  renderer. Use `createUpdateManager` with main-process-only tray controls.
- The default `desktop/electron-ipc/update-policy.json` is `enabled:false`
  with **no publisher**, permanently refusing updates in the existing
  unsigned test build. The policy is shipped inside app.asar; it is not read
  from users' preferences, command-line arguments or environment variables.
- The signed release must embed its **exact** trusted Windows Authenticode
  publisher name into `update-policy.json`, set `enabled:true`, and be built
  using a valid signing certificate. The runtime independently requires the
  matching publisher in `resources/app-update.yml` alongside a fixed GitHub
  feed `ChrisLeoKokotos/quota-ops`. A mismatch disables all checks/downloads.
  The upstream updater's Windows signature verifier must remain enabled.
- Update source is explicit and constant, using **public HTTPS GitHub Releases**.
  Do not embed GitHub PATs, provider cookies, or secrets. Do not use the
  private-GitHub updater mode, HTTP, arbitrary feed URLs or renderer IPC.
- `autoDownload=false`, `autoInstallOnAppQuit=false`,
  `allowPrerelease=false`, `allowDowngrade=false`. Set
  `disableWebInstaller=true` for defense in depth. Never downgrade into a
  manifest with weakened code-signing requirements.
- electron-builder **v26** uses manifest SHA-512 and Windows Authenticode
  checks, but not the stronger Ed25519 signed-manifest default documented
  for **v27**. Do not describe SHA-512 as authenticating an attacker-controlled
  release manifest. Migration to v27 + an embedded manifest public-key trust
  list is recommended before distributing this as a security-sensitive
  unattended update feature.
- `desktop/electron-builder.release.json` points at the intended GitHub feed
  and keeps Windows update code-signature verification on. It does not sign,
  publish or upload anything by itself. Production signing configuration and
  protected CI secrets are **not yet supplied**.

## Dependency bootstrap (owner Windows dev machine)

The proposed PR is stacked on PR #39, not on `main`. After checking out the
feature branch, generate the **lockfile** from the declared pinned dependency
(using normal non-elevated PowerShell and reviewing the npm package provenance):

```powershell
npm install --prefix desktop/electron-ipc --package-lock-only --ignore-scripts --no-audit --no-fund
npm ci --prefix desktop/electron-ipc --ignore-scripts --no-audit --no-fund
```

The lockfile must be committed; the builder refuses to package without it
and without the exact installed `electron-updater@6.8.9`. No developer or
release should improvise a `--force`, symlink elevation, or disable the ASAR
integrity checks. Run:

```powershell
npm run typecheck
npm test
npm run desktop:installer:win
node scripts/windows-packaged-startup-smoke.mjs
```

The last two commands continue to produce **unsigned, updater-disabled**
test installers and are not a substitute for a signed update E2E.

## Release activation prerequisites (BLOCKED until completed)

1. Decide the legal/publisher identity (exact certificate subject). Procure
   code signing from a trusted provider and secure access; do not put keys or
   certificate passwords in GitHub files or chat. Verify the signed installer
   with the OS before testing auto-update.
2. Build the first signed `0.2.0` or other strictly newer version using the
   reviewed standard build manifest **without**
   `win.signAndEditExecutable=false`. Solve the builder's Windows symlink
   extraction issue in an appropriately provisioned CI worker; do **not**
   bypass OS policies on the owner's laptop.
3. Explicitly turn on the packaged update policy with the **real** trusted
   publisher (not a guessed string), configure GitHub publication only within
   protected CI with a reviewed release workflow and approval requirements,
   and generate signed release metadata (`latest.yml`) that matches the
   NSIS SHA-512. Verify what ends up in the packaged
   `resources/app-update.yml`. A manual unsigned zip/file attachment does not
   create an updater-ready release.
4. Independently review the updater, publish process, code-signing permissions,
   branch protection, trust-model limitations on v26, package-lock and
   software supply chain.
5. Test signed old-to-new upgrades on a **disposable Windows user profile**
   with test accounts before asking the owner to risk the five real profiles:
   available -> approved download -> cancel -> approved install -> collector
   drains -> new signed version, then repeat tray, shortcuts, shutdown,
   rollback/failure/retry, offline mode, malformed manifest, malicious
   publisher and cross-version sign-in behavior.
6. Record cold/idle resource use and ensure polling does not keep Electron
   active after Quit. Publish a signed release only after explicit owner
   approval. Keep PR Draft and do not auto-merge.

## Test scope already available in the PR

`tests/desktop-auto-update.test.ts` exercises gate denial, publisher mismatch,
auto-download disabled, download/install consent, collector-drain sequencing,
no update IPC, and no implicit install. Passing unit tests do **not** prove
that electron-updater was packaged, the release metadata was signed, that
the Windows signature was actually validated, or that an installed NSIS
upgrade works.
