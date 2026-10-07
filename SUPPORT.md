# Support

QuotaOps is an open-source product created by **SO HOMELY** and maintained on a best-effort basis.

## Where to ask

- **Bug:** use the bug report issue form.
- **Feature or improvement:** use the feature request issue form.
- **Contribution question:** use an appropriate issue or GitHub Discussion if Discussions are enabled.
- **Security vulnerability:** follow [SECURITY.md](SECURITY.md) and do not create a public issue.

## Current product limitations

Before reporting a bug, note that the current MVP:

- supports Claude and OpenAI / ChatGPT Codex capacity tracking;
- supports manual quota entry and an experimental same-PC multi-provider collector;
- stores non-secret dashboard metadata in the current browser profile;
- stores provider login sessions only inside isolated local provider browser profiles;
- has no hosted backend or cloud sync;
- requires interactive provider login before automatic quota collection;
- reads local Claude Code and Codex session logs for Token Analytics;
- labels token totals as **Locally observed**, not provider billing totals;
- provides reset notifications while QuotaOps is running;
- depends on browser support for voice recognition;
- does not guarantee that voice recognition is processed offline;
- does not provide guaranteed notifications while fully closed.

## What to include

When asking for help, include:

- QuotaOps commit or version;
- operating system;
- Node.js version when relevant;
- browser and browser version;
- affected provider and feature;
- whether the account is manual or collector-synced;
- the sanitized result of `npm run collector:setup -- collect <id>` when relevant;
- the sanitized result of `npm run collector:setup -- tokens` for Token Analytics issues;
- relevant browser permission state for notification / voice issues;
- sanitized logs;
- steps to reproduce;
- expected and actual behavior.

## Security reminder

Never paste API keys, OAuth tokens, session cookies, passwords, private keys, provider authentication state, raw browser profiles, or unrelated personal data into issues, discussions, screenshots, or pull requests.

Token Analytics bug reports should avoid attaching raw session JSONL files unless a maintainer explicitly requests a minimal sanitized fixture.

## Service level

There is no guaranteed response time, uptime commitment, or commercial support obligation unless separately agreed in writing.
