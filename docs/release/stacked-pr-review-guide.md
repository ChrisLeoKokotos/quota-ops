# Review guide: the v0.2.0 Draft PR stack

Nothing in this stack is merged. Each PR is based on the previous one:

`main ← #36 ← #37 ← #38 ← #39 ← #40 ← #46 ← #48`

Whole stack against `main`: 226 commits, 162 files, +27,480 / −473 lines
(most of #36 is the desktop shell, static dashboard and tests).

| PR | Scope | Size vs its base | Hosted CI on its own head |
|---|---|---|---|
| #36 | Desktop shell: Electron + static dashboard over IPC, scheduler, tray, pause/resume | 70 commits, 94 files, +19,366 | pass |
| #37 | Claude visible-usage fallback | 19 commits, 11 files, +507 | none |
| #38 | Tray pause controls the real collector | 7 commits, 6 files, +333 | none |
| #39 | Unsigned NSIS installer, bundled collector utility process (the build given to 0.1.0 testers) | 70 commits, 33 files, +2,651 | none |
| #40 | Auto-update framework, disabled by policy | 14 commits, 11 files, +818 | none |
| #46 | Claude verification detection, Usage heading fallback | 15 commits, 7 files, +226 | none |
| #48 | Bounded Quit, real-tray E2E, holds and verification path, locale-independent challenge detection, headless-only background, consented visible refresh, software rendering, signing dry run, 0.2.0 | 31+ commits, 46+ files | pass (App validation, Windows smoke; signing dry run new) |

Because #37–#46 never ran hosted CI on their own, review and test the stack
as a whole at #48's head, not PR by PR.

## Recommended order (by risk, not by PR)

1. **Trust boundaries**
   - `desktop/electron-ipc/main.js`: IPC handler, `app://` protocol, CSP, utility process, tray actions, collector POST calls, consent dialog.
   - `desktop/electron-ipc/security.js`: snapshot projection, sender check.
   - `desktop/electron-ipc/preload.js`: renderer surface; must stay snapshot-only.
2. **Collector HTTP API** (`collector/service.ts`, `collector/security.ts`)
   - Loopback only; bearer token on every route.
   - New since the last review package: `POST /accounts/verify?id=`, `POST /monitoring/refresh-visible`, and the `collector-state.json` holds file.
3. **Browser automation** (`collector/browser.ts`, `openai.ts`, `browser-session.ts`, `claude-launch-mode.ts`, `verification-state.ts`, `manual-verification.ts`)
   - No user-agent or fingerprint change, no DevTools TCP port, no challenge interaction.
   - The verification window is launched without automation.
4. **Lifecycle** (`collector/shutdown.ts`, `monitoring.ts`; before-quit in `main.js`): bounded shutdown, no orphans.
5. **Packaging and release**
   - `desktop/electron-builder*.json`, `build-installer.mjs`, `build-signed-candidate.mjs`, branding hooks.
   - Updater: `update-manager.js` and `update-policy.json`, which must stay `enabled:false`.
   - `.github/workflows/*`: pinned actions, read-only permissions, nothing published.
6. **Dashboard** (`components/quota-dashboard.tsx`, `lib/collector-client.ts`): stale values are never shown as 0 %.

## Security review delta for the independent reviewer

Previous package: `docs/desktop/ipc-security-review-package.md`. New since then:

- **`/accounts/verify`**
  - Input is a single `id`, validated against the regex and the local config.
  - Spawns installed Chrome or Edge with fixed arguments: profile directory under the protected root, fixed provider URL, no automation.
  - Refused while a collection runs.
  - Windows are closed on Quit.
- **`/monitoring/refresh-visible`**
  - Only main calls it, and only after a consent dialog.
  - Headed windows can take focus.
- **`collector-state.json`**
  - Contains ids, statuses and timestamps only.
  - Restored entries are validated against the config, and timestamps in the future are rejected.
- **Headless background collection**
  - Uses the provider's normal headless user agent, unchanged.
- **Software rendering by default** on Windows (`app.disableHardwareAcceleration()`).
- **Signing dry-run workflow**
  - Self-signed certificate lives only inside the job.
  - No secrets, artifacts or publishing.
- **Collector shutdown**
  - Hard exit after 12 s.
  - Parent kill after 20 s.

An AI-assisted review is not a substitute for the independent human
security review required by the release gate.

## Merge recommendation (owner decides)

After review and all release gates pass, merge the stack top-down into
`main` as one reviewed unit (merge commit, history kept): retarget #48 to
`main` and close #36–#46 as included, or merge them in order. Squashing 226
commits would lose the evidence trail referenced from issues #47 and #49.
