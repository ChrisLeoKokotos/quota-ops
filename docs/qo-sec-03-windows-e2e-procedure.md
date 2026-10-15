# QO-SEC-03 — Windows authenticated E2E procedure

**For:** the repository owner, running on a Windows 11 machine.
**Purpose:** close the one remaining release blocker on PR #20 — that real
authenticated browser collection has never been verified. The automated test
is synthetic: it opens and closes a browser without ever logging in.

**Time:** about 45 minutes.

---

## What you must never send back

Report **PASS / FAIL and a sanitized reason only**. Do not paste, attach or
screenshot any of the following, in a PR comment, an issue, a chat message or
a log file:

- passwords or one-time codes
- browser cookies, `Local Storage`, `Session Storage` or profile folders
- OAuth tokens, API keys, or the QuotaOps collector bearer token
- `.jsonl` session-history files or any excerpt of their contents
- raw `icacls` output
- screenshots showing an account email, a session, or a token

If a step fails, describe it in your own words — "collection failed with a
timeout after login" — rather than pasting the output. If you think the raw
output is needed to diagnose it, say so and we will work out a redacted form.

## Before you start

1. **Use a disposable provider account.** Create a throwaway Claude or OpenAI
   account for this. Do not use your real one. If the only practical option is
   a real account, say so before starting rather than proceeding.
2. **Use a test machine or test profile** if you have one. The browser profiles
   QuotaOps creates live under `%USERPROFILE%\.quotaops\browser-profiles`.
3. Check out the PR #20 branch and record the commit:

   ```powershell
   git -C C:\Code\quota-ops rev-parse HEAD
   git -C C:\Code\quota-ops status --short --branch
   ```

4. Install from the lockfile and confirm the suite is green before touching
   anything authenticated:

   ```powershell
   npm ci --ignore-scripts --no-audit --no-fund
   npm run typecheck
   npm test
   npm run build
   ```

---

## Step 1 — First-time authenticated login

```powershell
npm run collector:setup -- list
```

Pick one account id, or add a test account (note the argument order —
provider first):

```powershell
npm run collector:setup -- add claude <test-id> "Disposable test"
```

Log in interactively. This opens a browser window:

```powershell
npm run collector:setup -- login <test-id>
```

Log in **in that window**, then collect:

```powershell
npm run collector:setup -- collect <test-id>
```

| Check | Record |
|---|---|
| 1.1 A browser window opened and let you log in | PASS / FAIL |
| 1.2 Collection completed and reported quota figures | PASS / FAIL |
| 1.3 The figures look plausible for that account | PASS / FAIL |
| 1.4 No password, token or cookie appeared in the console output | PASS / FAIL |

---

## Step 2 — Session reuse

Run the same command again **without** logging in:

```powershell
npm run collector:setup -- collect <test-id>
```

| Check | Record |
|---|---|
| 2.1 Collection succeeded without asking you to log in again | PASS / FAIL |
| 2.2 No second browser profile directory was created | PASS / FAIL |

---

## Step 3 — Process cleanup

Immediately after a collection finishes:

```powershell
Get-Process chrome,msedge -ErrorAction SilentlyContinue |
  Where-Object { $_.Path -like "*quotaops*" } |
  Measure-Object | Select-Object -ExpandProperty Count

Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
  Where-Object { $_.LocalPort -ge 9222 -and $_.LocalPort -le 9322 } |
  Measure-Object | Select-Object -ExpandProperty Count
```

| Check | Expected | Record |
|---|---|---|
| 3.1 QuotaOps browser processes remaining | `0` | PASS / FAIL |
| 3.2 Listeners in the remote-debugging range | `0` | PASS / FAIL |

Report the two numbers. They are counts, not content, so they are safe to send.

---

## Step 4 — Session expiry

Sign the test account out from the provider's own website inside the QuotaOps
browser profile, or wait for the session to lapse. Then:

```powershell
npm run collector:setup -- collect <test-id>
```

| Check | Expected | Record |
|---|---|---|
| 4.1 The result is reported as `login_required` or a clear equivalent | not a fabricated zero or a stale figure | PASS / FAIL |
| 4.2 The dashboard shows the account as needing attention, not as 0% used | | PASS / FAIL |
| 4.3 Processes cleaned up as in Step 3 | `0` and `0` | PASS / FAIL |

**4.1 and 4.2 are the important ones.** A quota that cannot be read must stay
unknown. If anything displays `0%`, "available", or the previous reading
without marking it stale, that is a FAIL and a release blocker.

---

## Step 5 — Account isolation and switching

Configure a second test account (a second disposable account, or the same
provider with a different id):

```powershell
npm run collector:setup -- add claude <test-id-2> "Disposable test 2"
npm run collector:setup -- login <test-id-2>
npm run collector:setup -- collect <test-id-2>
npm run collector:setup -- collect <test-id>
```

| Check | Expected | Record |
|---|---|---|
| 5.1 Each account has its own directory under `browser-profiles` | two separate directories | PASS / FAIL |
| 5.2 Logging into account 2 did not log you out of account 1 | | PASS / FAIL |
| 5.3 Each collection returned that account's own figures | no cross-contamination | PASS / FAIL |

Report the **number** of profile directories, not their names or contents.

---

## Step 6 — Failure paths

Disconnect from the network, then:

```powershell
npm run collector:setup -- collect <test-id>
```

| Check | Expected | Record |
|---|---|---|
| 6.1 The failure is reported clearly | not a crash, not a silent success | PASS / FAIL |
| 6.2 No quota figure was invented | previous value marked stale or omitted | PASS / FAIL |
| 6.3 Processes cleaned up | `0` and `0` | PASS / FAIL |

Reconnect afterwards.

---

## Step 7 — Windows profile permissions

```powershell
icacls "$env:USERPROFILE\.quotaops"
icacls "$env:USERPROFILE\.quotaops\browser-profiles"
```

**Read the output yourself. Do not paste it.** Answer:

| Check | Expected | Record |
|---|---|---|
| 7.1 Inheritance is disabled on `.quotaops` | no inherited entries | PASS / FAIL |
| 7.2 The only non-system principals are you, SYSTEM and Administrators | | PASS / FAIL |
| 7.3 `Everyone`, `Users` or `Authenticated Users` do **not** appear | | PASS / FAIL |

If 7.3 fails, that is a release blocker — report it as "7.3 FAIL" and nothing more.

---

## Step 8 — No credential material in snapshots

With the collector running:

```powershell
npm run collector:start
```

In a second terminal, start the dashboard and open it:

```powershell
npm start
```

Open `http://127.0.0.1:3000`, let it load, then in the browser press F12 →
Application → Local Storage and Session Storage for that origin.

| Check | Expected | Record |
|---|---|---|
| 8.1 No provider token, cookie value or password appears in browser storage | | PASS / FAIL |
| 8.2 No prompt text or source-code excerpt appears anywhere in the UI | | PASS / FAIL |
| 8.3 The collector terminal printed no token or cookie | | PASS / FAIL |

---

## Step 9 — The automated boundary test, on this machine

```powershell
powershell -NoProfile -File .\scripts\windows-security-smoke.ps1
node --experimental-strip-types scripts\windows-browser-smoke.ts
npm run collector:setup -- security-check
npm run collector:setup -- tokens-auto status
```

| Check | Expected | Record |
|---|---|---|
| 9.1 Security smoke | PASS, 7 refused requests | PASS / FAIL |
| 9.2 Browser smoke | PASS | PASS / FAIL |
| 9.3 `security-check` | passes for your configured profiles | PASS / FAIL |
| 9.4 `tokens-auto status` | `disabled` for both sources unless you enabled them | PASS / FAIL |

---

## Step 10 — Optional: LAN isolation from a second device

Only if you have a second device on the same network and can do this without
disabling any firewall.

From the second device, with the dashboard and collector running on the test
machine, attempt to reach `http://<test-machine-LAN-IP>:3000` and `:4317`.

| Check | Expected | Record |
|---|---|---|
| 10.1 Port 3000 from another device | refused or times out | PASS / FAIL |
| 10.2 Port 4317 from another device | refused or times out | PASS / FAIL |

**Do not disable the Windows firewall to make this test "work".** If a port is
reachable, that is a finding — report it.

---

## What to send back

A single comment on PR #20 in this shape, and nothing else:

```
QO-SEC-03 E2E — commit <sha>, Windows <version>, Node <version>

1.1 PASS  1.2 PASS  1.3 PASS  1.4 PASS
2.1 PASS  2.2 PASS
3.1 PASS (0)  3.2 PASS (0)
4.1 PASS  4.2 PASS  4.3 PASS
5.1 PASS (2 directories)  5.2 PASS  5.3 PASS
6.1 PASS  6.2 PASS  6.3 PASS
7.1 PASS  7.2 PASS  7.3 PASS
8.1 PASS  8.2 PASS  8.3 PASS
9.1 PASS  9.2 PASS  9.3 PASS  9.4 PASS
10.1 PASS  10.2 PASS   (or: SKIPPED - no second device)

Failures: <plain-language description, no raw output>
```

Any FAIL blocks PR #20. Report it and stop rather than working around it — a
fix and a re-run of the affected steps is the correct path.
