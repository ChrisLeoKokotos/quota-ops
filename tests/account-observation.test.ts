import assert from "node:assert/strict";
import test from "node:test";
import { applyAccountEdit } from "../lib/account-observation.ts";
import { adviseAccounts } from "../lib/smart-advisor.ts";
import type { QuotaAccount } from "../lib/quota.ts";
const now=Date.parse("2026-11-25T12:00:00Z");
const current:QuotaAccount={id:"a",label:"A",email:"old@example.invalid",provider:"claude",plan:"Team",source:"collector",updatedAt:new Date(now-36*60_000).toISOString(),
  windows:[{id:"weekly",label:"Weekly",usedPercent:100,resetAt:new Date(now+86_400_000).toISOString()}]};
test("metadata edits cannot replace collector readings, renew freshness or resurrect an exhausted account",()=>{
  const edited:QuotaAccount={...current,label:"Renamed",email:"new@example.invalid",updatedAt:new Date(now).toISOString(),windows:[{...current.windows[0]!,usedPercent:0}]};
  const actual=applyAccountEdit(current,edited);
  assert.equal(actual.label,"Renamed");
  assert.equal(actual.email,"new@example.invalid");
  assert.equal(actual.updatedAt,current.updatedAt);
  assert.deepEqual(actual.windows,current.windows);
  assert.equal(adviseAccounts([actual],{provider:"claude",task:"coding",nowMs:now,freshIds:["a"]}).recommended,null);
  const manual:QuotaAccount={...current,source:"manual"};
  assert.equal(applyAccountEdit(manual,edited),edited);
});
