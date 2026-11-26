# QuotaOps — sprint report, 19 October 2026 (second sprint)

---

# Section A — Technical report

## A.1 Repository state

`main` unchanged at `9ab42a9`. Nothing merged.

| PR | Head | Checks | Review | State |
|---|---|---|---|---|
| **#28** CodeQL v4.39.0 | `5941b4f` | 4/4 | `REVIEW_REQUIRED` | **Ready — blocked on an authorized reviewer** |
| **#35** Desktop IPC + benchmark | `902b36d` | 4/4 on `716052f` | — | Draft |
| **#36** Scheduler + tray *(new)* | `6735510` | pending | — | Draft |
| #20 Security | `e7cb2d8` | 4/4 | — | Draft |
| #21 Launcher | `44191c9` | 4/4 | — | Open, contains #20 |
| #19 Ollama | `5aa77bb` | 4/4 | — | Open |
| #22 Desktop architecture | — | — | — | Superseded in direction; close after the implementation lands |
| #30 Node 26 typings | — | — | — | Recommend close — runtime is Node 22 |
| #25, #26, #31, #34 | — | CodeQL failing (expected) | — | Superseded by #28 |
| #12 TypeScript 7, #29, #32, #33 | — | — | — | Validated; merge after #20 |

## A.2 Work completed

### Task A — PR #28 readiness

Re-verified at `5941b4f`: v4.39.0, both steps on `6f2ac81f5cd8…`, 15/15 guard
tests, all four checks green, no unresolved findings.

**Blocker stated precisely:** `mergeStateStatus: BLOCKED`,
`reviewDecision: REVIEW_REQUIRED`. GitHub does not permit self-approval and
the ruleset will not be weakened. This is an operational dependency on a human
with write access.

### Task B — verification reliability

Two false-success paths in my own report script:

| Defect | Fix |
|---|---|
| Test step matched `# fail 0`, checked nothing else | Requires a complete summary, a positive test count, zero failures **and** a zero exit code |
| Absent collector recorded as PASS | Four distinct states: PASS / FAIL / SKIP / INCONCLUSIVE |

A second defect surfaced during the fix: `Get-NetTCPConnection -LocalPort`
throws when nothing matches, making "not running" indistinguishable from
"could not read the sockets". Listeners are enumerated and filtered in-script.

18 fixture cases, mutation-verified — restoring either path fails the suite.
A second test parses every PowerShell script under Windows PowerShell 5.1.

### Task C — human review package

`docs/desktop/ipc-security-review-package.md`. Architecture, IPC
specification, collector authentication and its unauthenticated-peer problem,
asset protocol containment, snapshot schema and bounds, measured CSP, external
navigation policy, accepted residual risks, known test weaknesses.

States plainly that the AI review is not sign-off and that the previous
approval covered a different transport.

### Task D — guided E2E

`docs/qo-sec-03-guided-steps.md`. Five short steps in Greek, each explaining
what it proves and what a wrong result looks like.

### Task E — desktop MVP (#36)

`RefreshScheduler`, outside Electron so a fake clock drives it:

- concurrent calls join the in-flight run (two browsers on one profile is the
  failure this guards)
- exponential backoff to a 30-minute cap
- cancel mid-run discards the result rather than publishing it late
- `stale` reported separately from `lastSuccessAt`
- an error payload counts as a failed collection, not a successful one

Full tray: Open, Refresh now, Pause/Resume, last update with a `(stale)`
marker, Settings, Quit. Labels reflect live state.

## A.3 Security findings

**Fixed this sprint:** two report-script false-success paths.

**Fixed last sprint, verified still in place:** unrestricted `openExternal`
egress, IPC sender fail-open, unsafe static-build recovery, snapshot
passthrough, inconsistent URL validation, NTFS alternate data streams.

**Open:** independent human review of the IPC transport. The AI review found
six confirmed defects including two in my own tests; it is not sign-off.

**Accepted (owner, 15 October):** Risk A same-user process access, Risk B
session-history file permissions, Risk C transparent relay (mitigated).

## A.4 E2E readiness

13 automated checks pass. 7 steps remain MANUAL and the script never reports
them otherwise. Exit code 2 when any check is INCONCLUSIVE.

**Not run:** real authenticated collection. Every browser test is synthetic.

## A.5 Performance

Whole process tree, three rounds, Windows 11 26200, 32 cores, 31.1 GB.

| State | Processes | Memory | CPU |
|---|---|---|---|
| Visible and idle | 4 | **213.3 MB** | 0.012 % |
| Minimized to tray | 4 | **210.2 MB** | 0.008 % |
| Collection running | 12 | 440.8 MB | 0.102 % |
| Monitoring paused | 4 | **207.7 MB** | 0.004 % |
| Surviving shutdown | — | — | **0** |

No regression from the scheduler. Collection remains synthetic.

**Not done:** constrained-hardware measurement. No such machine available.

## A.6 Merge plan

**Can merge now:** #28, on approval.

**Blocked, in order:** #20 (QO-SEC-03 E2E + human review) → #21 → #19 →
dependency upgrades → #35 → #36.

**Close after their replacements land:** #25, #26, #31, #34, #22.
**Recommend closing now:** #30.

---

# Section B — Εξήγηση για τον ιδιοκτήτη

## Τι έγινε αυτό το sprint

Τρία πράγματα: διόρθωσα ένα σοβαρό ελάττωμα στα **ίδια μου τα εργαλεία
ελέγχου**, ετοίμασα τον φάκελο για τον ανθρώπινο ελεγκτή ασφαλείας, και
έφτιαξα το κομμάτι που κάνει την εφαρμογή να δουλεύει μόνη της στο παρασκήνιο.

## Το ελάττωμα που είχα εγώ

Είχα γράψει ένα script που τρέχει τους ελέγχους και βγάζει αναφορά. Είχε δύο
τρόπους να πει «πέρασε» ενώ δεν είχε περάσει τίποτα:

**Πρώτος:** έψαχνε στο κείμενο της εξόδου τη φράση «0 αποτυχίες». Αν το
πρόγραμμα των τεστ κρασάριζε αφού τύπωνε αυτή τη φράση, ή αν δεν έτρεχε
κανένα τεστ, η αναφορά έλεγε «πέρασε».

**Δεύτερος, χειρότερος:** ο έλεγχος «ο collector ακούει μόνο τοπικά» έβγαζε
«πέρασε» όταν ο collector **δεν έτρεχε καθόλου**. Δηλαδή: δεν κοίταξε τίποτα,
και το κατέγραψε ως επιτυχία ασφαλείας.

**Γιατί έχει σημασία:** αυτά τα δύο είναι ακριβώς τα νούμερα που θα
κοιτούσατε για να πείτε «εντάξει, είμαστε καλά». Ένα εργαλείο που λέει
ψέματα με αυτοπεποίθηση είναι χειρότερο από το να μην υπάρχει εργαλείο.

Τώρα υπάρχουν τέσσερις ξεχωριστές απαντήσεις αντί για δύο:

| Απάντηση | Σημασία |
|---|---|
| PASS | Ελέγχθηκε και είναι σωστό |
| FAIL | Ελέγχθηκε και είναι λάθος |
| SKIP | Δεν έτρεξε γιατί έλειπε η προϋπόθεση |
| INCONCLUSIVE | Δεν μπόρεσε να ελεγχθεί |

Τα δύο τελευταία **δεν** σημαίνουν «εντάξει».

## Ο χρονοπρογραμματιστής

Η εφαρμογή πρέπει να ελέγχει τα υπόλοιπά σας κάθε τόσο, μόνη της. Ακούγεται
απλό — «κάνε το κάθε 5 λεπτά» — αλλά τα λάθη είναι συγκεκριμένα:

**Διπλή συλλογή.** Αν μια συλλογή αργήσει και περάσει η ώρα της επόμενης,
ανοίγουν **δύο φυλλομετρητές στο ίδιο προφίλ**. Τώρα η δεύτερη κλήση περιμένει
την πρώτη αντί να ξεκινήσει νέα.

**Επιμονή σε πάροχο που είναι εκτός.** Αν ο πάροχος δεν απαντά, το να
ξαναπροσπαθείς κάθε 5 λεπτά σπαταλά πόρους και μοιάζει με κατάχρηση. Τώρα ο
χρόνος αναμονής διπλασιάζεται σε κάθε αποτυχία, μέχρι μισή ώρα.

**Παύση που δεν σταματά πραγματικά.** Αν πατήσετε «παύση» ενώ τρέχει μια
συλλογή, το αποτέλεσμα **πετιέται** αντί να γραφτεί αργότερα. Αλλιώς θα
φαινόταν σαν να συνέχισε παρά την παύση σας.

**Παλιά δεδομένα που δείχνουν φρέσκα.** Αν δείξω μόνο μια ώρα, θα τη
διαβάσετε ως τωρινή. Τώρα υπάρχει ξεχωριστή ένδειξη «παλιό» δίπλα στην ώρα.

## Τι άλλαξε για εσάς

Το εικονίδιο στο tray έχει τώρα πλήρες μενού: Άνοιγμα, Ανανέωση τώρα,
Παύση/Συνέχιση, τελευταία ενημέρωση με ένδειξη αν είναι παλιά, Ρυθμίσεις,
Έξοδος.

Η μνήμη δεν ανέβηκε: **213 MB** σε αδράνεια, 210 MB στο tray, 208 MB σε
παύση. Ο στόχος ήταν κάτω από 300 MB.

## Τι μπορεί ακόμη να πάει στραβά

1. **Δεν έχει δοκιμαστεί με αληθινό λογαριασμό.** Όλα τα τεστ φυλλομετρητή
   είναι ψεύτικα. Αυτό χρειάζεται εσάς — ο οδηγός είναι στο
   `docs/qo-sec-03-guided-steps.md`, πέντε βήματα, περίπου 40 λεπτά.
2. **Ο νέος κώδικας δεν έχει ελεγχθεί από άνθρωπο ειδικό.** Ο έλεγχος που
   έκανα με άλλο μοντέλο βρήκε έξι πραγματικά ελαττώματα — δύο στα δικά μου
   τεστ — αλλά δεν είναι ανθρώπινη έγκριση.
3. **Οι μετρήσεις είναι από δυνατό μηχάνημα.** Σε πιο αδύναμο θα είναι
   χειρότερες.

## Τι να κρατήσετε

**Ένα τεστ που δεν μπορεί να αποτύχει δεν είναι τεστ.**

Αυτό το sprint βρέθηκαν τρία δικά μου τεστ που περνούσαν πάντα: ένα έλεγχε
«αν γίνει δεκτό, τότε να είναι σωστό» χωρίς να ελέγχει αν γίνεται δεκτό, ένα
κοίταζε μόνο ότι κάτι απέτυχε χωρίς να κοιτάζει γιατί, και η αναφορά έβγαζε
«πέρασε» όταν δεν είχε κοιτάξει τίποτα.

Ο τρόπος να το ελέγξεις λέγεται **mutation testing**: χαλάς επίτηδες τον
κώδικα και βλέπεις αν τα τεστ το πιάνουν. Αν δεν το πιάσουν, το τεστ δεν
φυλάει τίποτα. Το κάνω τώρα σε κάθε έλεγχο ασφαλείας.

## Τι χρειάζομαι από εσάς

1. **Έγκριση του #28.** Όλα πράσινα. Δεν μπορώ να εγκρίνω δικό μου PR και
   δεν θα παρακάμψω τον κανόνα προστασίας.
2. **Η δοκιμή με αναλώσιμο λογαριασμό** — πέντε βήματα, θα σας καθοδηγώ ένα
   τη φορά.
3. **Ανεξάρτητος ανθρώπινος ελεγκτής ασφαλείας** για τον νέο κώδικα IPC.
4. **Ένα πιο αδύναμο μηχάνημα Windows 11** για τη δεύτερη μέτρηση.

Τίποτα δεν έχει γίνει merge. Το `main` παραμένει στο `9ab42a9`.
