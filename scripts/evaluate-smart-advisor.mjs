// Synthetic policy evaluation, not measured provider/session performance.
import { adviseAccounts } from '../lib/smart-advisor.ts';
import { getRecommendedAccount } from '../lib/quota.ts';

const now = Date.parse('2026-11-25T12:00:00Z');
const N = 10_000;
let seed = 0x51554f54;
function next() {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 2 ** 32;
}
const count = { baseline: { selected: 0, belowReserve: 0, failedSnapshot: 0, unsafe: 0 }, advisor: { selected: 0, belowReserve: 0, failedSnapshot: 0, unsafe: 0 }, bothSelected: 0, baselineHeadroom: 0, advisorHeadroom: 0, noEligible: 0 };
const headroom = a => Math.min(...a.windows.map(w => 100 - w.usedPercent));
function measure(key, a, fresh) {
  if (!a) return;
  const c = count[key];
  c.selected++;
  const low = headroom(a) < 15;
  const failed = !fresh.includes(a.id);
  c.belowReserve += Number(low);
  c.failedSnapshot += Number(failed);
  c.unsafe += Number(low || failed);
}
for (let i = 0; i < N; i++) {
  const accounts = Array.from({ length: 5 }, (_, j) => ({
    id: `synthetic-${j}`, label: `Synthetic ${j}`, provider: 'claude', plan: 'Team', source: 'collector',
    updatedAt: new Date(now).toISOString(), windows: [
      { id: 'five-hour', label: '5-hour', usedPercent: Math.floor(next()*101), resetAt: new Date(now+4*3600000).toISOString() },
      { id: 'weekly', label: 'Weekly', usedPercent: Math.floor(next()*101), resetAt: new Date(now+3*86400000).toISOString() },
    ],
  }));
  const fresh = accounts.filter(() => next() >= 0.15).map(a => a.id);
  const old = getRecommendedAccount(accounts, now);
  const modern = adviseAccounts(accounts, { provider: 'claude', task: 'coding', nowMs: now, freshIds: fresh }).recommended?.account ?? null;
  if (!accounts.some(a => fresh.includes(a.id) && headroom(a) >= 15)) count.noEligible++;
  measure('baseline', old, fresh); measure('advisor', modern, fresh);
  if (old && modern) {
    count.bothSelected++;
    count.baselineHeadroom += headroom(old);
    count.advisorHeadroom += headroom(modern);
  }
}
console.log(JSON.stringify({ scenarios: N, accountsPerScenario: 5, seed: '0x51554f54', task: 'coding', reservePercent: 15, failedSnapshotProbability: 0.15, ...count, pairedMeanTightestHeadroom: { baseline: count.baselineHeadroom/count.bothSelected, advisor: count.advisorHeadroom/count.bothSelected } }, null, 2));
