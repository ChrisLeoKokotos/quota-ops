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
from which date the totals are complete. On 21 Nov 2026 the installed
app's collector code (run by `QuotaOps.exe` as Node) scanned a real history of
381 files and 2.5 GB. The scan was complete after three passes of 3.3 s, 3.1 s
and 1.2 s, with an all-time total of 27.6 billion tokens. Only the numbers were
recorded.

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

On 21 Nov 2026, in the installed app on the owner's PC, the first totals appeared
2 seconds after consent: the state was `ready`, with older files still pending. The
scan was complete after 12 seconds: 381 files, 27.65 billion tokens all time.

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

**Result on the owner's PC (21 Nov 2026).** Three accounts appear in the
history. About two thirds of all-time Claude Code tokens came from sessions with
exactly one account record. About one third came from older sessions without one,
and those stay unattributed. No session named more than one account.

Historical attribution is therefore **partial**. About two thirds of the history can
be attributed exactly, and one third cannot and stays unattributed. `session-owner`
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
