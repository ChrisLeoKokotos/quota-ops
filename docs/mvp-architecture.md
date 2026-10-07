# MVP Architecture

QuotaOps is a product created by **SO HOMELY**.

## Goal

The current MVP provides a single local view of AI-provider accounts so a user can see quota usage, know when each quota resets, decide which account has usable capacity, and inspect locally observed token activity. Claude and OpenAI / ChatGPT Codex are the first supported providers.

The original use case involved five accounts, but the current UI supports adding and removing account entries rather than enforcing a fixed count.

## Current architecture

```text
Browser
  |
  +-- Next.js UI
  |     |
  |     +-- quota / recommendation logic
  |     +-- browser localStorage
  |     +-- optional Notification API
  |     +-- optional browser speech recognition
  |
  +-- http://127.0.0.1:4317 (optional)
        |
        +-- QuotaOps local collector
              |
              +-- isolated provider browser profiles
              +-- Claude / OpenAI quota adapters
              +-- Claude Code local token scanner
              +-- Codex local token scanner
```

There is currently:

- no hosted QuotaOps backend;
- no hosted database;
- no QuotaOps login;
- no cloud synchronization;
- an optional experimental same-PC multi-provider quota collector;
- local Token Analytics from Claude Code and Codex session history.

## Current account model

Each account contains:

- local account id;
- local display label;
- optional locally entered email metadata;
- source: manual or collector;
- provider and plan label;
- one or more named quota windows;
- usage percentage and reset timestamp per window;
- local update timestamp.

## Derived states

QuotaOps derives states from stored metadata:

- `available` — quota is usable;
- `low` — at least one known quota window is near the low-capacity threshold;
- `limited` — at least one quota window is exhausted;
- `exhausted` — all known quota windows are exhausted;
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

## Token Analytics

Token Analytics is separate from provider capacity.

The collector scans supported local Claude Code and Codex session history, normalizes numeric token usage, and exposes aggregate totals to the dashboard. The dashboard supports Today, 7 days, 30 days, and All time views.

The analytics snapshot is explicitly labeled `locally_observed`. It is not treated as a provider billing statement or guaranteed account-wide lifetime total.

See [token-analytics.md](token-analytics.md).

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

## Local collector boundary

The repository now contains an experimental local collector.

Each collector account is assigned a provider and a separate persistent Chrome / Edge profile. The user signs in interactively to the intended provider account inside that profile. Claude collection observes the real Usage-page response. OpenAI collection reads Codex quota metadata from the authenticated ChatGPT browser session without returning the session token in the collector snapshot.

The collector:

- binds only to `127.0.0.1:4317`;
- returns normalized quota and local Token Analytics snapshots;
- does not expose provider cookies or tokens through its API;
- polls accounts sequentially to reduce local resource use;
- reports login, availability, or unsupported-format failures explicitly;
- supports per-account `collect`, `enable`, and `disable` operations so accounts can be validated independently before joining the background refresh loop.

Provider web quota surfaces are not treated as stable public APIs. Adapters are isolated so provider changes fail closed instead of corrupting the core quota model.

See [local-collector.md](local-collector.md).

## Normalized snapshot

```json
{
  "id": "openai-1",
  "provider": "openai",
  "plan": "pro",
  "windows": [
    {
      "id": "five-hour",
      "label": "5-hour",
      "usedPercent": 27,
      "resetAt": "2026-10-07T19:30:00.000Z"
    },
    {
      "id": "weekly",
      "label": "Weekly",
      "usedPercent": 21,
      "resetAt": "2026-10-12T03:00:00.000Z"
    }
  ]
}
```

## Security constraints

- Local-first by default.
- No provider credentials in repository or browser local storage.
- No hidden product telemetry.
- Treat provider-derived and voice-derived data as untrusted input.
- Fail closed to `needs_setup` or `refresh_required` rather than fabricating capacity.
- Keep provider-specific collection isolated from the core quota model.
- Keep Token Analytics explicitly local and distinguish it from provider billing or account-wide totals.
