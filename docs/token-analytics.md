# Token Analytics

QuotaOps is a product created by **SO HOMELY**.

Token Analytics shows locally observed token activity from supported Claude Code and Codex session history and explicitly opted-in Antigravity statusLine numeric events.

## Scope

The feature is labeled **Locally observed** because it is not a provider billing statement or guaranteed account-wide lifetime total.

The dashboard shows total tokens, input, output, cache read, cache write, provider totals, and Today / 7 days / 30 days / All time views.

## Consent and source states

Each data source has an independent local setting:

```powershell
npm run collector:setup -- tokens-auto enable claude-code
npm run collector:setup -- tokens-auto enable codex
npm run collector:setup -- tokens-auto enable google-antigravity
npm run collector:setup -- tokens-auto status
npm run collector:setup -- tokens-auto disable all
```

All sources default to disabled in a new configuration. A legacy no-scope
`tokens-auto enable` enables **Claude Code and Codex only**, not Google.
Google quota events continue without token consent, but the hook does not
retain numeric token observations until the user separately opts in.
Disabling observation does not delete existing local Google numeric data;
see [PRIVACY.md](../PRIVACY.md) for deletion instructions.

In the Windows desktop app, the tray item **Turn on token analytics...**
turns Claude Code and Codex on together. It shows a dialog that explains what is
read before anything is read, and the item **Token analytics: on (turn off)**
turns them off. This sends `POST /token-analytics/consent` to the local
collector. The collector accepts exactly the keys `claude-code` and `codex`
with the values `0` or `1`, saves the choice in `collector.json`, and
recalculates the totals immediately. Antigravity keeps its own separate opt-in.

Source states are `ok`, `not_found`, `partial`, or `disabled`.
A `disabled` source means it was not scanned/read: it does not mean
the files or events do not exist.

## Counting

For Claude Code, input, output, cache-read, and cache-creation usage are included as observed token work. Repeated records are deduplicated by message identity.

Claude Code session files are read incrementally, newest first. Each
pass reads at most about 1 GB and stops after 20 seconds, and files that have
already been read are resumed from their last offset. A line over 16 MB is
skipped. If that line was a usage record, the source is marked `partial`. Until every
file has been read, the Claude Code source is also `partial`, and its message says
from which date the totals are complete. A prior installed-app scan completed successfully; owner-specific usage and corpus metrics are omitted.

Fixture-verified totals: `tests/token-analytics-fixture.test.ts` checks
known totals for Claude Code (including cache read and write, deduplication by
message id, and an appended file) and Codex (including archived sessions, with
cache as a subset of input). It also checks the Today, 7-day, 30-day and
all-time ranges.

For Codex, cached input is already included within input tokens, so it is displayed as a breakdown without being counted twice. Copied parent history in child or forked sessions is suppressed before live child usage is counted.

For Antigravity CLI, the `statusLine` hook observes cumulative input/output counters **per hashed session**, adds only increases, and assigns the delta to the UTC day when the event arrives. Cache read/write values from the last event are best-effort subsets of the new input delta, not independently billed tokens. All Google totals are **locally observed** and do not promise completeness, billing equivalence or events while the CLI is closed.

## How the collector runs it

Token analytics has its own schedule in the collector (`collector/token-runner.ts`).
It does not depend on Claude/OpenAI quota checks: a challenged, held, paused,
switched-off or failing quota check never stops or freezes the token totals.

- **Without consent:** the state is `disabled` and no file is opened.
- **At start, or right after consent:** the state is `scanning` until the first
  pass returns. While older files are still pending, passes repeat about a second
  apart. After that, QuotaOps looks for new activity every 5 minutes.
- **A failed pass:** the state is `unavailable`. The last good totals are kept, and
  the pass is retried 5 minutes later.

The snapshot carries `tokenStatus: { state, scannedAt, pending }`. The dashboard
combines it with the source states to show one of **Off**, **Scanning**,
**Partial**, **Complete**, **No usage found** or **Unavailable**. While a scan is
running, the dashboard reads the snapshot every 3 seconds, so the totals update
without a restart.

Prior installed-app validation confirmed that totals appear after consent and progress to complete. Private usage metrics are omitted.

## Per-account attribution (Claude Code)

**What the history contains.** Newer Claude Code versions write a `session-owner`
record into each session log. It has exactly four fields: `type`, `sessionId`,
`accountUuid` and `organizationUuid`. It has no email. Subagent files reuse their
parent's `sessionId`. Older sessions have no such record. Assistant records carry
no account field.

**What QuotaOps does with it.**

- Usage is attributed to an account only when its session recorded exactly one
  `accountUuid`.
- Sessions with no owner record are reported as `no_account_record`. Sessions that
  name several accounts are reported as `several_accounts`. Both stay explicitly
  **unattributed**.
- Usage is never guessed, inferred from dates, or split between accounts. Every
  token is in exactly one row.
- Account ids become a salted SHA-256 key (12 hex characters) as soon as they are
  read. The salt is random per QuotaOps home
  (`%USERPROFILE%\.quotaops	oken-account-salt`).
- The account of the current Claude Code login (`~/.claude.json`,
  `oauthAccount.accountUuid`) is hashed the same way, to mark "signed in to Claude
  Code now".

**Historical attribution may be partial.** Sessions without exactly one account record remain unattributed. Owner-specific counts and proportions are omitted. `session-owner`
is an undocumented Claude Code record type and may change. If it changes, more
usage becomes unattributed; none of it is misattributed.

**Not done yet: linking a Claude account to a QuotaOps account (Dev 1–5).**
QuotaOps does not know which hashed account is "Dev 3". Two privacy-preserving
options, both of which need the owner's approval:

1. **Exact id match through the collector.** When a QuotaOps browser profile is
   checked, the collector would read that profile's own Claude account id from the
   claude.ai session it already uses. It would hash the id with the same salt and
   store only the hash. A matching key then links the account by exact identifier,
   with no inference. This reads one more provider value, so it needs approval.
2. **Explicit link by the owner.** The dashboard would offer "this is Dev N" for each
   hashed account. QuotaOps would store only the key and the account id, in
   `collector.json`.

Future sessions are attributed automatically as long as Claude Code keeps writing
`session-owner` records. No hook is needed for that. A Claude Code `SessionStart`
hook that records the hashed current account would be a fallback, if the record
type disappears.

## Verify locally

Run:

```powershell
npm run collector:setup -- tokens
```

The `tokens` CLI displays only sources with explicit consent; otherwise it refuses the scan. Google numeric history is stored in sanitized QuotaOps local state rather than scanned from Gemini CLI history files.

## Limitations

Local totals can differ from provider dashboards when history is missing, activity happened on another device, activity did not create supported local logs/events, or upstream log formats changed. Event-based Google counts stop updating when the CLI is closed, and activity before opting in cannot be reconstructed.

QuotaOps prefers an explicitly local total over claiming provider-wide completeness it cannot verify.

## Consent changes

The collector invalidates old scan generations on consent changes, suppresses stale totals and cooperatively stops history readers. CLI changes are observed through the config file watcher (one-second polling; already pending disk I/O can complete). Google counters use a baseline for each session per consent epoch, counting only subsequent increases. Older stored aggregates are retained, not retrospectively corrected. Existing previously enabled installations start a new baseline on the first updated hook event. Supported CLI and desktop mutations now read the latest configuration under a common filesystem lock.

Rapid CLI off/on changes carry a unique revision so identical final flags cannot conceal a consent transition. Supported configuration updates and Google hook publication use one cross-process lock, acquired before the per-account Google lock. A busy operation can fail and require a retry; a failed revocation is not acknowledged as successful. A disk read already in flight may finish, but invalidated history scan results cannot be published by the runner. The one-off tokens command and authenticated snapshot endpoint check the consent revision under the same lock before queuing results. Already queued output or network responses can arrive later. Desktop consent operations invalidate in-flight IPC token payloads and notify the renderer to clear old totals and reject superseded responses. CLI changes still use the collector's observation boundary and the next renderer refresh. If a process crashes while holding the config lock, stop all QuotaOps desktop, collector, CLI and statusLine hook processes before removing the empty `collector.json.lock` directory from the QuotaOps home. Never remove a live lock. The lock is not a defense against another application running with the same user's permissions or legacy versions that do not honor the lock.
