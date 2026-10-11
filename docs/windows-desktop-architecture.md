# Windows desktop EXE — architecture decision and release plan

**Status:** Proposed; implementation and distribution blocked by PR #20 security-release gates. No installer or executable is claimed to exist yet.

## Product goal

Deliver QuotaOps as a real Windows desktop application (Start Menu entry, window, taskbar icon, installation/uninstallation, updates only with explicit user control). Users should not have to manually install Node.js, run npm, launch terminals or manage localhost URLs.

## Technology decision: Electron + bundled local Next.js runtime

Current QuotaOps uses Next.js App Router API routes and a separate Node collector. Tauri's static WebView-only packaging would require reimplementing the privileged local API and collector bridge; Electron can host the existing Node stack with less behavioral churn, at a larger signed binary size.

Proposed components:

1. A minimal, sandboxed Electron main process managing a single app window.
2. A pinned, bundled Next.js standalone production server, bound to loopback (not a public interface). No development server in desktop releases.
3. An optional Node collector running locally, with a narrow authenticated snapshot boundary and clean lifecycle management.
4. A bundled Electron runtime and application assets, with platform packages built only in CI from a locked dependency tree.

Electron must launch the embedded Next.js server without exposing API keys, session cookies or tokens to the renderer. The authenticated provider profiles remain in the existing per-user directory, not the installer directory or `asar`.

## Non-negotiable security gates

- Desktop renderer: `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`, no remote content, no unrestricted preload IPC.
- The renderer must not access filesystem, spawn processes, or read collector secrets.
- Deny unexpected navigations, external window creation, downloads, permissions and arbitrary protocol handlers by default; approve explicit exceptions through review.
- **Before shipping**, replace the forgeable-header protection of `/api/collector/snapshot` with a correctly authenticated desktop-only path or an equivalent OS-bound capability; binding to loopback alone does not authenticate a caller. Avoid relying on `Origin`, `Host` or a static client marker.
- Electron process, bundled Next server and collector must terminate cleanly on app exit; avoid detached lingering subprocesses, orphan listeners and privileged browser sessions.
- No new telemetry, content logging, remote AI endpoints or automatic credentials export.
- Signed installer and executable (when a signing certificate is available), SHA-256 checksums, build provenance/SBOM, pinned packaging dependencies and artifact retention policy.
- Explicit signed-update strategy. Do not enable silent unsigned auto-update.
- Windows Defender/SmartScreen compatibility must be tested rather than bypassed.

## Delivery phases

1. **Security prerequisites:** finish QO-SEC-01…06 in PR #20, including Windows collector and proxy verification.
2. **Desktop skeleton:** separate PR adding Electron main process, hardened BrowserWindow and local production server supervision. Add mocked startup/shutdown tests; keep existing web dev workflow.
3. **Deterministic packaging:** pinned Electron/electron-builder dependencies in npm lockfile; Windows CI builds an unsigned test artifact for internal QA. No `npm install --no-save` or unverified scripts.
4. **Windows E2E:** installation on clean Windows 11, app launch, collector enable/disable, login/logout, browser crash, shutdown, occupied ports, file ACLs, offline launch, upgrade/uninstall, resource usage and intentional network exposure checks. Use dedicated test accounts, never upload auth profiles as CI artifacts.
5. **Release:** sign installer when feasible; publish versioned release with integrity checks and transparent known limitations.

## Questions to verify at implementation time

- Whether Electron's runtime layout can ship the pinned Node/Next standalone output without code changes to the collector.
- Whether the collector should be started on demand instead of always-on, particularly for sensitive session access.
- Whether user preference is installer (`.exe` setup), portable `.exe`, or both. Default recommendation: signed installer first, portable only after testing persistence/update behavior.

**Decision:** do not merge desktop packaging code into main until PR #20's security gates and the specific desktop threat model pass. The existing `.bat` launcher remains a developer convenience, not the distributed desktop product.
