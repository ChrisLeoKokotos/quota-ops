# Support

QuotaOps is an open-source product created by **SO HOMELY** and maintained on a best-effort basis.

## Where to ask

- **Bug:** use the bug report issue form.
- **Feature or improvement:** use the feature request issue form.
- **Contribution question:** use an appropriate issue or GitHub Discussion if Discussions are enabled.
- **Security vulnerability:** follow [SECURITY.md](SECURITY.md) and do not create a public issue.

## Current product limitations

Before reporting a bug, note that the current MVP:

- is focused on Claude Team;
- supports manual quota entry and an experimental same-PC automatic Claude collector;
- stores dashboard metadata in the current browser profile and collector browser sessions under the protected local QuotaOps directory;
- has no hosted backend or cloud sync;
- requires interactive provider login per isolated account profile before automatic collection;
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
- whether light or dark theme is active for UI issues;
- affected account state without exposing sensitive identifiers;
- whether the account is manual or collector-synced;
- the sanitized result of `npm run collector:setup -- collect <id>` when relevant;
- relevant browser permission state for notification / voice issues;
- sanitized logs;
- steps to reproduce;
- expected and actual behavior.

## Security reminder

Never paste API keys, OAuth tokens, session cookies, passwords, private keys, provider authentication state, local-storage dumps containing sensitive information, or unrelated personal data into issues, discussions, screenshots, or pull requests.

## Service level

There is no guaranteed response time, uptime commitment, or commercial support obligation unless separately agreed in writing.
