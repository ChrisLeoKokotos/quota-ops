# IPC architecture — measured results

**Date:** 19 October 2026
**Branch:** `desktop/architecture-benchmark`
**Decision implemented:** Electron shell, Next.js server removed, UI served as
static assets, collector reached over a narrow IPC bridge.

The 235 MB figure in the architecture benchmark was an estimate. This is the
measurement.

---

## What changed

| | Before (Electron + Next.js server) | After (Electron + IPC) |
|---|---|---|
| Dashboard transport | loopback HTTP, capability-gated | one read-only IPC channel |
| Next.js server process | yes, ~100 MB | **none** |
| Dashboard HTTP listener | yes, OS-allocated port | **none** |
| UI delivery | server-rendered | static export, served from a private `app://` scheme |
| Collector | 127.0.0.1:4317, bearer authenticated | **unchanged** |
| Bearer token location | Next.js server process | Electron main process |
| Renderer's privileged surface | fetch to a local origin | `window.quotaops.getSnapshot()` and nothing else |

## Results — three rounds, whole process tree

| State | Processes | Private memory | CPU | Browser processes |
|---|---|---|---|---|
| **1. Dashboard visible and idle** | 4 | **231.9 MB** | 0.001 % | 0 |
| **2. Minimized to system tray** | 4 | **223.0 MB** | 0 % | 0 |
| **3. Background collection running** | 12 | **453.5 MB** | 0.023 % | 8 |
| **4. Background monitoring paused** | 4 | **216.5 MB** | 0.008 % | 0 |
| Processes surviving shutdown | — | — | — | **0** (all three rounds) |

Raw per-round data: `docs/performance/ipc-states.jsonl`.

The tree includes the shell, its renderers, the collector and any browser the
collector launches. Measuring only the shell would hide exactly the costs
these states exist to expose.

### Against the targets

| Target | Result | Verdict |
|---|---|---|
| Total RAM under 300 MB | 231.9 MB idle, 216.5 MB paused | **Met**, with ~68 MB of headroom |
| Idle CPU under 1 % sustained | ≤0.008 % | **Met**, by three orders of magnitude |
| Zero browser processes while idle | 0 | **Met** |
| No lingering processes after shutdown | 0 | **Met** |

**The 235 MB estimate was accurate.** Measured 231.9 MB.

### Against the alternatives

| Architecture | Idle RAM |
|---|---|
| Electron + Next.js server | 334.8 MB |
| Tauri + Next.js server | 299.0 MB |
| **Electron + IPC (this)** | **231.9 MB** |

Removing the Node server saved **103 MB** — nearly three times what switching
framework to Tauri would have saved (35.8 MB), and it did not require a Rust
toolchain or a rewritten shell. This confirms the benchmark's conclusion that
the architecture, not the framework, was the dominant term.

### State 3 deserves a caveat

460 MB during collection is **not** a regression — it is what browser-based
collection costs. Eight Chrome processes appear while a profile is open and
disappear when it closes, and memory returns to 216 MB afterwards.

It is measured with a **synthetic** browser launch against a QuotaOps-style
profile: no provider login, no credentials. A real authenticated collection
will differ, probably upward, since a logged-in provider page is heavier than
`about:blank`. That figure is part of the outstanding QO-SEC-03 work.

The product implication is unchanged either way: collection must be
**on-demand and short-lived**, not a permanently open browser. The measurement
supports that design rather than challenging it.

---

## Security effect of removing the HTTP hop

This is not only a performance change.

**Removed:**

- The dashboard's HTTP listener. There is no port to reach, so the QO-SEC-01
  loopback peer boundary and the Risk C transparent-relay exposure **do not
  apply to the UI at all** — a relay has nothing to forward to.
- The capability token flow for the dashboard, along with its renewal path.
- The renderer's access to the collector's bearer token. It now lives only in
  the Electron main process.

**Unchanged:**

- The collector still listens on 127.0.0.1:4317 with bearer authentication.
  Risks A and B are unaffected: a process running as the same Windows user can
  still read the token file and call the collector directly.

**Added, and needing review:**

- A custom `app://` scheme serving the static bundle, with a path-traversal
  guard and a fallback to the entry document.
- One IPC channel, `quotaops:snapshot`, read-only, returning either a payload
  or a shaped error. No collector error text is reflected to the renderer.
- A Content-Security-Policy applied by the Electron session rather than by
  Next.js headers, with `connect-src 'none'` — the renderer makes no network
  requests of any kind.

**This is a new transport and it has not been security reviewed.** The
independent human review requested for PR #20 covers the loopback HTTP design.
If this architecture is adopted, the IPC surface needs its own pass. It is a
smaller surface than what it replaces, but smaller is not the same as reviewed.

---

## What is not yet done

1. **Constrained-machine measurement.** Everything here is from one 32-core,
   31 GB developer machine. The owner asked for a low-end Windows 11
   comparison before architecture sign-off; no such device is available in
   this session.
2. **Real authenticated collection in state 3.** Synthetic only.
3. **Static export excludes the API routes by moving them aside at build
   time.** That works and always restores them, but a production desktop build
   should simply not contain them.
4. **The dashboard still assumes a 30-second poll.** On-demand collection,
   per-provider scheduling and pause/resume are Milestone 3 work; what is
   measured here is the architecture, not the final scheduling behaviour.
5. **Tray is minimal.** Open, Quit, click-to-toggle, close-hides. Enough to
   measure state 2 honestly; not the finished UX.

---

## Reproducing

```powershell
node desktop/build-static.mjs
powershell -NoProfile -File .\desktop\measure-states.ps1
```

The static build parks `app/api` aside, exports, and restores it — including
on failure, because leaving the tree mutated would break the web build and
every test that imports those routes.
