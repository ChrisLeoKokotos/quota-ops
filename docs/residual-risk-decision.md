# Residual risk — decision required from the owner

**Status:** awaiting owner decision. Nothing here is accepted.
**Blocks:** PR #20 leaving Draft.
**Context:** `docs/security-closure-2026-10-15.md`

Two residual risks survive the QO-SEC-01 and QO-SEC-02 work. Both are real,
both are documented, and neither can be accepted by the implementer on the
owner's behalf. This document states each risk, what the current code does and
does not do about it, and the options with their actual costs — so the decision
is made with the trade-off visible rather than by signing off a summary.

---

## Risk A — A local process running as the same Windows user

### What the risk is

The dashboard listens on `127.0.0.1:3000`. The collector listens on
`127.0.0.1:4317`. Any process running under the same Windows account can:

- call `GET /api/collector/capability`, receive a valid capability, and then
  read a full snapshot — account labels, quota percentages, reset times and
  token-usage metadata;
- read `%USERPROFILE%\.quotaops\collector.token` and call the collector
  directly;
- read the browser profiles under `%USERPROFILE%\.quotaops\browser-profiles`,
  which hold live provider sessions.

That last one is the serious item. A snapshot is metadata; a browser profile is
an authenticated session.

### What the current design does

It bounds **network** exposure, and does so properly:

- the listener binds `127.0.0.1` and the host is not configurable;
- non-loopback TCP peers are dropped before Next.js sees the connection;
- proxied requests are refused;
- the collector requires a bearer token;
- `%USERPROFILE%\.quotaops` has inheritance removed and is granted only to the
  user, SYSTEM and Administrators.

### What it does not do

None of that is a defence against code already running as you. The ACLs grant
your account full control, which is exactly what an attacker running as your
account has. This is a property of the deployment model, not a bug in the
implementation.

### Options

**A1 — Accept for the local-only release.** *(This is the conventional choice
for a local-first desktop tool.)*

The threat model becomes: QuotaOps protects your data from the network and from
other users of the machine, not from malware already running as you. Any tool
with access to your browser profiles — including your browser itself — has the
same exposure.

- Cost: none.
- What you give up: nothing you currently have.
- What must happen: say so explicitly, and `PRIVACY.md` / `SECURITY.md` state
  it in plain language so a user is not misled about what "local-first" protects.

**A2 — Run the collector under a separate, restricted Windows account.**

A dedicated low-privilege service account owns the browser profiles and the
token. Your normal account cannot read them; neither can malware running as you.

- Cost: substantial. Service account provisioning, a logon-type decision,
  profile migration, an IPC path from your session to the service, and a much
  more complicated installer. Interactive provider login becomes awkward —
  someone must log in as that account, or you need a brokered login flow.
- Benefit: genuinely closes the risk.
- Honest assessment: this is a different product shape, not a hardening pass.
  It is unlikely to be the right call before the desktop edition exists.

**A3 — Reduce the exposed surface without changing the account model.**

Partial measures, each small:

- bind the dashboard to an ephemeral port chosen per launch rather than a fixed
  3000, so a process has to look for it rather than know it;
- DPAPI-encrypt the collector token so reading the file is not sufficient;
- in the desktop edition, drop the HTTP hop entirely and use Electron IPC.

- Cost: low to moderate. The IPC change is real work but is already implied by
  the desktop architecture.
- Benefit: raises cost for an opportunistic attacker. Does **not** close the
  risk — a process running as you can still enumerate ports and call DPAPI.
- Honest assessment: worth doing in the desktop edition for the IPC reason
  anyway. Do not treat it as closing Risk A.

### Recommendation

**A1 for this release, with A3's IPC element folded into the desktop design.**
A2 is disproportionate for a local-first tool at this stage. But this is your
call, and the recommendation is not the decision.

---

## Risk B — Session-history files readable by anything running as you

### What the risk is

`~/.claude/projects` and `~/.codex/sessions` contain prompts, model responses
and source code. Per-source consent controls whether **QuotaOps** reads them. It
has no effect on anything else running under your account — another application,
a compromised npm dependency in any project, or malware can read those files
whether or not QuotaOps is installed or consented.

### What the current design does

- Scanning is off by default, per source, and migration preserves that.
- A source you have not consented to is reported `disabled`, never `not_found` —
  QuotaOps does not claim to have looked.
- Only numeric aggregates leave the parser. Tests assert that a snapshot carries
  no file path, no `.jsonl` reference and no history text.
- Diagnostics report counts and budgets, never record content.
- The scanner runs in the collector process, under your account.

### What it does not do

It does not isolate the scanner, and it does not reduce the filesystem
permissions of the files themselves — QuotaOps did not create them and does not
own them.

### Options

**B1 — Accept, and be precise in the documentation.**

Consent is a QuotaOps behaviour control, not an OS boundary. The documentation
must not imply otherwise.

- Cost: none.
- What must happen: `PRIVACY.md` states plainly that enabling a source lets
  QuotaOps read files that are already readable by everything running as you,
  and that disabling it does not protect those files from anything else.

**B2 — Isolate the scanner in a restricted child process.**

Spawn the JSONL scanner as a separate process with a reduced token, able to read
only the two history roots, returning aggregates over a pipe.

- Cost: moderate. Windows restricted-token work, a process supervisor, a new IPC
  surface to review, and the scanner becomes harder to test.
- Benefit: limits the blast radius **of a compromised dependency inside
  QuotaOps** — a malicious package in the collector could no longer read
  arbitrary files through the scanner path.
- Honest limit: it does nothing about malware outside QuotaOps, which is the
  larger share of this risk.

**B3 — Do not read session histories at all.**

Drop Token Analytics.

- Cost: removes a feature.
- Benefit: QuotaOps stops being a reason these files are opened.
- Honest assessment: a real option if the feature is not earning its risk, but
  the feature is currently off by default, so the marginal risk it adds today
  is small.

### Recommendation

**B1, with B2 reconsidered if the dependency surface grows.** The dependency
tree is four production packages today, which is what makes B1 defensible. If
that changes substantially, B2 becomes worth its cost.

---

---

## Risk C — A transparent loopback relay defeats the peer check

**Found by the independent review. Rated HIGH. This one is not a judgement
call about threat model — it is a gap between what the code claims and what it
does.**

### What the risk is

The QO-SEC-01 boundary asks one question: did this TCP connection come from
`127.0.0.0/8`? Anything that relays a remote connection from loopback answers
yes on the attacker's behalf:

```
netsh interface portproxy add v4tov4 listenport=8080 connectaddress=127.0.0.1 connectport=3000
```

or an nginx `location / { proxy_pass http://127.0.0.1:3000; }` with no
`proxy_set_header` lines, or `ssh -R`, `socat`, a Docker port mapping, or a VS
Code / ngrok tunnel.

**None of those add an `X-Forwarded-*` header by default.** So the sequence is:

1. peer is `127.0.0.1` — passes;
2. no forwarding headers — passes;
3. the server stamps its real trusted marker;
4. `Host: 127.0.0.1:3000` is what the relay sends — passes;
5. no `Origin` header, so the same-origin check is skipped entirely;
6. `GET /api/collector/capability` returns a valid ten-minute capability;
7. replay it to `/api/collector/snapshot` and read the full snapshot.

No header forgery is needed at any step.

### Why the current wording is wrong

`docs/security-architecture.md` already places reverse-proxy forwarding outside
the supported boundary, which is the right call. But the code and the tests
claimed an *enforced* control — "refuses proxied requests before Next.js sees
them" — that does not hold for the default configuration of the most likely
relays. That wording is now corrected in `lib/dashboard-boundary.ts`,
`lib/dashboard-authorization.ts` and the boundary tests: the check catches a
proxy that identifies itself, and is hygiene rather than a boundary.

There is no header-based fix. A transparent relay is indistinguishable from a
local client at the HTTP layer.

### Options

**C1 — Accept and document.** Interposing a relay is a deliberate local
configuration change by someone who can already run code as you (Risk A). The
documented boundary stands; only the overclaim was wrong, and that is fixed.

- Cost: none.
- What you give up: nothing you currently have.
- Honest limit: it also covers the *accidental* case — a tunnel left running,
  a Docker mapping, a VS Code port-forward someone enabled for another service
  — where no attacker had to do anything deliberate at all. That case is not
  rare, and "the user misconfigured it" is a weak answer to it.

**C2 — Bind an ephemeral port per launch.** The dashboard picks a free port at
startup instead of 3000, and the launcher and desktop shell open the right URL.
A relay configured ahead of time points at 3000 and finds nothing.

- Cost: moderate. `scripts/launcher-readiness.ts` and the BAT must discover the
  port (a small file in `~/.quotaops` would do it); a bookmark to
  `127.0.0.1:3000` stops working; the desktop shell needs the same discovery.
- Benefit: closes the accidental and pre-configured cases, which are the
  realistic ones.
- Honest limit: does **not** stop an attacker who can observe the live port and
  then set up a relay. That attacker is already running code as you.

**C3 — Serve under a per-launch secret path.** `http://127.0.0.1:3000/<random>/`.
A relay forwards whatever path is requested, so an attacker hitting `/` gets
nothing, and they cannot guess the prefix.

- Cost: high. Next's `basePath` is static configuration, not per-launch, so
  this means a rewrite layer in the trusted server and touching every internal
  URL.
- Benefit: strictly stronger than C2 — it survives an attacker who knows the port.
- Honest assessment: probably not worth it before the desktop edition, where
  the HTTP hop may disappear entirely in favour of IPC.

### Recommendation

**C2.** It closes the realistic cases at a cost that is mostly one-off
integration work, and it composes with the desktop IPC direction rather than
fighting it. C1 alone leaves the accidental-tunnel case open, and I do not
think "the user shouldn't have done that" carries it.

This is still your decision — C2 does break a bookmarked
`http://127.0.0.1:3000`, and that is a real usability cost you may weigh
differently.

---

## What I need from you

Reply on PR #20 with a decision for each, in this form:

```
Risk A: A1 (accept) | A2 (separate account) | A3 (reduce surface) | other
Risk B: B1 (accept) | B2 (isolate scanner) | B3 (drop the feature) | other
Risk C: C1 (accept) | C2 (ephemeral port) | C3 (secret path) | other
```

If you accept, I will record the acceptance against commit `0691acc` in
`docs/security-closure-2026-10-15.md`, with your decision and the date, and
update `PRIVACY.md` and `SECURITY.md` so the published wording matches what the
code actually protects.

If you choose a mitigation instead, that work lands before PR #20 leaves Draft.

**Accepting these risks is not a formality.** A1 and B1 both narrow what
QuotaOps claims to protect against. That claim ends up in `PRIVACY.md`, which
users read. It should be one you are willing to stand behind.
