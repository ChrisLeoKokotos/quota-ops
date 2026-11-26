# Validation record — PR #20, QO-SEC-01 authorization boundary

**Commit under test:** `a292efa49e05b706cbb711eaa6ed9d66a5cbc70f`
**Branch:** `security/local-only-dashboard-review`
**Date:** 2026-10-15
**Operator:** local developer run (no hosted runner)

## Environment

| Item | Value |
|---|---|
| OS | Windows 11 Home 10.0.26200 |
| Node.js | v22.22.2 |
| npm | 10.9.7 |
| Dependencies | existing `node_modules` from `package-lock.json` |
| Hosted CI | **unavailable** — GitHub Actions not exercised for this commit |

`npm ci` was **not** re-run for this commit; the installed tree already
matched `package-lock.json` from the previous validated run. A clean
`npm ci --ignore-scripts` run is required before merge.

## Automated results

| Command | Exit | Result |
|---|---|---|
| `npm run typecheck` | 0 | PASS — no diagnostics |
| `npm test` | 0 | PASS — 75 tests, 0 failures (49 before this change) |
| `npm run build` | 0 | PASS — Next.js 16.3.8 production build, routes `/`, `/api/collector/capability`, `/api/collector/snapshot` |

## Live boundary evidence

Trusted server started as `PORT=3100 node --experimental-strip-types
server/dashboard-server.ts --production`. Every request below was issued
from the same host over loopback unless stated otherwise.

| # | Attack / case | Observed | Verdict |
|---|---|---|---|
| 1 | Forged `X-QuotaOps-Client: dashboard` (the removed control) | `403 {"reason":"missing_capability"}` | PASS |
| 2 | No capability presented | `403 {"reason":"missing_capability"}` | PASS |
| 3 | Forged `X-QuotaOps-Peer` + `X-QuotaOps-Peer-Address` | `403 {"reason":"missing_capability"}` — inbound copies stripped | PASS |
| 4 | `X-Forwarded-For: 203.0.113.9` | `403 {"error":"forwarded_request"}` at the server layer | PASS |
| 5 | Capability mint via `/api/collector/capability` | `200`, 61-char `qo1.<expiry>.<mac>` token | PASS |
| 6 | Snapshot with a valid capability | `503 collector_offline` — authorization passed, collector not running | PASS |
| 7 | Capability with a tampered final MAC byte | `403 {"reason":"invalid_capability"}` | PASS |
| 8 | `Host: evil.test:3100` | `403 {"reason":"invalid_host"}` | PASS |
| 9 | `Origin: http://evil.test` | `403 {"reason":"cross_origin"}` | PASS |
| 10 | `Get-NetTCPConnection -LocalPort 3100 -State Listen` | `127.0.0.1:3100` only — no `0.0.0.0`, no LAN address | PASS |
| 11 | TCP connect to `192.168.1.163:3100` (host's own LAN address) | connection refused | PASS |
| 12 | `HOSTNAME=0.0.0.0` startup attempt | process throws and does not listen | PASS |

No credentials, tokens, cookies, session files or raw capability values are
recorded here. Case 5 records only the token length and public prefix.

## What this evidence does and does not establish

Established:

- The documented start commands cannot serve the dashboard beyond loopback.
- A header-only client cannot retrieve a snapshot, including with the exact
  marker the previous implementation accepted.
- A reverse-proxied request is refused before Next.js handles it.
- The host's own LAN address does not accept connections on the dashboard port.

Not established:

- Behaviour behind a deliberately configured reverse proxy or port forward.
  That remains an **unsupported deployment**, now refused rather than served.
- Isolation from another process running under the same Windows account.
  That process can read the capability endpoint over loopback; see the
  residual-risk entry in `docs/security-architecture.md`.
- A second-device LAN scan from separate hardware. Case 11 probes the host's
  own LAN interface, which is weaker evidence than an external scanner.
- Any hosted CodeQL, Dependency Review or Repository Guard result for this
  commit. Those required checks remain outstanding.

## Required follow-up before merge

1. Clean `npm ci --ignore-scripts --no-audit --no-fund` and full re-run.
2. `npm audit --omit=dev --audit-level=high` (needs network access).
3. `powershell -NoProfile -File .\scripts\windows-security-smoke.ps1` updated
   for the trusted-server start command.
4. Hosted GitHub required checks once Actions billing is restored.
5. Independent security re-review of the capability design.
