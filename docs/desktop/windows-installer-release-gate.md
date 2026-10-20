# QuotaOps Windows installer — pre-release verification

This is an **unsigned x64 test installer**, not an approved public release.
No credentials, provider profiles, personal histories or tokens are packaged.
The installed app reuses the existing per-user `%USERPROFILE%\.quotaops`
configuration. Uninstalling the app does not intentionally erase these user
files, so backups and privacy expectations remain explicit.

## Scope
- Electron 44 IPC shell: static renderer under `app://quotaops`.
- Bundled collector runs in an isolated Electron `utilityProcess` using the
  built-in Node 24 type-stripping capability. An external Node.js installation,
  VS Code and `npm run collector:start` must **not** be needed after install.
- Playwright Core files are bundled but **Chrome or Edge must already be
  installed**; provider login must still be completed normally when required.
- Local snapshot transport remains token-gated on `127.0.0.1:4317`. The
  renderer never sees the token or directly controls Pause/Resume.
- Single Electron instance; when quitting, the collector is asked to drain
  the current isolated browser session before exiting (45-second backstop).
- No auto-updater, telemetry, remote back end or background service installed.

## Build locally on Windows

In VS Code PowerShell, *on this branch*, after preserving any tracked edits:

```powershell
npm run typecheck
npm test
npm run desktop:installer:win
```

The command first builds the static renderer, then downloads an **exact pinned
electron-builder 26.4.0** through npm and packages an NSIS x64 installer.
It never publishes to GitHub. This is a **networked third-party build step**;
use the organization's dependency review process before a release.

Expected location (only after a successful build):
`release/windows/QuotaOps-Setup-0.1.0-x64.exe`

Generate SHA-256 locally and retain it with the test report:

```powershell
Get-FileHash .\release\windows\QuotaOps-Setup-0.1.0-x64.exe -Algorithm SHA256
```

The installer is unsigned and may show Microsoft SmartScreen warnings.
Do not bypass organizational policy or distribute it to clients. For a
public release, acquire an appropriate signing certificate, sign the build
and installer, validate the signature and perform a reproducible-release audit.

### Windows symbolic-link restriction on standard accounts

Electron-builder 26.4.0 may fail when unpacking `winCodeSign-2.6.0.7z`
because the helper archive contains macOS `*.dylib` symbolic links. This
is a Windows privilege issue, not a compilation or tests failure.

`npm run desktop:installer:win` deliberately uses a **separate test-only
configuration** (`desktop/electron-builder.unsigned-test.json`) that extends
`desktop/electron-builder.json` but sets `win.signAndEditExecutable=false`
. This bypasses the Windows executable resource-editing stage for this
unsigned proof-of-concept. The prior attempt also set
`win.signExecutable=false`, but the installed electron-builder 26.4.0
configuration validator explicitly rejected that property, so it has been
removed. The test-only manifest now contains **only**
`win.signAndEditExecutable=false`.

It skips the auxiliary Windows executable
resource-editing/signing stage, so the test `QuotaOps.exe` may retain Electron's
default icon and version metadata. This test workaround must **never**
be inherited by any production installer or signed release.

The normal packaging manifest retains the standard executable resource
editing behavior. To distribute QuotaOps publicly, build with proper signing
and verified icon/metadata in an appropriately provisioned Windows build
environment. Do not elevate the owner's normal VS Code session merely to
work around this helper archive, and do not enable system-wide symlink
privileges without an explicit separate security decision.

### Experimental PE icon stamping (Draft only; opt-in)

The normal unsigned build **still produces the stock Electron executable
icon**, and the usual release manifest remains untouched. This must not be
reported as complete desktop branding.

A research-only Windows probe uses electron-builder v26's supported
`afterExtract` hook to replace the extracted Electron icon **before** the
packager inserts its `ElectronAsar` integrity resource. A read-only
`afterPack` check rejects an output missing the actual approved 256px PNG
frame or the `INTEGRITY/ElectronAsar` resource. This avoids the known
post-integrity `rcedit` ordering problem. It reuses the `resedit` version
already shipped with the pinned electron-builder; it does not download a
second executable or change privilege settings. Both hooks are wired only
in `desktop/electron-builder.unsigned-test.json` and do nothing unless
`QUOTAOPS_BRANDED_PE_PROBE=1`.

**Experimental build only, explicitly in PowerShell:**

```powershell
$env:QUOTAOPS_BRANDED_PE_PROBE = "1"
npm run desktop:installer:win
Remove-Item Env:QUOTAOPS_BRANDED_PE_PROBE
```

Run on a clean working tree after `npm run typecheck` and `npm test`.
If a hook fails (unexpected Electron binary layout, missing builder
`resedit`, modified resource ordering, or failed resource verification),
the build MUST fail rather than producing an installer with a claimed
icon. This is not an approved unsigned release. The earlier unsigned
installer SHA applies only to the original unbranded build.

**Before treating the experiment as successful**, rerun the isolated
packaged Windows startup smoke; confirm the approved icon visually in
Explorer and taskbar; inspect the actual PE and ASAR integrity resource;
repeat the installed Windows E2E; secure independent security approval.
Do not disable the integrity fuse, patch a signed artifact after signing,
bypass Windows privilege controls, or publish the test installer.

### Windows static-export directory locks

The previous `desktop/build-static.mjs` unconditionally removed
`desktop/static-dist` and then renamed `.next-static` into place. On
Windows a live Electron process, Next compiler cache or security scanner may
keep a handle to one of those folders. This produced `EPERM` **after**
Next.js reported successful page compilation, leaving the previously
working `static-dist` deleted.

`desktop/static-publication.mjs` now copies the generated source into a
private sibling staging directory; the CSP manifest is written and validated
there. Only after the staged bundle is complete does it move the old
`static-dist` aside and promote the new one. If either rename fails, the
old bundle is left untouched or restored. If restoring itself fails, the
exception includes the precise backup path for manual recovery; the backup
is deliberately **not** deleted.

The source `.next-static` is left intact rather than renamed out from
under a live Next process. The published directory is never modified in
place. Unit tests simulate both an old-target lock and a promotion failure
with rollback, plus a CSP preparation error.

If a lock is persistent, quit the developer Electron window **from its tray
Quit action**, stop any concurrent Next build, and retry as an ordinary Windows
user. Do not delete `.next-static`, `desktop/static-dist`, `app/api`, or
any browser profile just to get the installer to build. If a backup
`desktop/.quotaops-static-stage-*.previous` is mentioned in an error, preserve
it for inspection.

## Isolated packaged-startup diagnosis (before installation)

`node scripts/windows-packaged-startup-smoke.mjs` runs
`release/windows/win-unpacked/QuotaOps.exe` under a **temporary Windows
USERPROFILE and APPDATA**, with `accounts: []` and token analytics disabled.
It confirms the Node home override before launching Electron and explicitly
sets Electron's `userData` to `Roaming/QuotaOpsSmoke` inside the temporary
sandbox **before** the single-instance lock is requested. Windows Chromium
profile resolution must not be assumed to follow a child `APPDATA` variable
alone. The opt-in override is allowed only for a recognized packaged smoke
sandbox; ordinary application launches use the normal userData path. It checks that
port `127.0.0.1:4317` is free, then probes `GET /health` using a
temporary bearer that is never printed. It verifies the app stays alive
briefly, then kills **only the process tree it spawned** and removes its
temporary test directory once the collector port has closed. If cleanup fails,
the temporary directory remains and the test reports failure.

If `4317` is busy it fails closed: **do not kill an unrelated listener**.
Stop your own dev collector normally first. The test does not access the
five existing provider profiles and does not log private state. Startup
markers emitted by the Electron main and bundled utility process are fixed
classifications enabled **only** with `QUOTAOPS_STARTUP_DIAGNOSTICS=1`.
Raw child stdout/stderr is never printed or uploaded.

This proves only basic packaged boot, sandboxed empty configuration and
authenticated collector availability. It does **not** prove the five real
accounts work, that every UI icon renders, tray Pause/Resume, or successful
installation/uninstallation. Record `PASS`, `FAIL`, or `INCONCLUSIVE`
along with the exact SHA. Even if this passes, a full Windows E2E and
independent security sign-off are still required.

## Critical Windows E2E — clean environment

1. Exit the QuotaOps developer Electron and *stop* any manually started
   `npm run collector:start` processes. Verify no QuotaOps-owned Chrome/Edge
   windows are still running.
2. Install the test installer and launch QuotaOps via Start Menu, **without**
   VS Code or Node.js. Verify `Collector connected` and expected account
   values after the first provider pass (can take some time).
3. Double-click the app shortcut again. Verify only one QuotaOps window and
   one collector listener exist.
4. Close the window with X; it should hide to tray. Open from tray, then
   select Pause monitoring. Verify real provider collection stops starting
   new browser sessions. If a current collection was already running, it may
   finish and close before pause is fully effective. Check that the app does
   not claim fresh provider data simply because a snapshot was requested.
5. Resume monitoring; verify accounts update. Explicit Refresh now must
   queue a provider update rather than only reading cached data.
6. Quit from tray; allow up to 45 seconds for active browser cleanup. Verify
   the collector listener is closed and no QuotaOps-owned browser processes
   remain. Repeat across install/quit cycles.
7. Repeat after logout/login, reboot, uninstall/reinstall and with Claude
   signed out (must report `login_required`, not 0%).
8. Run `scripts/windows-browser-processes.ps1`, `scripts/desktop-shell-smoke.ts`
   where applicable and the guided local security E2E procedure. The tests
   must record **PASS/FAIL/INCONCLUSIVE**, not declare a skipped procedure PASS.
9. Measure cold start, idle RAM of the complete process tree, tray memory,
   real provider refresh CPU/RAM and profile cleanup on a constrained Windows
   machine (ideally 8 GB RAM, 4 cores).

## Evidence and release gate

The user previously confirmed five real Claude Team profiles can be collected
and shown in the development dashboard and the Electron IPC development shell;
`npm run typecheck`, 173 unit tests with one symlink skip, and the static build
were successful **before these packaging/lifecycle changes**.

Those results do not establish the packaged installer works. **No packaged
Windows run, unsigned installer hash, independent human security sign-off,
code signing or CI check is recorded yet for this branch.**

The previous review package at
`docs/desktop/ipc-security-review-package.md` predates the utilityProcess
launch and authenticated monitoring-control endpoints. Send those changes,
new local test logs and the exact SHAs to an independent authorized reviewer.
The author/AI review is not an independent human approval.

Do not merge, tag or release until these gates are completed.
