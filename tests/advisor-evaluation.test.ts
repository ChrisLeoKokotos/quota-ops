import assert from "node:assert/strict";
import test from "node:test";
import { evaluateAdvisorObservations, type AdvisorObservation } from "../lib/advisor-evaluation.ts";
import type { QuotaAccount } from "../lib/quota.ts";
const start = Date.parse("2026-11-25T00:00:00Z");
const minute = 60_000;
function frame(step: number, used: number, reset = start + 5*3600000): AdvisorObservation {
  const at = start + step*15*minute;
  const a: QuotaAccount = {id:"local-test",label:"private-label",provider:"claude",plan:"Team",source:"collector",
    updatedAt:new Date(at).toISOString(),windows:[
      {id:"five-hour",label:"5h",usedPercent:used,resetAt:new Date(reset).toISOString()},
      {id:"weekly",label:"Weekly",usedPercent:used,resetAt:new Date(start+7*86400000).toISOString()},
    ]};
  return { capturedAt:at,accounts:[a] };
}
test("chronological held-out linear usage forecasts beat persistence without future leakage", () => {
  const result = evaluateAdvisorObservations([0,1,2,3,4,5].map(i=>frame(i, i*10)), "quick");
  assert.equal(result.forecastsIssued,4);
  assert.equal(result.matchedOutcomes,3);
  assert.equal(result.forecastMAE,0);
  assert.equal(result.persistenceMAE,10);
  assert.doesNotMatch(JSON.stringify(result), /local-test|private-label/);
});
test("a repeated poll is not a new sample or new forecast", () => {
  const sample=frame(1,10);
  const result=evaluateAdvisorObservations([frame(0,0),sample,{...sample,capturedAt:sample.capturedAt+minute},frame(2,20)],"quick");
  assert.equal(result.observations,3);
  assert.equal(result.forecastsIssued,1);
  assert.equal(result.matchedOutcomes,0);
  assert.equal(result.forecastMAE,null);
});
test("missing/failed observations and reset changes invalidate pending forecasts", () => {
  const initial=[frame(0,0),frame(1,10),frame(2,20)];
  assert.equal(evaluateAdvisorObservations([...initial,{capturedAt:start+40*minute,accounts:[]},frame(3,30)],"quick").matchedOutcomes,0);
  assert.equal(evaluateAdvisorObservations([...initial,frame(3,30,start+6*3600000)],"quick").matchedOutcomes,0);
  assert.equal(evaluateAdvisorObservations([...initial,frame(3,5)],"quick").matchedOutcomes,0);
});
test("late outcomes and insufficient history never produce misleading zero error", () => {
  const result=evaluateAdvisorObservations([frame(0,0),frame(1,10),frame(2,20),frame(4,40)],"quick");
  assert.equal(result.matchedOutcomes,0);
  assert.equal(result.forecastMAE,null);
  assert.throws(()=>evaluateAdvisorObservations([frame(1,10),frame(0,0)],"quick"),/chronological/);
});
