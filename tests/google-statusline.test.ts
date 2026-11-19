import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectGoogleStatusline, ingestGoogleStatusline, readGoogleStatusline, readGoogleTokenStates } from "../collector/google-statusline.ts";
import type { CollectorAccountConfig } from "../collector/types.ts";

const account:CollectorAccountConfig={id:"google-1",label:"Google One",provider:"google",
  enabled:true,profileDir:"unused"};
const DATE=Date.parse("2026-11-19T20:00:00Z");
const payload=(input:number,output:number,session="session-A"):unknown=>({
  product:"antigravity",session_id:session,plan_tier:"Pro",
  email:"do-not-store@example.com",cwd:"/private/workspace",
  transcript_path:"/secret/transcript.jsonl",
  context_window:{total_input_tokens:input,total_output_tokens:output,
    current_usage:{cache_read_input_tokens:3,cache_creation_input_tokens:2}},
  quota:{
    "gemini-5h":{remaining_fraction:0.9378,reset_time:"2026-11-20T00:00:00Z"},
    "gemini-weekly":{remaining_fraction:0.5,reset_in_seconds:3600},
    "credits":{remaining_amount:42},
  },
});
test("Google projector only accepts supported statusLine quota fields",()=>{
  const p=projectGoogleStatusline(payload(100,20),DATE);
  assert.equal(p?.plan,"Pro");
  assert.equal(p?.windows.length,2);
  assert.equal(p?.windows[0]?.usedPercent,6.2);
  assert.equal(p?.windows[1]?.resetAt,"2026-11-19T21:00:00.000Z");
  assert.equal(projectGoogleStatusline({product:"something-else"}),null);
  assert.equal(projectGoogleStatusline({product:"antigravity",quota:{
    bad:{remaining_fraction:1.1},str:{remaining_fraction:"0.2"},
  }})?.windows.length,0);
});
test("automatic Google snapshots are privacy-scoped, monotonic, deduplicated and stale-safe",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"qo-google-test-"));
  try{
    assert.equal(await ingestGoogleStatusline("google-1",payload(100,20),dir,DATE),true);
    assert.equal(await ingestGoogleStatusline("google-1",payload(100,20),dir,DATE+1000),true);
    assert.equal(await ingestGoogleStatusline("google-1",payload(150,30),dir,DATE+2000),true);
    assert.equal(await ingestGoogleStatusline("google-1",payload(75,15),dir,DATE+3000),true);
    const raw=await readFile(join(dir,"google-1.json"),"utf8");
    for(const secret of ["do-not-store@example.com","/private/workspace","/secret/transcript","session-A"])
      assert.equal(raw.includes(secret),false,secret);
    const report=await readGoogleTokenStates([account],dir);
    assert.equal(report.files,1);
    assert.equal(report.totals.totalTokens,180);
    assert.equal(report.totals.inputTokens,150);
    assert.equal(report.totals.outputTokens,30);
    assert.equal(report.totals.cacheReadTokens,6);
    const ok=await readGoogleStatusline(account,dir,DATE+4000);
    assert.equal(ok.status,"ok");
    assert.equal(ok.account?.provider,"google");
    assert.equal(ok.account?.windows.length,2);
    const stale=await readGoogleStatusline(account,dir,DATE+16*60000);
    assert.equal(stale.status,"unavailable");
    assert.equal(stale.account,null);
    // An event without quota MUST NOT refresh old windows as if still current.
    await ingestGoogleStatusline("google-1",{product:"antigravity"},dir,DATE+6000);
    assert.equal((await readGoogleStatusline(account,dir,DATE+7000)).status,"unavailable");
  }finally{await rm(dir,{recursive:true,force:true});}
});
test("quota-only Google events do not persist numeric token counters before explicit opt-in",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"qo-google-no-consent-"));
  try{
    assert.equal(await ingestGoogleStatusline("google-1",payload(900,100),dir,DATE,false),true);
    assert.equal((await readGoogleStatusline(account,dir,DATE+1000)).status,"ok");
    const snapshot=await readGoogleTokenStates([account],dir);
    assert.equal(snapshot.totals.totalTokens,0);
    const raw=await readFile(join(dir,"google-1.json"),"utf8");
    assert.equal(raw.includes("session-A"),false);
    assert.equal(Object.keys(JSON.parse(raw).sessions).length,0);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test("separate Google sessions contribute only their observed deltas",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"qo-google-test-"));
  try{
    await ingestGoogleStatusline("google-1",payload(100,30),dir,DATE);
    await ingestGoogleStatusline("google-1",payload(50,10,"session-B"),dir,DATE+1000);
    assert.equal((await readGoogleTokenStates([account],dir)).totals.totalTokens,190);
  }finally{await rm(dir,{recursive:true,force:true});}
});
