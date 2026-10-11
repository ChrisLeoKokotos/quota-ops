# PR #20 — security closure and Windows acceptance

This is an acceptance checklist, **not** an assertion that every risk is eliminated.
GitHub Actions validate source behavior on clean Windows runners; they cannot
test the ACLs, browsers, firewall or logged-in profiles of an actual user's PC.

## Automated evidence

- Linux: `npm ci --ignore-scripts`, `npm audit --omit=dev`, TypeScript, unit tests and Next.js production build.
- Windows: locked dependency installation, unit tests, Next.js production build, PowerShell loopback listening test, negative snapshot access tests, and a synthetic Playwright Chrome/Edge browser lifecycle test **without logging into a provider**.
- Repository Guard, Dependency Review and CodeQL.
- New tests must run after every change; older green runs do not validate a new head commit.

## Safe manual checks on a dedicated Windows 11 test environment

Do not send passwords, access tokens, raw browser profiles, `.jsonl` session
files, `icacls` dumps or private logs in comments or chat. Report only PASS/FAIL
and sanitized diagnostic reason. Use a non-production test account for browser E2E.

1. Verify the checked-out PR branch; use `git status --short --branch`. Install
   locked dependencies: `npm ci --ignore-scripts --no-audit --no-fund`.
2. Run `npm run typecheck`, `npm test`, then `npm run build`.
3. Run `pwsh -NoProfile -File scripts/windows-security-smoke.ps1` on a PC
   where no unrelated process occupies port 3000. Expected: a PASS message
   for a `127.0.0.1` listener and three rejected unauthorized HTTP requests.
   Never expose the app through a reverse proxy/port-forwarding to make this work.
4. Run `npm run collector:setup -- security-check`; confirm it reports a
   successful local collector configuration. Independently inspect local ACLs
   on `%USERPROFILE%\.quotaops` **without publishing their raw contents**.
5. Run `npm run collector:setup -- tokens-auto status`; expected on a new or
   migrated config is `disabled`. Enabling it reads personal Claude Code and
   Codex histories; this test does not require enabling it.
6. Using a **test** provider profile only, verify interactive provider login,
   `npm run collector:setup -- collect <test-id>`, scheduled refresh, failure
   paths (offline and session expiry), and process cleanup. Check in local
   process tools that no QuotaOps browser process remains after collection;
   confirm no `--remote-debugging-port` listener is introduced. Do not send
   screenshots containing tokens or cookie content.
7. With the collector running, verify `Get-NetTCPConnection -LocalPort 4317
   -State Listen` reports only `127.0.0.1` for the collector. Verify a
   request without its private bearer token is rejected; never print the token.
8. On a separate LAN client, the Windows test PC's private LAN IP should not
   serve port 3000 or 4317. Do not temporarily disable the firewall to test.
9. Record explicit PASS/FAIL for each item and repeat the automated suite
   after any security-relevant changes.

## Release blockers

- QO-SEC-01: loopback default and Windows synthetic tests exist, but a
  misconfigured public reverse proxy remains an unsupported deployment.
  Decide whether the current local-only product scope is accepted; remote UI
  would need **real** authorization, not spoofable request headers.
- QO-SEC-02: background scanning is opt-in; without OS privilege isolation,
  same-user malware/dependencies can still read files the account can read.
  Explicitly accept/reject this residual risk before closure.
- QO-SEC-03: synthetic private-browser lifecycle is automated. Real provider
  sessions, locked-down profile permissions and long-running process cleanup
  require manual Windows E2E using a disposable account.
- QO-SEC-04: file/record limits, synthetic adversarial tests, and Windows unit
  tests exist. Resource profiling with pathological-but-valid JSONL and
  interrupted reads is still needed for confidence.
- QO-SEC-05: remote runtime telemetry must remain disabled/unimplemented
  until a distinct reviewed security design and negative tests exist.
- QO-SEC-06: lockfile, pinned CI actions and dependency checks exist. Any
  distributable Windows EXE must separately pass artifact integrity,
  SBOM/provenance and signing review before publishing.

**Merge hold:** PR #20 stays Draft until all six closure dispositions are
documented and independently re-reviewed; review of code is not a substitute
for testing real authenticated Windows sessions.
