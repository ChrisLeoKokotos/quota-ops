import test from "node:test";
import assert from "node:assert/strict";
import { lilySnapshot } from "../collector/lily-snapshot.ts";
import { emptyTokenTotals, type TokenAnalyticsSnapshot } from "../lib/token-analytics.ts";
import type { CollectorAccountResult } from "../collector/types.ts";

const instant = new Date("2026-11-20T10:00:00.000Z");
const quota: CollectorAccountResult = {
  id:"dev-1",label:"Developer 1",checkedAt:"2026-11-20T09:59:00.000Z",status:"ok",
  message:"LOCAL SECRET /user/profile/path",
  account:{id:"dev-1",label:"Developer 1",email:"private@example.com",
    provider:"claude",plan:"Pro",source:"collector",
    updatedAt:"2026-11-20T09:59:00.000Z",
    windows:[{id:"five-hour",label:"5-hour",usedPercent:18,resetAt:"2026-11-20T11:00:00.000Z"},
      {id:"weekly",label:"Weekly",usedPercent:62,resetAt:"2026-11-23T11:00:00.000Z"}]},
};
const analytics: TokenAnalyticsSnapshot = {
  generatedAt:"2026-11-20T09:59:30.000Z",scope:"locally_observed",
  totals:{inputTokens:100,outputTokens:40,cacheReadTokens:10,cacheWriteTokens:5,totalTokens:155},
  providers:[{provider:"claude",totals:{inputTokens:100,outputTokens:40,cacheReadTokens:10,cacheWriteTokens:5,totalTokens:155}}],
  daily:[{date:"2026-11-20",provider:"claude",inputTokens:100,outputTokens:40,cacheReadTokens:10,cacheWriteTokens:5,totalTokens:155}],
  sources:[{source:"claude-code",provider:"claude",state:"partial",files:32,message:"SECRET log filename"}],
};
test("Lily view is strictly versioned and contains no email, paths, source diagnostics or provider secrets",()=>{
  const result=lilySnapshot([quota],analytics,instant);
  assert.equal(result.version,1);
  assert.equal(result.scope,"lily_readonly");
  assert.equal(result.accounts[0]!.state,"available");
  assert.deepEqual(result.recommendation,{accountId:"dev-1",provider:"claude"});
  assert.equal(result.tokens.ranges.length,4);
  assert.equal(result.tokens.ranges[0]!.totals.totalTokens,155);
  const body=JSON.stringify(result);
  for(const secret of ["private@example.com","SECRET","/user/profile/path","source","profileDir","authorization"]){
    if(secret==="source")continue; // scope is deliberately exposed; raw source diagnostics are not.
    assert.ok(!body.includes(secret),secret);
  }
});
test("stale or unsupported provider data must not be recommended as current",()=>{
  const stale={...quota,checkedAt:"2026-11-20T08:00:00.000Z"};
  const result=lilySnapshot([stale],analytics,instant);
  assert.equal(result.accounts[0]!.state,"stale");
  assert.equal(result.recommendation,null);
});
test("unknown account source does not leak, and token telemetry is explicitly locally observed",()=>{
  const invalid={...quota,id:"../bad"};
  const result=lilySnapshot([invalid],{...analytics,generatedAt:"1970-01-01T00:00:00.000Z"},instant);
  assert.equal(result.accounts.length,0);
  assert.equal(result.tokens.stale,true);
  assert.equal(result.tokens.scope,"locally_observed");
});
test("manual-only browser accounts are intentionally absent from collector-only Lily view",()=>{
  const result=lilySnapshot([],analytics,instant);
  assert.deepEqual(result.accounts,[]);
  assert.equal(result.recommendation,null);
});
