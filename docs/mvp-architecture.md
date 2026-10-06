# MVP architecture

## Goal

The first QuotaOps MVP solves one concrete problem: show the current Claude Team
capacity of five independent accounts without opening each account to remember its
5-hour and weekly reset windows.

## Scope

The MVP tracks, per account:

- a local label such as `Dev 1`;
- 5-hour usage percentage and exact reset timestamp;
- weekly usage percentage and exact reset timestamp;
- last local update time;
- a derived availability state;
- a best-capacity recommendation across the five accounts.

If a reset timestamp is missing or already in the past, QuotaOps reports
`refresh_required`. It does not invent new capacity.

## Why there is no backend yet

The first version is intentionally browser-local. The data model does not require a
server, authentication, a database, or provider credentials. Adding those pieces
before an automatic provider integration exists would increase attack surface without
solving the core problem.

Snapshots are stored in browser `localStorage`. This is appropriate only for
non-secret quota metadata. Passwords, API keys, session cookies, OAuth tokens,
provider auth state, prompts, and conversation content must never be stored there.

## Planned next boundary: local collector

Automatic collection should be implemented behind a provider adapter boundary.
The preferred order is:

1. supported provider API or documented interface;
2. a local collector that emits only normalized quota metadata;
3. no credential relay to a QuotaOps-operated service.

A future local collector may be a small Python process if Python provides the safest
and most maintainable integration path. Its output contract should contain only
account identity aliases, usage percentages, reset timestamps, source health, and
collection time.

## Normalized snapshot

```json
{
  "account": "dev-1",
  "provider": "claude",
  "plan": "team",
  "five_hour": {
    "used_percent": 82,
    "reset_at": "2026-10-06T05:40:00+03:00"
  },
  "weekly": {
    "used_percent": 100,
    "reset_at": "2026-10-10T14:20:00+03:00"
  },
  "collected_at": "2026-10-06T03:15:00+03:00"
}
```

## Security constraints

- Local-first by default.
- No Claude credentials in the repository or browser storage.
- No hidden telemetry.
- Treat provider-derived data as untrusted input.
- Fail closed to `unknown` / `refresh_required` instead of fabricating capacity.
- Keep provider-specific collection isolated from the core capacity model.
