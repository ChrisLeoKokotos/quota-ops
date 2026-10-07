# Privacy and Telemetry Principles

QuotaOps is a product created by **SO HOMELY**.

This document describes the current privacy behavior of the MVP and the rules future features must preserve unless they are changed transparently.

## Current default posture

QuotaOps is local-first.

The current MVP has no SO HOMELY-operated backend, hosted database, user account system, or cloud synchronization. An optional same-PC collector can run locally on `127.0.0.1`.

Manual quota data entered into the app is stored in browser local storage for the local QuotaOps origin. Auto-collected quota snapshots remain on the same PC and are exposed to the dashboard through a loopback-only local service. Provider authentication remains inside isolated local browser profiles.

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
- identifiers used to avoid duplicate reset notifications.

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
