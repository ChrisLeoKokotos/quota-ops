# Windows desktop architecture — historical decision and current direction

The original architecture proposal in [PR #22](https://github.com/ChrisLeoKokotos/quota-ops/pull/22) at `e0828f0545f3123be3ead3f518bbdb2fb9a6aa69` proposed Electron with a bundled Next.js server. It is retained at that revision as historical design input. This reconciled entry supersedes the proposed server architecture for the packaged app, not its security requirements.

## Current architecture

The desktop candidate uses Electron with a static renderer, narrow authenticated IPC, and a supervised local collector. The separate web development mode retains its local dashboard server. See [architecture benchmark](desktop/architecture-benchmark.md), [IPC architecture](performance/ipc-architecture.md), and [IPC security review](desktop/ipc-security-review-package.md).

Preserve the original product and release requirements: installer and uninstall, no user-managed Node/npm, process teardown, no unrestricted renderer filesystem or process access, deny permissions and arbitrary external navigation, local-first provider profiles, reproducible packaging, artifact integrity and provenance, trusted signing, explicit update policy and clean Windows validation. Updates remain disabled.

The internal unsigned installer and throwaway-signature dry run are evidence, not approval to distribute. Authenticated account and upgrade tests, installer reliability, production signing and independent approval remain outstanding. See the [current integration checkpoint](release/v0.2.0-integration-acceptance.md). PR #22 remains open until post-merge equivalence is verified.
