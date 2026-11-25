# Responsive UI hardening

Scope: preserve QuotaOps design and quota/collector behavior. Baseline: PR #54, 6fbe258 (all three checks green).

- Rail width varies continuously from 76px at 1120 CSS px to 244px at 1280px, with icon-only navigation through 1200px; at 760px the sidebar becomes a two-row header with independent navigation and action grids. Controls have names and titles when text is visually hidden. At short mobile heights navigation is not sticky.
- Workspace expands to 1720px (including padding) and uses fluid spacing. No document-level overflow hiding. Shell uses viewport breakpoints; token, account, advisor and workspace descendants use container queries. The compact rail retains a working close toggle.
- Token numbers and account labels wrap rather than silently truncate. Session counts remain visible on narrow screens. Forms, long email strings, quota labels, modals and editor controls can shrink and reflow.
- Smart Advisor controls, status and ranked rows have a dedicated layout. Existing accessible status label remains unchanged.
- Electron starts within primary display work area in DIP with minimum outer window size 480x360, reduced only if work area is smaller. Browser layout is tested down to 320 CSS px. No IPC, security, collector or recommendation changes.

## Acceptance

Run `npm run build` then `node scripts/responsive-dashboard-e2e.mjs` on a clean test environment (port 4317 free). CI uses a disposable local collector with synthetic quota and ~9T token totals, no credentials or actual account history. Nineteen viewports (320–2560), both themes and both sidebar states: 76 combinations plus 19 modal checks. Additional adjacent-pixel measurements assert the workspace width is continuous through rail breakpoints. Checks document and component horizontal bounds, local overflow, truncation, accessible navigation, advisor controls and open manual editors. Existing collector-to-dashboard, manual-provider, Windows security and packaged install workflows remain in place. No claim of visual/physical DPI coverage solely from browser viewport emulation; installed runtime and actual Windows scaling remain separate checks.

The packaged Advisor UIA probe additionally attempts native resizes to 640×480 and 480×360 DIP on its isolated Windows test window, verifies the actual bounds and continued recommendation, and restores the original size. This is not a test at every real monitor DPI.
