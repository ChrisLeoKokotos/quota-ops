// Credential-free process E2E: real statusLine stdin -> hook -> collector CLI -> Token Analytics.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
const home=await mkdtemp(join(tmpdir(),"qo-statusline-e2e-"));
const env={...process.env,HOME:home,USERPROFILE:home};
function run(script,args=[],input){
  const r=spawnSync(process.execPath,["--experimental-strip-types",script,...args],
    {env,encoding:"utf8",input,timeout:25000,maxBuffer:256*1024});
  if(r.status!==0)throw new Error(script+" "+args.join(" ")+" failed: "+r.stderr.slice(-900));
  return r.stdout;
}
try{
  run("collector/cli.ts",["add","google","google-1","Google E2E"]);
  const instructions=run("collector/cli.ts",["google-hook","google-1"]);
  assert.match(instructions,/statusline/);
  const event={
    product:"antigravity",session_id:"private-session-id",email:"private@invalid.example",
    cwd:"/private/path",transcript_path:"/private/transcript",
    plan_tier:"Pro",quota:{
      "gemini-5h":{remaining_fraction:0.8,reset_time:"2099-11-20T20:00:00Z"},
      "gemini-weekly":{remaining_fraction:0.35,reset_time:"2099-11-21T20:00:00Z"},
    },context_window:{total_input_tokens:120,total_output_tokens:30,
      current_usage:{cache_read_input_tokens:20}},
  };
  assert.match(run("collector/google-hook.ts",["google-1"],JSON.stringify(event)),/QuotaOps/);
  const raw=await readFile(join(home,".quotaops","google-statusline","google-1.json"),"utf8");
  for(const secret of ["private@invalid","/private/path","/private/transcript","private-session-id"])
    assert.equal(raw.includes(secret),false,secret);
  const collected=JSON.parse(run("collector/cli.ts",["collect","google-1"]));
  assert.equal(collected.status,"ok");
  assert.equal(collected.account.provider,"google");
  assert.deepEqual(collected.account.windows.map(w=>w.usedPercent),[20,65]);
  run("collector/cli.ts",["tokens-auto","enable","google-antigravity"]);
  const analytics=JSON.parse(run("collector/cli.ts",["tokens"]));
  assert.equal(analytics.totals.totalTokens,150);
  assert.equal(analytics.providers.find(p=>p.provider==="google").totals.inputTokens,120);
  assert.equal(analytics.sources.find(s=>s.source==="google-antigravity").state,"ok");
  // Duplicate event does not add tokens.
  run("collector/google-hook.ts",["google-1"],JSON.stringify(event));
  assert.equal(JSON.parse(run("collector/cli.ts",["tokens"])).totals.totalTokens,150);
  console.log("PASS: Antigravity CLI statusLine hook -> sanitized storage -> Google quota collector -> optional Token Analytics.");
}finally{await rm(home,{recursive:true,force:true});}
