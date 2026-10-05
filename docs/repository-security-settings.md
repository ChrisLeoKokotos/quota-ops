# Repository Security Settings

Some protections cannot be enforced by files committed to the repository and must be enabled in GitHub repository settings.

This document is the source-of-truth checklist for those controls.

## Default branch ruleset

Target: `main`

Recommended rules:

- restrict deletions;
- block force pushes;
- require a pull request before merging;
- require at least one approval;
- dismiss stale approvals when new commits are pushed;
- require review from Code Owners;
- require all review conversations to be resolved;
- require status checks once the security/CI workflows have run successfully at least once.

Maintainer bypass should be limited to the repository owner and used only for emergency recovery.

## Security features

Enable, where available:

- Secret scanning;
- Push protection;
- Private vulnerability reporting;
- Dependency graph;
- Dependabot alerts;
- Dependabot security updates.

## Actions

Recommended repository Actions policy:

- default `GITHUB_TOKEN` permission: read-only;
- allow GitHub Actions required by the project;
- do not send secrets to workflows from forked pull requests;
- require approval for first-time external contributors when that option is available.

The committed workflows intentionally use explicit least-privilege permissions and immutable action SHAs.

## Required checks

After the workflows have completed successfully at least once, add these as required checks on `main`:

- Repository hygiene;
- Dependency review.

Additional build, lint, test, typecheck, and CodeQL checks should become required after the application stack exists.

## Merge strategy

Recommended:

- allow squash merge;
- disable merge commits;
- disable rebase merge unless the project later adopts a different history policy;
- automatically delete merged head branches.

## Review cadence

Review repository access, Actions permissions, installed GitHub Apps, deploy keys, webhooks, environments, and secrets periodically and whenever a maintainer or automation integration changes.
