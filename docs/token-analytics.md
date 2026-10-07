# Token Analytics

QuotaOps is a product created by **SO HOMELY**.

Token Analytics provides a local view of token activity observed in supported developer-tool session logs.

## Scope

Token Analytics currently reads local usage metadata from:

- Claude Code session history;
- Codex active session history;
- Codex archived session history.

The feature is intentionally labeled **Locally observed**.

It is not a provider billing statement, account-wide lifetime total, or guarantee that every provider interaction is represented.

## What is counted

QuotaOps exposes:

- Input tokens;
- Output tokens;
- Cache read tokens;
- Cache write tokens;
- Total tokens processed;
- per-provider totals;
- daily totals.

The dashboard can summarize:

- Today;
- 7 days;
- 30 days;
- All time.

## Counting semantics

### Claude Code

Claude Code records input, output, cache-read, and cache-creation usage in local session records.

QuotaOps treats those categories as locally observed token work and adds them to the Claude total.

Repeated records are deduplicated by message identity. When duplicate representations disagree, QuotaOps keeps the largest observed count for each token category rather than summing copied versions.

### Codex

Codex reports cached input as part of input tokens.

QuotaOps therefore shows cached input as a breakdown but does **not** add it a second time to total tokens.

Codex session files can contain copied parent history in forks or subagents. QuotaOps suppresses the replayed portion before counting live child-session usage. It also ignores unchanged repeated usage snapshots.

## Privacy boundary

QuotaOps parses supported local session files on the same machine.

The normalized Token Analytics snapshot is designed to contain numeric aggregates, dates, provider labels, and source-health information only.

Prompt text, response text, source code, tool content, and raw JSONL records are not intentionally included in the Token Analytics snapshot.

## CLI verification

Run:

```powershell
npm run collector:setup -- tokens
```

A successful result includes:

```json
{
  "scope": "locally_observed",
  "totals": {
    "inputTokens": 0,
    "outputTokens": 0,
    "cacheReadTokens": 0,
    "cacheWriteTokens": 0,
    "totalTokens": 0
  },
  "providers": [],
  "daily": [],
  "sources": []
}
```

The real output depends on locally available session history.

## Source health

Each supported source reports one of:

- `ok` — local session files were found and parsed;
- `not_found` — no supported local session files were found;
- `partial` — some local files could not be read.

A source-health state is not a statement about provider account health.

## Limitations

Token Analytics may differ from provider dashboards or billing records because:

- local history can be deleted or moved;
- activity performed on another machine is not automatically present;
- web-only activity may not create supported local developer-tool logs;
- provider log formats can change;
- local session formats may contain retries, forks, copied history, or cache semantics that require defensive accounting.

QuotaOps should prefer an explicitly incomplete local total over claiming provider-wide completeness it cannot verify.

## Adding another token source

A new source should:

1. have documented local provenance;
2. define cache semantics;
3. defend against duplicate or replayed records;
4. avoid returning raw conversation content;
5. include deterministic parser tests;
6. update privacy, security, architecture, and changelog documentation when its trust boundary differs.
