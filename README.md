# QuotaOps

Open-source quota, capacity, and local token-usage visibility for AI workflows.

**QuotaOps is a product created by SO HOMELY.**

QuotaOps gives people and teams one local workspace for AI-account capacity, reset windows, and locally observed token activity instead of checking providers and local tooling separately.

## Current product state

QuotaOps is currently a local-first MVP with automatic-collector integrations for **Claude / Anthropic** and **OpenAI / ChatGPT Codex**, plus **manual and event-driven Google / Antigravity quota tracking**.

Today it supports:

- manual and collector-synced AI account entries;
- provider-neutral quota windows with usage percentages and exact reset timestamps;
- live reset countdowns;
- account states such as Available, Low capacity, At limit, Max usage, Needs setup, and Refresh required;
- task-aware Smart Account Advisor with provider selection, freshness checks, bottleneck reserves, trend estimates and explainable recommendations ([design and evaluation](docs/smart-account-advisor.md));
- experimental same-PC automatic collection for Claude and OpenAI accounts through isolated local browser profiles;
- local Token Analytics from Claude Code and Codex session logs, plus opted-in Antigravity CLI statusLine counters;
- total token activity with Input, Output, Cache read, and Cache write breakdowns;
- Today, 7 days, 30 days, and All time token views;
- per-provider token totals for Claude, OpenAI, and opted-in Google CLI observations;
- browser / OS reset notifications while QuotaOps is running and permission is granted;
- optional browser voice input for quick manual usage updates;
- keyboard shortcuts;
- light and dark themes;
- browser-local persistence for non-secret dashboard metadata.

There is **no hosted QuotaOps backend, hosted database, QuotaOps account system, or cloud sync** in the current MVP. The optional collector runs on the same PC and binds only to `127.0.0.1`.

## Windows desktop app (unsigned test build)

QuotaOps runs as a native Windows app: `QuotaOps.exe` with the collector
bundled inside. It does not need VS Code, a terminal or `npm` to run.
**The installer is an unsigned local test build**, not a published release.

### Build and install

```powershell
npm ci --ignore-scripts --no-audit --no-fund
npm run build
npm run desktop:installer:win
```

The installer is written to `release\windows\QuotaOps-Setup-<version>-x64.exe`,
and its SHA-256 is printed at the end of the build. Run it. Windows SmartScreen
warns about an unknown publisher because the file is not code-signed. Choose
**More info → Run anyway** only for a build you made yourself or got from someone
you trust.

The installer works per user and does not need administrator rights. By default it
installs to `%LOCALAPPDATA%\Programs\QuotaOps` and creates desktop and Start Menu
shortcuts. Installing over an older build keeps your accounts, browser profiles and
settings, because they live in `%USERPROFILE%\.quotaops`, outside the install folder.

### First run

- Open **QuotaOps** from the Start Menu or the desktop shortcut. The window opens
  and the QuotaOps icon appears in the notification area (tray).
- Closing the window hides QuotaOps to the tray. Use the tray icon's
  **Open QuotaOps** to show it again. **Quit** in the tray menu stops the app, the
  collector and any browser it started.
- The tray menu also has **Pause monitoring / Resume monitoring**,
  **Refresh with visible browser...**, a token analytics switch and, when an
  account needs you, one **Sign in** or **Manual verification required** entry for each
  such account.
- If another program already uses port `4317`, the tray explains it and QuotaOps
  stays open without collecting. If the collector process stops unexpectedly,
  QuotaOps restarts it, up to 3 times in 10 minutes.

### Accounts

The desktop app has **no account setup screen yet**. You add Claude and OpenAI
accounts with the collector command line, which shares the same
`%USERPROFILE%\.quotaops` folder as the app. From a repository checkout:

```powershell
npm run collector:setup -- add claude dev-1 "Dev 1"
npm run collector:setup -- login dev-1
```

See [docs/local-collector.md](docs/local-collector.md) for all commands, and
[docs/google-antigravity.md](docs/google-antigravity.md) for Google. Every configured
account is shown on the dashboard, even before its first successful check. The
dashboard shows its real state: not checked yet, sign-in needed, verification
needed, unavailable, unsupported or OK. If a check fails, the last known values stay
visible with the time they were collected. An account that has never been collected
says **Never successfully synced**.

### Claude checks and their limits

- Background checks run on Windows in a **separate hidden Windows desktop** that
  is never shown and never takes focus. QuotaOps does not use offscreen or
  minimized windows for this.
- Claude's Cloudflare protection challenges every headless browser, so headless
  collection is not used by default on Windows. This is a provider limitation, and
  QuotaOps does not try to get around it.
- Each Claude browser profile has to pass Claude's human check once in a visible
  browser. Use the tray entry **Manual verification required: <account>**, finish the
  check yourself, and close that window. After that, background checks normally work
  without showing anything.
- QuotaOps never solves or clicks challenges for you. It never shows 0% when the real
  value is unknown, and a reset time it does not know stays unknown. If an account
  keeps being challenged, QuotaOps stops retrying it in the background for 24 hours
  and shows that it needs attention. **Refresh with visible browser...** asks you
  before it opens anything.

### Token analytics in the app

Token analytics is **off** until you turn it on. Use the **Turn on token analytics**
button in the dashboard's Token analytics panel, or **Turn on token analytics...** in
the tray menu. A dialog explains what QuotaOps reads before anything is read.

When it is on, QuotaOps reads these from the session logs on this PC:

- the numeric token counts (input, output, cache read, cache write) and their dates,
  from Claude Code (`%USERPROFILE%\.claude`) and Codex (`%USERPROFILE%\.codex`);
- for Claude Code, the Claude account each session ran under, kept only as a one-way
  hash.

The panel shows:

- **Total tokens processed · All time**, with the input, output, cache read and
  cache write breakdown;
- one total each for Claude Code, Codex and Antigravity. A source that is off, or
  that has no history on this PC, shows "—" rather than 0;
- **Claude Code by Claude account**. A session counts for an account only when
  Claude Code recorded exactly one account id in it. Older sessions without that
  record are listed as **Not attributed**. Usage is never guessed or split between
  accounts, and these accounts are not yet linked to your QuotaOps accounts;
- totals for Today, 7 days, 30 days and All time.

The panel's state is one of **Off**, **Scanning**, **Partial: still reading older
files**, **Complete**, **No usage found** or **Unavailable**. Token analytics runs on
its own schedule, separately from Claude/OpenAI quota checks, so a failing, paused
or blocked quota check does not stop it. A large history is read in several short
passes. The panel refreshes on its own until the scan is complete, then QuotaOps
looks for new activity every 5 minutes.

Totals cover only the sessions on this PC and are not provider-wide billing. Use
**Turn off token analytics** in the panel, or the tray item, to stop it.

### Branding, signing and updates

- `QuotaOps.exe` has the QuotaOps icon and version information, so Explorer, Task
  Manager, the taskbar and the shortcuts show QuotaOps rather than the Electron
  defaults. The installer and uninstaller use the same icon. These were checked on
  Windows 11 for the current test build.
- The build is **not code-signed**, and automatic updates are **off**.

### Uninstall

Use **Settings → Apps → Installed apps → QuotaOps → Uninstall**. The uninstaller
removes the program but keeps `%USERPROFILE%\.quotaops`, which holds your
accounts, browser profiles, the collector token and settings. Delete that folder
yourself if you want to remove them too.

## Google / Antigravity (manual + CLI statusLine preview)

The dashboard accepts Google / Antigravity accounts and model groups, with
separate 5-hour and weekly windows per group and local persistence. Add a
Google account through **Add account**, enter the model group from Antigravity
CLI `/usage`, and enter the used percentage and reset times. Additional
groups can be added directly on the account card.

**The documented Antigravity CLI statusLine interface supports automatic,
event-driven quota snapshots**, when a local Google collector account and
statusLine hook have been explicitly configured. The same opt-in path can
contribute locally observed numeric Token Analytics. It is *not* periodic
refresh with the CLI closed. Google's `/usage` TUI is distinct from statusLine.

Manual Google entries remain available as a fallback. Collector-synced
Google entries are marked **auto-synced**, and no Google credentials, browser
cookies or private endpoint scraping are involved.

See [docs/google-antigravity.md](docs/google-antigravity.md) for setup, validation,
privacy options and limitations. The PR #50 integration is a **Draft candidate**, not a released feature; real authenticated Google CLI E2E and packaged setup validation are still pending.

## Capacity vs Token Analytics

QuotaOps intentionally separates two different signals.

**Capacity** represents provider quota windows, utilization, and reset times.

**Token Analytics** represents token usage observed in local Claude Code / Codex session logs and, after separate opt-in, numeric Antigravity CLI `statusLine` events. It is explicitly labeled **Locally observed** because it is not a provider-wide billing statement or guaranteed lifetime total.

For Codex, cached input is already part of reported input and is shown as a breakdown without being counted twice in total tokens. Claude Code cache reads and cache creation are surfaced as observed token work alongside input and output.

See [docs/token-analytics.md](docs/token-analytics.md) for counting semantics and limitations.

## Local-first data model

Browser-local application state may include:

- account display names;
- optional locally entered email metadata;
- quota percentages and reset timestamps;
- update timestamps;
- theme and notification preferences;
- reset-notification deduplication state.

The collector may also read provider-managed Claude Code and Codex session files, or ingest an opted-in Antigravity CLI numeric `statusLine` event stream, to calculate Token Analytics. QuotaOps parses those files locally and exposes only numeric usage aggregates, timestamps, provider labels, and source health through its collector snapshot.

QuotaOps does not intentionally export or persist prompts, responses, source code, provider passwords, API keys, OAuth tokens, session cookies, private keys, or provider authentication state in its dashboard data.

Voice input uses the browser speech-recognition capability when available. Depending on the browser and operating system, recognition may use a remote service operated by the browser or platform vendor. QuotaOps does not send voice audio to a SO HOMELY backend.

## Run locally

Recommended Node version: **22.21.0**.

Supported toolchain (declared in `package.json` `engines` and pinned in `.node-version`, matching CI):

- Node.js **22.x, 22.21.0 or newer** (CI runs 22.21.0);
- npm **10.9.4 or newer**: npm 10.9.4 (bundled with Node.js 22.21.0, used by CI) and npm 11 both install the committed lockfile with `npm ci`, and CI checks both on Ubuntu and Windows.

```bash
git clone https://github.com/ChrisLeoKokotos/quota-ops.git
cd quota-ops
npm ci --ignore-scripts --no-audit --no-fund
npm run dev
```

The standard `dev` and `start` scripts bind the dashboard to `127.0.0.1` only. Do not expose the dashboard through port forwarding, containers, reverse proxies, or public hosting: the snapshot route is not designed for multi-user remote authentication.

Then open:

```text
the URL the start command prints (an OS-allocated loopback port)
```

Validation:

```bash
npm run typecheck
npm test
npm run build
```

## Local collector

QuotaOps includes an **experimental same-PC collector** for Claude, OpenAI/Codex, and Google/Antigravity. Claude and OpenAI accounts use separate persistent Chrome / Edge profiles: login and human verification are visible and user-controlled; unattended browser collection is **headless** (and may be blocked by provider verification). Google accounts instead use an explicitly configured **Antigravity CLI `statusLine` hook** that publishes events only while the CLI runs—there is no automated Google browser login or CLI-closed polling. Normalized snapshots stay on `127.0.0.1:4317`.

The local API is authenticated with a random local token that stays server-side. Browser-direct collector access is rejected, profile paths are constrained to the protected QuotaOps home, and provider adapters normalize quota metadata before it reaches the dashboard.

Claude collection observes the provider's own Usage-page responses. OpenAI collection uses the authenticated local ChatGPT browser session to read Codex quota metadata; provider access tokens remain inside that isolated browser execution and are not returned in QuotaOps snapshots.

Canonical setup and operations guide: [docs/local-collector.md](docs/local-collector.md).

## Privacy-first Token Analytics opt-in

Background Token Analytics is **off by default**. After reviewing [PRIVACY.md](PRIVACY.md), enable only the source needed:
```powershell
npm run collector:setup -- tokens-auto enable claude-code
npm run collector:setup -- tokens-auto enable codex
npm run collector:setup -- tokens-auto enable google-antigravity
npm run collector:setup -- tokens-auto status
```
The legacy `tokens-auto enable` (no scope) enables Claude Code + Codex but **does not** opt in to Google. `tokens-auto disable all` disables all three sources and blocks new Google numeric counter persistence; it does **not** delete previously stored data. The `tokens` command reads only consented sources. Claude/Codex histories may contain prompts, replies, and project source code even though snapshots expose numeric aggregates.

## Token Analytics

To inspect the locally observed token aggregate directly:

```powershell
npm run collector:setup -- tokens
```

QuotaOps currently scans:

- Claude Code logs under the user's local Claude project history;
- Codex active and archived local session logs;
- optionally, **event-driven** numeric Antigravity CLI observations (not a session-log scan and not provider-wide billing).

The scanner includes deduplication and child/fork replay suppression so copied session history is not intentionally counted as new work.

See [docs/token-analytics.md](docs/token-analytics.md).

## Notifications

Reset notifications are browser-based and designed to work while QuotaOps is running. Reliable notification delivery while the app is fully closed is not part of the current MVP.

## Keyboard shortcuts

- `N` — add account
- `T` — toggle light / dark theme
- `?` — open shortcut help

## Voice input

When supported by the browser, voice input can update manual usage quickly. Example commands include:

- `Dev 1 weekly 82`
- `Dev 2 five hour 40`

Voice input updates usage percentages only. Reset timestamps are still entered manually.

## Stack

- Next.js 16.4.6
- React 19.3
- TypeScript 6.0
- Playwright Core 1.63
- Next.js App Router
- browser local storage
- browser Notification API
- browser speech-recognition API when available
- local Node.js collector

## Security and privacy

QuotaOps is designed to be local-first and credential-minimizing.

Read:

- [SECURITY.md](SECURITY.md)
- [PRIVACY.md](PRIVACY.md)
- [docs/security-architecture.md](docs/security-architecture.md)
- [docs/local-collector-threat-model.md](docs/local-collector-threat-model.md)
- [docs/repository-security-settings.md](docs/repository-security-settings.md)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## Changelog and releases

Notable unreleased changes are maintained in [CHANGELOG.md](CHANGELOG.md). A merged pull request is not treated as a release by itself; versioned releases should intentionally promote entries from `[Unreleased]` into a dated version section.

## Project stewardship

QuotaOps was created by **SO HOMELY** and is maintained through this public repository under the governance model described in [GOVERNANCE.md](GOVERNANCE.md).

## License

Licensed under the Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

Claude, Anthropic, OpenAI, ChatGPT, Codex, Google, Gemini, and Antigravity are third-party names and products. QuotaOps is not affiliated with or endorsed by Anthropic, OpenAI, or Google.
