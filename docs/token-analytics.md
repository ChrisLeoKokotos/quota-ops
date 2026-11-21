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

## Verify locally

Run:

```powershell
npm run collector:setup -- tokens
```

The `tokens` CLI displays only sources with explicit consent; otherwise it refuses the scan. Google numeric history is stored in sanitized QuotaOps local state rather than scanned from Gemini CLI history files.

## Limitations

Local totals can differ from provider dashboards when history is missing, activity happened on another device, activity did not create supported local logs/events, or upstream log formats changed. Event-based Google counts stop updating when the CLI is closed, and activity before opting in cannot be reconstructed.

QuotaOps prefers an explicitly local total over claiming provider-wide completeness it cannot verify.
