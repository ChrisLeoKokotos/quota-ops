# Repository Security Settings

QuotaOps is a product created by **SO HOMELY**.

Some protections cannot be enforced by committed files and must be configured in GitHub repository settings.

This file documents the current repository security baseline and the controls that should remain in place.

## Default branch ruleset

Target: `main`

Configured protections include:

- restrict deletions;
- block force pushes;
- require a pull request before merging;
- require at least one approval;
- dismiss stale approvals when new commits are pushed;
- require Code Owner review;
- require review conversations to be resolved;
- require branches to be up to date before merging;
- require status checks;
- require linear history;
- allow squash as the merge method in the ruleset.

Repository-admin bypass is limited to pull-request use and should be reserved for recovery or exceptional maintenance rather than routine direct pushes.

## Required status checks

The branch ruleset currently requires:

- **Repository hygiene**
- **Dependency review**

The repository also has an **App validation** CI workflow that runs on pull requests and performs:

- dependency installation;
- TypeScript typecheck;
- unit tests;
- production build.

App validation should be added to the required-status-check list when the repository ruleset is next updated so the branch rule reflects the application CI that already runs on pull requests.

## Security features

Configured repository security features include:

- Secret Protection;
- Push Protection;
- Private vulnerability reporting;
- Dependency graph;
- Dependabot alerts;
- Dependabot security updates;
- grouped security updates;
- malware alerts.

CodeQL is intentionally deferred until the scanning configuration is introduced and reviewed for the application stack.

## GitHub Actions

The repository Actions policy is intentionally restrictive:

- default `GITHUB_TOKEN` permissions are read-only;
- GitHub-created actions needed by the project are allowed;
- Actions are required to be pinned to full commit SHAs;
- workflows from external contributors require approval;
- GitHub Actions cannot create or approve pull requests under the current policy.

Committed workflows use least-privilege permissions and immutable Action SHAs.

## Merge strategy

Project history is intended to remain linear and PR-based.

Preferred behavior:

- squash merge;
- no routine direct pushes to `main`;
- no force pushes;
- no branch deletion of protected refs;
- delete merged feature branches when practical.

## Dependency maintenance

GitHub Actions dependencies are managed through Dependabot.

When npm dependency automation is expanded, it should preserve the same review, CI, and dependency-review requirements.

## Review cadence

Periodically review:

- repository collaborators and roles;
- GitHub Apps;
- Actions policy;
- deploy keys;
- webhooks;
- environments;
- repository secrets and variables;
- rulesets;
- required status checks;
- security alerts.

Review again whenever a maintainer, automation integration, release process, or provider integration changes.
