# Lily companion — local read-only connector (V1)

QuotaOps now exposes **one narrow local data endpoint for Lily only**. It is neither a general-purpose assistant API nor an MCP server. The QuotaOps collector remains the sole collector of Claude/OpenAI account quota and locally observed token statistics.

## Security boundary

- Existing QuotaOps collector stays bound to `127.0.0.1:4317` and never listens on LAN or the internet.
- Existing admin-level `collector.token` continues to authorize `GET /snapshot` and `GET /health`.
- A **different**, cryptographically random credential at `%USERPROFILE%\.quotaops\lily-read.token` authorizes **only** `GET /lily/v1/snapshot`.
- The Lily read-only credential cannot call the regular collector routes. Likewise, `collector.token` cannot call Lily's route.
- Direct browser calls with an `Origin` header are rejected; only an explicitly authorized native client should read the token. Neither token belongs in browser JavaScript, URLs, source control, client settings, telemetry or logs.
- The local token is protected using the QuotaOps user's existing hardened home ACLs. Another process with the **same Windows-user privileges** can generally read it; this is OS-account isolation, not sandboxing against same-user malware.
- Both the collector and Lily must run as the **same Windows account**, on the **same computer**. No port forwarding, firewall exception, cloud sync or browser automation is added by this feature.
- The public interface strips account emails, profile paths, diagnostic messages, source file names, provider access tokens, conversation text and passwords. It returns bounded account IDs/display labels, provider/plan, quota windows, actual `checkedAt` timestamps, status and locally observed token aggregates.
- Lily authorization is separate, and **disabled by default in Lily Settings**. Turning it on allows native Lily to read the above data every 60 seconds, without browser access.

## Endpoint

`GET http://127.0.0.1:4317/lily/v1/snapshot` with `Authorization: Bearer <lily-only-token>`.

Response: version `1`, scope `lily_readonly`, `generatedAt`, `accounts`, `recommendation`, and `tokens` with four ranges: today, 7d, 30d, all. Token scope is always `locally_observed`; it is not provider account billing usage.

**Freshness:** an account whose last collection is older than 15 minutes is marked stale and cannot be recommended. Token Analytics over 20 minutes old is marked stale. `generatedAt` records response creation, **not** provider collection. No stale value may be presented as live capacity.

**Manual quota entries** live in the QuotaOps browser's `localStorage` and are intentionally not included in this collector-only V1 endpoint. Do not silently scrape another app's browser database.

## Start both apps (same Windows account)

In the QuotaOps checkout:

```powershell
npm ci --ignore-scripts --no-audit --no-fund
npm run collector:setup -- security-check
npm run collector:start
```

The collector creates a distinct `lily-read.token` automatically on launch. You do **not** need to copy a token to Lily.

In the Lily Windows development build, open **Settings → QuotaOps** and enable **Let Lily read my local QuotaOps summary**. Then open the island and click **Check AI quotas**. Lily uses a strict loopback-only Rust client and displays read-only quota status and token totals.

To revoke Lily access, disable it in Lily Settings; for immediate credential invalidation rotate the QuotaOps Lily token:

```powershell
npm run collector:setup -- rotate-lily-token
```

Restart the collector so it loads the new token. Lily will read it from the protected same-user file at its next poll. Do not rotate the normal collector token merely to revoke Lily.

## Validation

From QuotaOps:

```powershell
npm run typecheck
npm test
npm run build
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\e2e-lily-readonly.ps1
```

The E2E test requires the local collector to be running and never prints token values.

From Lily:

```powershell
npm test
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
```

The final Windows graphical acceptance still requires launching Lily on the **same Windows user**: opt in, check live quotas, verify offline/stale behavior when stopping QuotaOps, disable and confirm no more local reads. The automated QuotaOps integration test spawns a disposable collector with an empty temporary home to check HTTP authorization and schema without using real provider credentials.

No automatic account switching, voice commands, session management, remote assistant support or mobile push forwarding is part of this V1 read-only connector.
