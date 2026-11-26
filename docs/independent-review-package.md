# Independent security review — reconciled entry point

This document preserves the review requirements of [PR #20](https://github.com/ChrisLeoKokotos/quota-ops/pull/20), including its three unique historical documentation commits. The original review package and revised October handoff remain available at the immutable source revision `e7cb2d8ad8cbe601021c06a1455a363e75d9b8b5`. They are historical evidence, not current sign-off. The current review target is integration PR #56.

## Original decisions and outstanding review

- A1 and B1: October owner decisions accepted the documented limits of same-user compromise and consent not changing underlying history permissions. Review whether the current implementation remains within that boundary.
- C2: dynamic port allocation for the web dashboard reduces fixed-port relay exposure; it does not prevent an active-port relay. The packaged desktop now uses a static renderer and narrow IPC instead of a dashboard HTTP listener.
- The corrected browser process detector identifies test-owned browser profiles from launch arguments; do not rely on an executable-path-only count. Actual authenticated provider isolation and ACL verification remain unproven by synthetic CI.
- QO-SEC-01 through QO-SEC-06 remain subject to the existing strict integration gate. Review the current implementation, not the old disposition labels.
- Independent human review is not replaced by model-assisted review or green CI.

## Current review scope

Review collector loopback authentication, sender checks and bounded projection in desktop IPC, local filesystem and browser lifecycle, consent generations and configuration transaction lock, bounded parsing, external-provider policy, and packaging/dependency provenance. See the [integration acceptance checkpoint](release/v0.2.0-integration-acceptance.md) for precise evidence and blockers, and the [IPC review package](desktop/ipc-security-review-package.md) for architectural context.

The original October handoff's test counts, proposed merge order and desktop packaging status are superseded by later evidence. No historical PR or branch is deleted by this reconciliation. Do not close #20 until the preserved requirements and current integration tree are accepted.
