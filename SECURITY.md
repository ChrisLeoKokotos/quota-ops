# Security Policy

Security is a core requirement for QuotaOps because the project may interact with local AI tooling, usage information, provider sessions, and authentication-adjacent state.

## Supported versions

Until the first stable release, security fixes are provided for the latest code on the default branch only.

| Version | Supported |
| --- | --- |
| Latest default branch | Yes |
| Older commits / snapshots | No |

## Reporting a vulnerability

**Do not open a public issue for a suspected vulnerability.**

Prefer GitHub Private Vulnerability Reporting when it is enabled for this repository. If it is unavailable, contact the maintainer privately using a verified private contact method from the maintainer's GitHub profile.

Please include, where possible:

- a concise description;
- affected component, version, or commit;
- reproduction steps or proof of concept;
- expected impact;
- suggested mitigation, if known.

Do not send real credentials, tokens, cookies, private keys, or unrelated personal data.

## Credential handling

QuotaOps contributors must never commit or intentionally collect:

- API keys;
- OAuth access or refresh tokens;
- session cookies;
- private keys;
- passwords;
- exported provider authentication state;
- unrelated personal or account data.

Provider credentials should remain on the user's machine and should not be transmitted to QuotaOps-operated infrastructure unless a future feature explicitly documents that behavior and receives a dedicated security review.

## Security design principles

QuotaOps should:

- be local-first where practical;
- minimize privileges and credential access;
- store the minimum data required;
- avoid logging sensitive material;
- fail closed for security-sensitive operations where practical;
- make network activity explicit and auditable;
- avoid undocumented telemetry;
- isolate provider-specific integrations behind clear interfaces.

## Disclosure

Please allow maintainers a reasonable opportunity to investigate and remediate a vulnerability before public disclosure.
