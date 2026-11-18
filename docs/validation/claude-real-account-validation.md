# Claude real-account validation (owner-run, v0.2.0 gate)

Purpose: establish, with your five existing Claude accounts, whether QuotaOps
can read usage (a) in the background (headless, no windows) and (b) in the
visible, consented mode; whether that still works after you complete a
manual verification; and how quickly verification returns.

You run everything locally. Nothing in this procedure asks for, copies or
exports passwords, cookies, tokens, browser profiles or usage numbers. The
script records statuses only (`ok`, `verification_required`,
`login_required`, `unsupported`, `unavailable`, `error`) and whether values
were returned (yes/no).

## Before you start

1. Back up `%USERPROFILE%\.quotaops` (copy the folder somewhere private). The
   tests do not modify it, but a backup makes that verifiable.
2. Quit QuotaOps from the tray. The script refuses to run while port 4317 is
   in use, because two programs must never open the same browser profile.
3. In the repository on branch `fix/windows-quit-lifecycle-smoke` (Node 22.6+):
   `npm ci --ignore-scripts`.

## Step 1: background baseline (what scheduled collection does)

```powershell
node --experimental-strip-types scripts/claude-account-validation.mjs --mode background
```

No windows open. Expected outcomes per account: `ok` (headless works),
`verification_required` (provider challenge), `login_required`.

## Step 2: visible baseline (what "Refresh with visible browser..." does)

```powershell
node --experimental-strip-types scripts/claude-account-validation.mjs --mode visible --i-accept-visible-windows
```

One browser window per account opens and closes (~15 s each). Do not type
meanwhile. If a window shows "Verify you are human", do **not** complete it in
that automated window; let it close. Step 3 is the supported way.

## Step 3: manual verification, then re-test

For each account that was not `ok`:

1. Start QuotaOps. Tray → **Needs your attention → Manual verification
   required: <account>...** (or **Sign in**). This opens the account's own
   profile in normal Chrome/Edge, not automated.
2. Complete the provider's verification or sign-in yourself; check that
   Settings → Usage shows your usage; close that browser window completely.
3. QuotaOps checks the account once after the window closes. Note what the
   tray and dashboard show.

Then quit QuotaOps and repeat Step 1 and Step 2 immediately.

## Step 4: how quickly does verification return?

```powershell
node --experimental-strip-types scripts/claude-account-validation.mjs --mode both --rounds 4 --interval-min 30 --i-accept-visible-windows
```

Two hours, four rounds, both modes. Leave the computer alone during visible
rounds or use `--mode background` only. Optionally repeat Step 1 the next day.

## Step 5: share the result (optional, your choice)

Reports are written to `%USERPROFILE%\.quotaops\validation\` as `.json` and
`.md`. Accounts appear as `account-1` … `account-5` unless you pass
`--show-labels`. Read the file before sharing it.

## How the result decides v0.2.0

| Observation | Decision |
|---|---|
| Background `ok` for most accounts, verification rare (≥ 2 h apart) | Ship with background collection on (headless) |
| Background challenged, visible `ok` after manual verification | Ship with background collection **off** by default (`backgroundCollection: "off"`); visible refresh documented as the way to update; long-term work continues |
| Visible also challenged after verification | Claude cannot be read automatically within the rules; ship with Claude marked as manual-entry only and explain it in the release notes |
| `unsupported` with no challenge | A real parsing defect; report the run time so it can be reproduced |

In every case the app must show "Manual verification required" / "Sign-in
required" and keep last known values as stale, never 0 % and never "synced".
