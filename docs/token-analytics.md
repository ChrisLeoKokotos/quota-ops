# Token Analytics

QuotaOps is a product created by **SO HOMELY**.

Token Analytics shows locally observed token activity from supported Claude Code and Codex session history.

## Scope

The feature is labeled **Locally observed** because it is not a provider billing statement or guaranteed account-wide lifetime total.

The dashboard shows total tokens, input, output, cache read, cache write, provider totals, and Today / 7 days / 30 days / All time views.

## Counting

For Claude Code, input, output, cache-read, and cache-creation usage are included as observed token work. Repeated records are deduplicated by message identity.

For Codex, cached input is already included within input tokens, so it is displayed as a breakdown without being counted twice. Copied parent history in child or forked sessions is suppressed before live child usage is counted.

## Verify locally

Run:

```powershell
npm run collector:setup -- tokens
```

Source states are `ok`, `not_found`, or `partial`.

## Limitations

Local totals can differ from provider dashboards when history is missing, activity happened on another device, activity did not create supported local logs, or upstream log formats changed.

QuotaOps prefers an explicitly local total over claiming provider-wide completeness it cannot verify.
