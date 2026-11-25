# Smart Account Advisor v2 (draft)

Baseline: PR #52 / 6f35029, lib/quota.ts. Existing recommendationScore and getRecommendedAccount remain unchanged as the comparison oracle.

The dashboard uses a separate deterministic, local advisor. Choose a provider and task (quick fix, coding session, heavy development). This is decision support only: it never switches accounts, logs in, changes a provider limit or promises access or duration. Provider and plan quota percentages are not absolute token capacities. Google model-group windows are conservatively considered together; model-specific selection is not implemented.

Eligibility requires a recent valid reading (35 minutes for collector, 24 hours for manual), a successful current collector snapshot, no exhausted/expired/invalid windows, and known resets except the existing fresh collector zero-usage exception. Missing data never implies available quota. A candidate must preserve a 5/15/25 percentage-point reserve for quick/coding/heavy tasks in every window. These are initial policy settings, not calibrated guarantees.

Score = 65% of trend-adjusted tightest headroom + 25% of current tightest headroom + 10% of mean current headroom. With three distinct monotonic observations over at least 15 minutes from the same window/reset, estimate the recent linear rate in percentage points/hour and subtract rate × nominal task horizon (15/60/180 minutes). Unknown trends are explicitly marked, not treated as proof of safety. No credit for a future reset. A reset hint requires every limiting window to reset within one hour; confirm via refresh. Retain the previous eligible recommendation within five score points in the same provider/task context; ties use account ID. No account is recommended if none meet the reserve.

History is in-memory only, bounded to twelve samples per current successful account and two hours, discarded at restart. It does not read session logs, account identities or token analytics. No new API, data persistence, account authentication or background activity.

## Reproducible evaluation

Run npm test (tests/smart-advisor.test.ts includes baseline comparisons and 30,603 exhaustive integer quota combinations). Synthetic cases exercise bottlenecks, stale/failed snapshots, exhaustion, reset handling, task eligibility, provider scope, deterministic ties, hysteresis, same-reset trends, missing data and history minimization. These tests evaluate policy invariants, not real-world predictive accuracy. Actual Windows E2E and real session outcomes remain separate acceptance gates. No release or installation is implied by this document.

## Synthetic five-account policy benchmark

Run `node --experimental-strip-types scripts/evaluate-smart-advisor.mjs`. Fixed seed 0x51554f54, 10,000 scenarios, five Claude Team accounts each, integer usage sampled uniformly 0–100 per window, each account independently marked not freshly collected with probability 0.15, coding mode (15-point reserve), no consumption histories or resets due. This is a deliberately synthetic distribution and not a forecast of field reliability. "Unsafe" below means a recommendation that violates the **v2 policy** (reserve or freshness), not a security incident.

| Metric | V1 | V2 |
|---|---:|---:|
| Recommendations | 10000 | 9909 |
| Below reserve | 531 | 0 |
| Failed snapshot selected | 1469 | 0 |
| Either policy violation | 1923 | 0 |
| No recommendation | 0 | 91 |
| Mean tightest headroom on the 9909 paired selections | 58.44% | 60.68% |

All 91 withheld recommendations had no eligible account. The rule-based comparison measures compliance and headroom on generated examples, not actual longer sessions, token savings or improved provider access. Browser E2E assertions are included in the existing Google dashboard scripts (manual and synthetic collector). Actual Windows installer and authenticated E2E still require separate validation.
