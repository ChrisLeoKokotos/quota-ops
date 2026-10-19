# QuotaOps — Milestone report, 19 October 2026

---

# Section A — Technical engineering report

## A.1 What was built

| Item | Path | Branch | Commit |
|---|---|---|---|
| CodeQL coordinated upgrade retargeted to v4.39.0 | `.github/workflows/codeql.yml` | `ci/codeql-coordinated-upgrade` | `5941b4f` |
| Electron proof of concept | `desktop/electron/` | `desktop/architecture-benchmark` | `16acdd6` |
| Tauri proof of concept | `desktop/tauri/` | `desktop/architecture-benchmark` | `634075f` |
| Measurement harness | `desktop/measure.ps1` | `desktop/architecture-benchmark` | `634075f` |
| Architecture benchmark | `docs/desktop/architecture-benchmark.md` | `desktop/architecture-benchmark` | `634075f` |
| **IPC architecture — static UI, no Next.js server** | `desktop/electron-ipc/`, `lib/collector-transport.ts` | `desktop/architecture-benchmark` | `dfba1bb` |
| Static export build | `desktop/build-static.mjs`, `next.config.ts` | `desktop/architecture-benchmark` | `dfba1bb` |
| State measurement harness | `desktop/measure-states.ps1` | `desktop/architecture-benchmark` | `dfba1bb` |
| IPC results | `docs/performance/ipc-architecture.md` | `desktop/architecture-benchmark` | `dfba1bb` |

## A.2 Architecture benchmark — measured

Three interleaved runs per shell. Both proofs of concept supervise the same
real dashboard server and load the same real application.

| Metric | Electron | Tauri |
|---|---|---|
| Idle private memory | 334.8 MB | 299.0 MB |
| Startup to ready | 523 ms | 1135 ms |
| Processes at idle | 5 | 9 |
| Shippable binary | 368.5 MB | 2.94 MB |
| Surviving a force-kill | 0 | 2 |

Per-process breakdown decided it: the Tauri shell is **3.8 MB**, Electron's
equivalent ~70 MB, and the remaining ~295 MB is WebView2/Chromium plus the
Node dashboard server — **carried identically by both**. The framework was
worth 36 MB; the Next.js server cost 100 MB.

## A.3 IPC architecture — measured

Owner direction: Electron, remove the Node server, prove it first.

| State | Processes | Memory | CPU | Browsers |
|---|---|---|---|---|
| 1. Visible and idle | 4 | **231.9 MB** | 0.001 % | 0 |
| 2. Minimized to tray | 4 | **223.0 MB** | 0 % | 0 |
| 3. Collection running | 12 | 453.5 MB | 0.023 % | 8 |
| 4. Monitoring paused | 4 | **216.5 MB** | 0.008 % | 0 |
| Surviving shutdown | — | — | — | 0, all rounds |

**Estimate was 235 MB; measured 231.9 MB.** Removing the server saved 103 MB —
nearly 3× the Tauri switch, with no new toolchain.

State 3's 460 MB is the cost of browser-based collection, transient, and
**synthetic** (no provider login). A real authenticated collection will
likely be heavier.

## A.4 Test results

| Check | Result |
|---|---|
| `npm run typecheck` | PASS |
| `npm test` | PASS — 114 tests |
| `npm run build` (web) | PASS |
| `node desktop/build-static.mjs` | PASS — 697 KB export |
| Hosted CI, `ci/codeql-coordinated-upgrade@5941b4f` | 4/4 PASS including CodeQL |

Dependency PRs validated against the integrated tree
(`feat/windows-one-click-launcher@44191c9`, which contains PR #20): React
19.3.1, Playwright 1.64.1 and Next 16.4.2 applied **together** — typecheck,
114 tests, build, Windows security smoke (7 refusals), browser smoke and the
lifecycle detector all pass.

## A.5 Findings worth recording

**The benchmark harness nearly reported the wrong winner.** Path-based process
matching misses WebView2 entirely — it runs from Program Files. That
undercounted Tauri by ~192 MB and would have shown it at ~107 MB, a fictitious
3× win. Four other harness bugs each made a multi-process shell look lighter.
All are documented in the benchmark rather than quietly fixed.

**Force-killing the Tauri PoC orphans the dashboard server.** Electron's did
not in the same test. A property of the PoCs, not proof that Tauri leaks —
both only clean up on the graceful path. Production needs a Windows job object
either way.

**`.npmrc` sets `ignore-scripts=true`**, so Electron's postinstall binary
download does not run. Packaging must fetch and checksum it explicitly.

**`ELECTRON_RUN_AS_NODE` is exported in some parent environments** and makes
the shell start as a bare Node process.

## A.6 PR dispositions

| PR | Status | Action |
|---|---|---|
| #12 TypeScript 7 | behind, compatible | rebase after #20 |
| #19 Ollama | 4/4 green, threads resolved | merge after #20, #21 |
| #20 Security | Draft, 4/4 green on `e7cb2d8` | QO-SEC-03 E2E + human review |
| #21 Launcher | 4/4 green on `44191c9`, contains #20 | merge after #20 |
| #22 Desktop architecture | superseded in substance by #35 | close or merge as a document |
| #27 setup-node | verified | merge |
| #28 CodeQL | **4/4 green at v4.39.0** | **ready — approval only** |
| #29 React 19.3.1 | validated on integrated tree | merge after #20 |
| #30 Node 26 typings | clean but recommend close | typings should track the Node 22 runtime |
| #31, #34 CodeQL | superseded by #28 | close when #28 merges |
| #32 Playwright 1.64.1 | validated incl. real browser launch | merge after #20 |
| #33 Next 16.4.2 | validated; must carry 2 generated files | merge after #20 |
| #35 Desktop benchmark + IPC | Draft | decision input |

## A.7 Blockers

1. **QO-SEC-03 authenticated Windows E2E** — owner-operated, disposable account.
2. **Independent human security review** — covers PR #20's HTTP design; the new IPC transport needs its own pass.
3. **Constrained Windows 11 measurement** — required before architecture sign-off. Not available in this session.
4. **Approval on every PR** — all `BLOCKED` under the "Protect main" ruleset. Nothing merged; `main` is at `9ab42a9`.

---

# Section B — Εξήγηση για τον ιδιοκτήτη

## Τι φτιάξαμε αυτή τη φορά

Δοκιμάσαμε **δύο διαφορετικούς τρόπους** να γίνει το QuotaOps κανονική
εφαρμογή των Windows, τους μετρήσαμε, και μετά βρήκαμε έναν **τρίτο τρόπο που
ήταν καλύτερος και από τους δύο**.

## Γιατί χρειαζόταν

Ζητήσατε η εφαρμογή να είναι ελαφριά — να μην τρώει μνήμη και επεξεργαστή όταν
απλώς κάθεται ανοιχτή στο παρασκήνιο. Βάλατε στόχο **κάτω από 300 MB μνήμης**.

Για να διαλέξουμε σωστά, δεν αρκούσε να διαβάσουμε τι λένε οι κατασκευαστές.
Έπρεπε να φτιάξουμε και τις δύο εκδοχές και να τις μετρήσουμε στο ίδιο
μηχάνημα, με την ίδια εφαρμογή.

## Πώς δουλεύει, με απλά λόγια

Μέχρι τώρα το QuotaOps δούλευε έτσι:

1. Ένας **διακομιστής** (server) έτρεχε στον υπολογιστή σας.
2. Το παράθυρο της εφαρμογής ήταν στην ουσία ένας φυλλομετρητής που μιλούσε
   σε αυτόν τον διακομιστή μέσω δικτύου — αλλά δικτύου *μέσα* στον ίδιο
   υπολογιστή.

**Τι είναι ο διακομιστής (server):** ένα πρόγραμμα που περιμένει ερωτήσεις και
απαντά. Σαν υπάλληλος σε γκισέ. Ακόμη κι αν είναι στο ίδιο κτίριο με εσάς,
πρέπει να πάτε στο γκισέ και να ρωτήσετε.

Το πρόβλημα: **αυτός ο υπάλληλος έτρωγε 100 MB μνήμης από μόνος του.**

Η νέα λύση: **πετάξαμε το γκισέ**. Τώρα το παράθυρο μιλάει απευθείας στον
πυρήνα της εφαρμογής μέσω ενός εσωτερικού αγωγού.

**Τι είναι το IPC:** σημαίνει «επικοινωνία μεταξύ διεργασιών»
(Inter-Process Communication). Αντί για γκισέ, είναι σαν **ένας σωλήνας
μεταξύ δύο δωματίων στο ίδιο σπίτι**. Δεν βγαίνει τίποτα έξω, δεν χρειάζεται
πόρτα προς τον δρόμο.

## Τι άλλαξε για εσάς

| | Πριν | Τώρα |
|---|---|---|
| Μνήμη σε αδράνεια | 335 MB | **232 MB** |
| Στο tray (κλειστό παράθυρο) | — | **223 MB** |
| Επεξεργαστής σε αδράνεια | σχεδόν μηδέν | σχεδόν μηδέν |
| Διεργασίες που μένουν μετά το κλείσιμο | 0 | **0** |

Ο στόχος των 300 MB **επιτεύχθηκε, με περιθώριο ~68 MB**.

Προσοχή σε ένα νούμερο: **όταν τρέχει συλλογή δεδομένων**, η μνήμη ανεβαίνει
στα ~460 MB. Αυτό **δεν είναι σφάλμα**. Όταν η εφαρμογή ανοίγει φυλλομετρητή
για να διαβάσει τα υπόλοιπά σας από τον πάροχο, αυτός ο φυλλομετρητής κοστίζει
μνήμη. Μόλις κλείσει, η μνήμη επιστρέφει στα 216 MB. Γι' αυτό ο σχεδιασμός
λέει: **η συλλογή να γίνεται όποτε χρειάζεται και να τελειώνει**, όχι να μένει
ανοιχτή μόνιμα.

## Κάτι σημαντικό για την ασφάλεια

Η αλλαγή αυτή **βελτίωσε** και την ασφάλεια, χωρίς να το επιδιώκουμε.

Θυμάστε τον κίνδυνο C — ότι κάποιος μπορούσε να στήσει έναν «αναμεταδότη» και
να φτάσει στον πίνακα ελέγχου από άλλο μηχάνημα; **Αυτός ο κίνδυνος
εξαφανίστηκε για το παράθυρο**, γιατί δεν υπάρχει πια πόρτα δικτύου να
αναμεταδώσει κανείς. Δεν υπάρχει γκισέ.

Επίσης, **ο μυστικός κωδικός του συλλέκτη δεν φτάνει πια στο παράθυρο**. Μένει
στον πυρήνα της εφαρμογής.

**Όμως — και αυτό είναι σημαντικό:** ο νέος αυτός «σωλήνας» είναι καινούργιος
κώδικας που **δεν έχει ελεγχθεί από ειδικό ασφαλείας**. Μικρότερη επιφάνεια
επίθεσης δεν σημαίνει ελεγμένη επιφάνεια. Πρέπει να περάσει δικό του έλεγχο.

## Τι θα μπορούσε να πάει στραβά

1. **Μετρήσαμε σε δυνατό μηχάνημα.** 32 πυρήνες, 31 GB RAM. Σε πιο αδύναμο
   υπολογιστή τα νούμερα θα είναι χειρότερα. Το ζητήσατε και συμφωνώ — πρέπει
   να μετρηθεί σε αργό μηχάνημα πριν κλειδώσουμε την αρχιτεκτονική.
2. **Η συλλογή με πραγματικό λογαριασμό δεν έχει δοκιμαστεί.** Οι μετρήσεις
   έγιναν με «ψεύτικο» φυλλομετρητή χωρίς σύνδεση. Η αληθινή σύνδεση θα είναι
   πιο βαριά.
3. **Το εργαλείο μέτρησης παραλίγο να μας πει λάθος απάντηση.** Είχε πέντε
   σφάλματα, και το ένα έκρυβε 192 MB από τη μία επιλογή. Αν δεν το είχα
   εντοπίσει, θα είχαμε διαλέξει με βάση ψεύτικο νούμερο. Τα κατέγραψα όλα
   αντί να τα διορθώσω στα κρυφά.

## Τι να κρατήσετε ως γνώση

**Η αρχιτεκτονική μετράει περισσότερο από το εργαλείο.**

Είχαμε δύο επιλογές εργαλείου (Electron και Tauri) που διέφεραν κατά 36 MB.
Αλλά η *δομή* — το αν υπάρχει γκισέ ή σωλήνας — διέφερε κατά 103 MB.

Δηλαδή: **το πώς στήνεις κάτι μετράει σχεδόν τρεις φορές περισσότερο από το με
τι το στήνεις.** Αυτό ισχύει σχεδόν παντού στη μηχανική.

Αν είχαμε ακολουθήσει το προφανές («το Tauri είναι πιο ελαφρύ, πάμε Tauri»),
θα είχαμε πληρώσει νέα γλώσσα προγραμματισμού, νέα εργαλεία, πιο αργή
εκκίνηση — και θα καταλήγαμε στα 299 MB αντί για 232 MB.

## Τι χρειάζεται από εσάς

1. **Έγκριση του #28** (CodeQL). Όλοι οι έλεγχοι πράσινοι. Ξεμπλοκάρει τα
   υπόλοιπα.
2. **Η δοκιμή QO-SEC-03** με αναλώσιμο λογαριασμό — ~45 λεπτά.
3. **Ανεξάρτητος ανθρώπινος έλεγχος ασφαλείας.**
4. **Ένα πιο αδύναμο μηχάνημα Windows 11** για τη δεύτερη μέτρηση.

Τίποτα δεν έχει γίνει merge. Ο κλάδος `main` παραμένει στο `9ab42a9`.
