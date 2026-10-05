# Privacy and Telemetry Principles

This document describes the project's intended privacy posture. It is not a promise about features that do not yet exist; implementation must remain consistent with this document or update it transparently.

## Default posture

QuotaOps is intended to be local-first.

Unless clearly documented otherwise, QuotaOps should not transmit provider credentials, session material, prompts, source code, or detailed local activity to project-operated infrastructure.

## Telemetry

QuotaOps should not enable hidden or undocumented telemetry.

If optional telemetry is introduced in the future, it should be:

- clearly documented;
- limited to the minimum data needed;
- separated from authentication credentials;
- easy to disable;
- reviewed for privacy and security implications.

## Logs

Logs must avoid secrets and authentication material. Contributors should treat usage information as potentially sensitive because it may reveal account activity, work patterns, provider choices, or operational schedules.

## Provider integrations

Provider-specific integrations should request the minimum access necessary and should prefer documented, supported interfaces where possible.

## Changes

Any feature that materially changes data collection, persistence, or transmission should update this document in the same pull request.
