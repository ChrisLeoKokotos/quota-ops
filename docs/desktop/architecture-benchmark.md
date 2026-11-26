# Desktop architecture benchmark — Electron vs Tauri

**Date:** 19 October 2026
**Branch:** `desktop/architecture-benchmark`
**Status:** both measured. Recommendation below; decision is the owner's.

Per the directive this does not choose from published framework comparisons.
Both options are built as proofs of concept that supervise the **same** real
dashboard server, discover it the **same** way, and load the **same** real
application. What is compared is shell overhead on top of identical work.

---

## Measurement environment

| Item | Value |
|---|---|
| OS | Windows 11 Home 10.0.26200 |
| CPU | 32 logical cores |
| RAM | 31.1 GB |
| Node.js | v22.22.2 |
| WebView2 runtime | 155.0.4283.62 (preinstalled with Windows 11) |
| Electron | 44.9.0 |
| Rust / Tauri | rustc 1.99.1, tauri 2.12.4, MSVC 14.44 |
| Dashboard | Next.js 16.3.8 production build, trusted server, OS-allocated port |

Three runs per shell, interleaved, each from a cleared runtime descriptor.
Raw per-run JSON: `docs/performance/benchmark-raw.jsonl`.

**One machine only.** A constrained Windows 11 target was not available in
this session. These are best-case figures from a fast developer machine; a
low-end device will start slower and may page. That second comparison is
outstanding and should run before the architecture is locked in.

---

## Results

| Metric | Electron | Tauri | Difference |
|---|---|---|---|
| **Idle private memory, whole tree** | **334.8 MB** | **299.0 MB** | Tauri **−35.8 MB (−10.7 %)** |
| Settled memory (after 35 s) | 323.3 MB | 299.5 MB | Tauri −23.8 MB |
| **Startup to dashboard ready** | **523 ms** | **1135 ms** | Electron **2.2× faster** |
| Idle CPU (normalised, 32 cores) | ~0.03 % | ~0.01 % | Both negligible |
| Processes at idle | 5 | 9 | Electron fewer, larger |
| **Shippable binary** | **368.5 MB** | **2.94 MB** | Tauri **125× smaller** |
| Processes surviving a force-kill | **0** | **2** | Electron cleaner — see below |

### Where the memory actually goes

Per-process breakdown of the Tauri tree:

| Process | Memory |
|---|---|
| `quotaops.exe` (the shell itself) | **3.8 MB** |
| `node` (the dashboard server) | **100.7 MB** |
| 6 × `msedgewebview2` (the web runtime) | **191.8 MB** |
| `conhost` | 1.6 MB |

This is the most important number in the benchmark. **The shell is 3.8 MB.**
Electron's equivalent main process is roughly 70 MB. Everything else — the web
runtime and the Node server — is carried identically by both.

So the framework choice is worth about 36 MB. The decision to serve the
dashboard from a full Next.js process over loopback costs about **100 MB**,
in either framework. Picking Tauri to hit a memory target addresses the
smaller of the two terms.

### Against the directive's targets

| Target | Electron | Tauri |
|---|---|---|
| Idle CPU below 1 % sustained | 0.03 % — met | 0.01 % — met |
| Idle RAM ≤ 300 MB | 334.8 MB — **missed by 11.6 %** | 299.0 MB — **met, with 1 MB to spare** |
| Zero browser processes while idle | met | met |
| Responsive startup | 523 ms — met | 1135 ms — met, but slower |
| No surviving processes after shutdown | met | **failed — 2 orphans** |

Tauri meets the memory target by 1 MB. That is not margin. Any feature added
to the dashboard, or a second account rendered, will push it over. Treating
299 MB as "target met" would be reading noise as a result.

---

## The orphan-process finding

Force-killing the Tauri shell leaves the supervised dashboard server running.
Verified directly: before the kill, 1 `quotaops` + 3 `node` + WebView2
children; after, the Node server survives with no parent.

The Electron PoC showed 0 leftovers in the same test.

**This is a property of the proofs of concept, not proof that Tauri leaks.**
Both shells only clean up on their graceful exit path. Electron happened to
survive the force-kill test; Tauri did not. Either way, a production shell on
Windows needs a **job object** so the operating system tears the whole tree
down regardless of how the parent dies. Tauri needs that work sooner and it
has to be written in Rust.

---

## Costs that do not show up in the numbers

| | Electron | Tauri |
|---|---|---|
| Build toolchain | existing Node only | **+ Rust compiler + Visual Studio C++ build tools** |
| Toolchain size | 0 extra | several GB, in every build environment including CI |
| Shell language | JavaScript, same as the codebase | Rust, a language not otherwise used here |
| Reuse of current code | high | shell layer rewritten |
| Supply-chain note | `.npmrc` sets `ignore-scripts=true`, so Electron's postinstall binary download does not run; packaging must fetch and checksum it explicitly | cargo dependencies are a separate audit surface from npm |

Build times observed here: Tauri's release build took ~78 s cold, ~63 s
incremental, against an effectively instant Electron start.

---

## Recommendation

**Electron, and reduce the Node server instead — unless the 300 MB target is
firm, in which case neither option passes honestly and the architecture needs
to change.**

The reasoning:

1. Tauri's measured win is 36 MB. It lands at 299 MB against a 300 MB target
   — a 0.3 % margin, which is not a passing result, it is a coincidence.
2. The shell is 3.8 MB versus ~70 MB. The remaining ~295 MB is the web runtime
   plus the Node dashboard server, and **both frameworks carry both**. No
   choice between them reaches a meaningfully lower number.
3. The real lever is the ~100 MB Node process. Replacing the loopback HTTP hop
   with IPC and serving the UI as static assets would remove most of it — and
   that work is framework-independent, so it can be done under Electron now
   and would still apply if Tauri were adopted later.
4. Electron costs no new toolchain, keeps the shell in the language the
   codebase already uses, and starts 2.2× faster.
5. Tauri's 2.94 MB binary is a genuine advantage for distribution and
   updates. It is the strongest argument on its side, and it matters more if
   auto-updates are planned.

**If the owner prefers Tauri**, the honest framing is: it is chosen for the
125× smaller download and the 3.8 MB shell, not for hitting the memory target
— because at 299 MB it does not meaningfully hit it.

**What would change this recommendation:** a measurement on a constrained
machine where Electron's extra 36 MB and its larger per-process footprint
cause paging, or a decision that download size dominates.

---

## Reproducing

```powershell
# Electron
node node_modules/electron/install.js          # .npmrc blocks the postinstall
powershell -NoProfile -File .\desktop\measure.ps1 -Shell electron

# Tauri
cargo build --release --manifest-path desktop/tauri/Cargo.toml
powershell -NoProfile -File .\desktop\measure.ps1 -Shell tauri
```

### A warning about the harness

Four separate bugs in `desktop/measure.ps1` each made a multi-process shell
look dramatically lighter than it is. They are worth knowing about because
every one of them produced a plausible-looking number:

| Bug | Effect |
|---|---|
| Parent-chain walk only | Missed helpers after the shell re-execs: 1 of 5 Electron processes |
| `Win32_Process.ExecutablePath` empty in this session | Path matching returned nothing |
| `$ErrorActionPreference = "Stop"` with `.Path` on an inaccessible process | Pipeline aborted on the first access-denied process |
| `return ,@(...)` | Double-wrapped the array; caller saw one element |

And one that would have decided the benchmark the wrong way: **path matching
alone misses WebView2 entirely**, because it runs from Program Files. That
undercounted Tauri by ~192 MB and would have reported it at ~107 MB — a
fictitious 3× win. The harness now unions parent-chain descendants with path
matching, which is why Tauri shows 9 processes rather than 2.
