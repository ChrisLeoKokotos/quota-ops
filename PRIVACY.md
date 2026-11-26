# Privacy and Telemetry Principles

QuotaOps is a product created by **SO HOMELY**.

This document describes the current privacy behavior of the MVP and the rules future features must preserve unless they are changed transparently.

## Current default posture

QuotaOps is local-first.

The current MVP has no SO HOMELY-operated backend, hosted database, user account system, or cloud synchronization. An optional same-PC collector can run locally on `127.0.0.1`. The dashboard binds a loopback port allocated by the operating system at launch rather than a fixed one.

Manual quota data entered into the app is stored in browser local storage for the local QuotaOps origin. Auto-collected quota snapshots remain on the same PC and are exposed to the dashboard through a loopback-only local service. Claude/OpenAI authentication stays in isolated browser profiles; Google/Antigravity authentication stays in the signed-in provider CLI. QuotaOps does not request Google OAuth material.

**Background Token Analytics session scanning is disabled by default, per source.** Claude Code and Codex history are consented to separately (`npm run collector:setup -- tokens-auto enable claude-code`, or `codex`, or `all`), and `tokens-auto status` reports each one. A source you have not consented to is reported as `disabled`, never as "none found" — QuotaOps does not imply it looked. After opt-in the collector reads that source's local session-history files to derive numeric token aggregates; these files can contain private prompts, responses, and code. The collector does not export their bodies, and the explicit one-off `tokens` CLI command refuses to run without consent.

**Claude account attribution.** With Claude Code consent, QuotaOps also reads the account id that newer Claude Code versions write into each session log (`session-owner` records), and the account id of the current Claude Code login in `%USERPROFILE%\.claude.json`. Account ids are converted at once into a salted one-way hash. The random salt is in `%USERPROFILE%\.quotaops\token-account-salt` and never leaves the PC. Only that hash, session counts and numeric totals appear in snapshots. No email address, organization id or raw account id is stored or shown. Usage from sessions without exactly one recorded account stays explicitly unattributed. In the desktop app, consent is given with the native dialog that opens from the dashboard's **Turn on token analytics** button or from the tray.

**Antigravity event and token consent.** A configured Google account may receive sanitized numeric quota windows from the Antigravity CLI `statusLine` hook without enabling Token Analytics. Google numeric token observation is **disabled by default**, independent of Claude Code and Codex:
`npm run collector:setup -- tokens-auto enable google-antigravity`.
Consent must be enabled **before** a hook event to retain that event's token counters; the first counter for each session in each opt-in epoch is a baseline, not counted; only subsequent increases count. Earlier usage is not backfilled. Existing aggregates remain; same-session counter decreases are conservatively ignored. `tokens-auto disable google-antigravity` stops subsequent numeric counter collection, and `tokens-auto disable all` disables all three sources. An unscoped `tokens-auto enable` never silently enables Google. Disabling does **not** erase previously captured Google totals.

**Google local storage and deletion.** The hook receives provider JSON on stdin and writes a sanitized per-account file, for example `%USERPROFILE%\\.quotaops\\google-statusline\\google-1.json`. It retains normalized quota buckets, reset times, a bounded plan label and last-seen timestamp. Only with prior token consent does it store hashed session identifiers, cumulative numeric counters, aggregated daily tokens and cached-token approximations. It does **not** persist raw JSON, account email, transcript paths, workspace paths, prompts or authentication secrets. The stored session hashes are pseudonymous identifiers, not proof of account identity. Stale quotas older than 15 minutes fail closed; this is CLI-event collection, not polling while Antigravity is closed.

To erase previous Google observations, quit QuotaOps and stop any running collector/Antigravity hook; back up non-sensitive settings if desired, then delete the matching file(s) from `%USERPROFILE%\\.quotaops\\google-statusline\\`. After restarting, the hook will create fresh files if still configured; disable the integration or remove the configured Google account to stop collection. Do not delete the whole `.quotaops` directory unless you intentionally want to remove other providers' settings, tokens and profiles too.

**What consent does not do.** It controls what QuotaOps reads. It does not change the Windows permissions of those files, which remain readable by anything running under your account — another application, a dependency in any project, or malware. Turning a source off invalidates previous displayed totals and cooperatively stops an ongoing scan once the change is observed (CLI changes are watched at one-second intervals; already pending disk reads may finish; Google hook publication, snapshot response preparation and supported configuration updates share a cross-process lock; previously queued transport responses can still arrive later). A failed or busy lock prevents a new write/publication; a crashed lock owner may require manual recovery. It does not protect the files from anything else. *(Residual risk B, accepted 15 October 2026.)*

**What local-first does not mean.** QuotaOps protects your data from the network and from other users of the machine. It is not a defence against code already running under your own Windows account: such a process can reach the loopback services and read the browser profiles holding provider sessions, with or without QuotaOps. *(Residual risk A, accepted 15 October 2026.)*

## Data currently stored locally

The MVP may store:

- user-defined account labels;
- optional user-entered account email metadata;
- 5-hour usage percentages;
- weekly usage percentages;
- reset timestamps;
- local update timestamps;
- theme preference;
- notification preference;
- identifiers used to avoid duplicate reset notifications;
- sanitized per-account Google statusLine metadata and, only after source-specific consent, numeric token aggregates and hashed session watermarks.

These values are operational metadata, not secrets.

## Data QuotaOps does not intentionally collect

Outside the provider-managed isolated browser profiles required to preserve login sessions, the current application does not intentionally collect or store:

- provider passwords;
- API keys;
- OAuth access or refresh tokens;
- session cookies;
- private keys;
- prompts;
- conversations;
- source code;
- browser history;
- unrelated personal data.

## Telemetry

QuotaOps application code does not currently implement product analytics or hidden telemetry.

Development tools and third-party runtimes may have their own telemetry behavior. Contributors should review and document such behavior before introducing new runtime dependencies or hosted services.

## Voice input

Voice input is optional and activated only by the user.

QuotaOps uses the browser's speech-recognition capability when available. Depending on the browser, operating system, and configuration, audio may be processed by a remote service operated by the browser or platform vendor.

QuotaOps does not send voice audio or transcripts to a SO HOMELY backend because no such backend exists in the current MVP.

Users who require fully offline operation should avoid voice input unless their browser explicitly provides on-device recognition.

## Notifications

Browser / OS notifications are optional and permission-gated.

Current notification content is limited to non-secret quota information such as account label, quota window, and reset state.

Reliable background notifications while QuotaOps is fully closed are not currently implemented.

## Logs

Logs must avoid secrets and authentication material. Usage information should be treated as potentially sensitive because it may reveal work patterns, provider choices, or operational schedules.

## Future provider integrations

Provider-specific integrations should request the minimum access necessary and prefer documented, supported interfaces.

A future local collector must not relay provider credentials to SO HOMELY-operated infrastructure merely to obtain quota information.

## Future remote features

Any feature that introduces hosted storage, remote synchronization, telemetry, account authentication, or a SO HOMELY-operated service must:

- be clearly documented;
- minimize collected data;
- define retention and deletion behavior;
- receive dedicated security and privacy review;
- update this document in the same pull request.
