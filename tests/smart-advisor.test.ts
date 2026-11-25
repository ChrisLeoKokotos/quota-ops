import assert from "node:assert/strict";
import test from "node:test";
import { adviseAccounts, recordAdvisorHistory, type AdvisorOptions } from "../lib/smart-advisor.ts";
import { getRecommendedAccount, type QuotaAccount } from "../lib/quota.ts";

const NOW = Date.parse("2026-11-25T12:00:00Z");
const min = 60_000;
function account(id: string, short: number, week: number, extra: Partial<QuotaAccount> = {}): QuotaAccount {
  return { id, label: id, provider: "claude", plan: "Team", source: "collector",
    updatedAt: new Date(NOW).toISOString(), windows: [
      { id: "five-hour", label: "5-hour", usedPercent: short, resetAt: new Date(NOW + 4*60*min).toISOString() },
      { id: "weekly", label: "Weekly", usedPercent: week, resetAt: new Date(NOW + 3*24*60*min).toISOString() },
    ], ...extra };
}
function advise(accounts: QuotaAccount[], extra: Partial<AdvisorOptions> = {}) {
  return adviseAccounts(accounts, { provider: "claude", task: "coding", nowMs: NOW,
    freshIds: accounts.map(a => a.id), ...extra });
}

test("baseline favors a near-exhausted short window; v2 prefers balanced capacity", () => {
  const a = account("A", 94, 0), b = account("B", 40, 40);
  assert.equal(getRecommendedAccount([a,b], NOW)?.id, "A");
  assert.equal(advise([a,b]).recommended?.account.id, "B");
});
test("weekly bottleneck is not hidden by a mostly empty short window", () => {
  const a = account("A", 0, 96), b = account("B", 70, 70);
  assert.equal(advise([a,b]).recommended?.account.id, "B");
});
test("exhaustion and past reset never fabricate available capacity", () => {
  const a = account("A",100,0), b = account("B",0,0);
  b.windows[0]!.resetAt = new Date(NOW-min).toISOString();
  assert.equal(advise([a,b]).recommended,null);
});
test("fresh collector reading must be explicitly present in current snapshot", () => {
  const a = account("A",0,0), b = account("B",30,30);
  assert.equal(getRecommendedAccount([a,b], NOW)?.id,"A");
  assert.equal(advise([a,b],{freshIds:["B"]}).recommended?.account.id,"B");
  assert.equal(advise([a,b],{freshIds:[]}).recommended,null);
});
test("old, invalid and future-dated observations are excluded", () => {
  const a = account("A",0,0,{updatedAt:new Date(NOW-36*min).toISOString()});
  const b = account("B",0,0,{updatedAt:new Date(NOW+min).toISOString()});
  const c = account("C",NaN,0);
  assert.equal(advise([a,b,c]).excluded.length,3);
});
test("manual readings have an explicit age limit and no forecast", () => {
  const a = account("A",20,20,{source:"manual"});
  assert.equal(advise([a],{freshIds:[]}).recommended?.trendKnown,false);
  a.updatedAt=new Date(NOW-25*60*min).toISOString();
  assert.equal(advise([a],{freshIds:[]}).recommended,null);
});
test("task profiles change eligibility without promising session duration", () => {
  const a=account("A",85,85);
  assert.equal(advise([a],{task:"quick"}).recommended?.account.id,"A");
  assert.equal(advise([a],{task:"heavy"}).recommended,null);
});
test("near reset is a hint only and waits for every limiting window", () => {
  const a=account("A",98,96);
  a.windows[0]!.resetAt=new Date(NOW+5*min).toISOString();
  assert.equal(advise([a]).upcomingReset,null);
  a.windows[1]!.resetAt=new Date(NOW+10*min).toISOString();
  assert.equal(advise([a]).upcomingReset?.resetAt,a.windows[1]!.resetAt);
  assert.equal(advise([a]).recommended,null);
});
test("provider scopes never compare different quotas", () => {
  const a=account("A",0,0,{provider:"openai"}), b=account("B",70,70);
  assert.equal(advise([a,b]).recommended?.account.id,"B");
  assert.equal(advise([a,b],{provider:"openai"}).recommended?.account.id,"A");
});
test("hysteresis stabilizes close scores but never retains an ineligible account", () => {
  const a=account("A",20,20), b=account("B",22,22);
  assert.equal(advise([a,b],{previousId:"B"}).recommended?.account.id,"B");
  assert.equal(advise([a,b],{previousId:"B",freshIds:["A"]}).recommended?.account.id,"A");
  assert.equal(advise([a,account("B",60,60)],{previousId:"B"}).recommended?.account.id,"A");
});
test("ties are independent of array order", () => {
  const a=account("A",20,20), b=account("B",20,20);
  assert.equal(advise([b,a]).recommended?.account.id,"A");
  assert.equal(advise([a,b]).recommended?.account.id,"A");
});
test("unknown reset stays unknown except explicit fresh collector zero", () => {
  const a=account("A",0,10);
  a.windows[0]!.resetAt=null;
  assert.equal(advise([a]).recommended?.account.id,"A");
  a.windows[0]!.usedPercent=1;
  assert.equal(advise([a]).recommended,null);
});
test("consumption forecast requires three distinct same-reset observations", () => {
  const a=account("A",40,40), b=account("B",45,45);
  const before=(minutes:number, used:number) => ({...account("A",used,used),updatedAt:new Date(NOW-minutes*min).toISOString()});
  let h=recordAdvisorHistory({},[before(30,0)],NOW);
  h=recordAdvisorHistory(h,[before(15,20)],NOW);
  h=recordAdvisorHistory(h,[a],NOW);
  assert.equal(advise([a,b]).recommended?.account.id,"A");
  const result=advise([a,b],{history:h});
  assert.equal(result.recommended?.account.id,"B");
  assert.equal(result.candidates.find(c=>c.account.id==="A")?.trendKnown,true);
  assert.equal(result.candidates.find(c=>c.account.id==="A")?.projectedRemaining,0);
});
test("duplicate polling, resets and falling usage cannot invent a trend", () => {
  const a=account("A",10,10);
  let h=recordAdvisorHistory({},[a],NOW);
  h=recordAdvisorHistory(h,[a],NOW);
  assert.equal(h.A?.length,1);
  assert.equal(advise([a],{history:h}).recommended?.trendKnown,false);
  const earlier=account("A",90,90,{updatedAt:new Date(NOW-30*min).toISOString()});
  const middle=account("A",80,80,{updatedAt:new Date(NOW-15*min).toISOString()});
  earlier.windows[0]!.resetAt=new Date(NOW-min).toISOString();
  h=recordAdvisorHistory({},[earlier],NOW);
  h=recordAdvisorHistory(h,[middle],NOW);
  h=recordAdvisorHistory(h,[a],NOW);
  assert.equal(advise([a],{history:h}).recommended?.trendKnown,false);
});
test("history drops removed accounts and never keeps email", () => {
  const a=account("A",10,10,{email:"private@example.invalid"});
  const h=recordAdvisorHistory({},[a],NOW);
  assert.equal(h.A?.[0]?.email,undefined);
  assert.deepEqual(Object.keys(recordAdvisorHistory(h,[],NOW)),[]);
});
test("exhaustive integer quota grid: no recommendation below reserve or at limit", () => {
  for (const task of ["quick","coding","heavy"] as const) {
    const reserve={quick:5,coding:15,heavy:25}[task];
    for(let x=0;x<=100;x++) for(let y=0;y<=100;y++) {
      const r=advise([account("A",x,y)],{task});
      assert.equal(!!r.recommended,Math.min(100-x,100-y)>=reserve);
    }
  }
});

test("prototype-like account IDs are ordinary data, not inherited history", () => {
  const a = account("constructor", 10, 10);
  const h = recordAdvisorHistory({}, [a], NOW);
  assert.equal(h.constructor instanceof Array, true);
  assert.equal(advise([a], {history: {}}).recommended?.account.id, "constructor");
});

test("partial rate evidence is disclosed without discarding an observed bottleneck", () => {
  const a=account("A",20,20);
  a.windows[0]!.resetAt=null;
  a.windows[0]!.usedPercent=0;
  const samples=[30,15].map((m,i)=>({ ...a, updatedAt:new Date(NOW-m*min).toISOString(),
    windows:[{...a.windows[0]!},{...a.windows[1]!,usedPercent:i*10}] }));
  const r=advise([a],{history:{A:samples}});
  assert.equal(r.recommended?.trendKnown,false);
  assert.equal(r.recommended?.trendPartial,true);
  assert.equal(r.recommended?.projectedRemaining,40);
});
