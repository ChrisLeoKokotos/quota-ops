# MVP Architecture

QuotaOps is a product created by **SO HOMELY**.

## Goal

The current MVP solves one concrete operational problem: provide a single local view of multiple Claude Team accounts so a user can see 5-hour and weekly usage, know when each quota resets, and decide which account has usable capacity.

The original use case involved five accounts, but the current UI supports adding and removing account entries rather than enforcing a fixed count.

## Current architecture

```text
Browser
  |
  +-- Next.js UI
  |
  +-- quota / recommendation logic
  |
  +-- browser localStorage
  |
  +-- optional Notification API
  |
  +-- optional browser speech recognition
```

There is currently:

- no QuotaOps backend;
- no hosted database;
- no QuotaOps login;
- no cloud synchronization;
- no automatic Claude quota collector.

## Current account model

Each account contains:

- local account id;
- local display label;
- provider: currently Claude;
- plan: currently Team;
- 5-hour usage percentage;
- 5-hour reset timestamp;
- weekly usage percentage;
- weekly reset timestamp;
- local update timestamp.

## Derived states

QuotaOps derives states from stored metadata:

- `available` — quota is usable;
- `low` — at least one known quota window is near the low-capacity threshold;
- `five_hour_limited` — 5-hour usage is exhausted before its reset;
- `weekly_limited` — weekly usage is exhausted before its reset;
- `exhausted` — both windows are exhausted;
- `needs_setup` — required reset metadata is missing;
- `refresh_required` — a known reset timestamp has passed and current usage must be refreshed.

QuotaOps does not assume that a passed reset automatically means the account is available. It requires a fresh snapshot.

## Recommendation model

Accounts that are exhausted, incomplete, or stale are excluded from recommendation.

For usable accounts, the current recommendation score weights:

- weekly remaining capacity: 70%;
- 5-hour remaining capacity: 30%.

This is an MVP heuristic, not a provider guarantee.

## Local persistence

Current browser storage includes:

- account metadata;
- quota percentages;
- reset timestamps;
- update timestamps;
- theme preference;
- notification preference;
- reset-notification deduplication state.

Browser local storage is used only for non-secret operational metadata.

## Notifications

When enabled, QuotaOps checks for recently reached reset timestamps and can surface:

- in-app notifications;
- browser / OS notifications when permission is granted.

This notification path depends on the app running. A future background collector is the intended place for reliable notifications while the UI is closed.

## Voice input

The current voice command parser supports quick usage-percentage updates against an existing account label and quota window.

Example:

```text
Dev 1 weekly 82
```

The browser speech-recognition implementation may be local or remote depending on the browser / platform. The MVP does not provide its own speech backend.

## Keyboard shortcuts

The current UI provides:

- `N` — add account;
- `T` — toggle theme;
- `?` — open shortcut help.

## Why there is no backend yet

A server, authentication system, and database would increase attack surface without solving the current manual-tracking problem.

The backend boundary should only be introduced when a concrete feature requires it.

## Planned next boundary: local collector

Automatic collection should live behind a narrow provider adapter.

Preferred order:

1. documented / supported provider quota interface;
2. otherwise a security-reviewed local collector;
3. normalized quota metadata output only;
4. no provider credential relay to SO HOMELY-operated infrastructure.

A future collector may use Python if it remains the safest and most maintainable option.

## Normalized future snapshot

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
- No provider credentials in repository or browser local storage.
- No hidden product telemetry.
- Treat provider-derived and voice-derived data as untrusted input.
- Fail closed to `needs_setup` or `refresh_required` rather than fabricating capacity.
- Keep provider-specific collection isolated from the core quota model.
