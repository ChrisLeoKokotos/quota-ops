// Credential-free process E2E: real statusLine stdin -> hook -> collector CLI -> Token Analytics.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, rmdir, stat } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
const home=await mkdtemp(join(tmpdir(),"qo-statusline-e2e-"));
const env={...process.env,HOME:home,USERPROFILE:home};
function attempt(script,args=[],input){
  const r=spawnSync(process.execPath,["--experimental-strip-types",script,...args],
    {env,encoding:"utf8",input,timeout:25000,maxBuffer:256*1024});
  if(r.error)throw r.error;
  return r;
}
function run(script,args=[],input){
  const r=attempt(script,args,input);
  if(r.status!==0)throw new Error(script+" "+args.join(" ")+" failed: "+r.stderr.slice(-900));
  return r.stdout;
}
try{
  run("collector/cli.ts",["add","google","google-1","Google E2E"]);
  // Explicit opt-in must precede capturing numeric token counters.
  run("collector/cli.ts",["tokens-auto","enable","google-antigravity"]);
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
  run("collector/google-hook.ts",["google-1"],JSON.stringify({...event,context_window:{total_input_tokens:0,total_output_tokens:0}}));
  assert.match(run("collector/google-hook.ts",["google-1"],JSON.stringify(event)),/QuotaOps/);
  const raw=await readFile(join(home,".quotaops","google-statusline","google-1.json"),"utf8");
  for(const secret of ["private@invalid","/private/path","/private/transcript","private-session-id"])
    assert.equal(raw.includes(secret),false,secret);
  const collected=JSON.parse(run("collector/cli.ts",["collect","google-1"]));
  assert.equal(collected.status,"ok");
  assert.equal(collected.account.provider,"google");
  assert.deepEqual(collected.account.windows.map(w=>w.usedPercent),[20,65]);
  const analytics=JSON.parse(run("collector/cli.ts",["tokens"]));
  assert.equal(analytics.totals.totalTokens,150);
  assert.equal(analytics.providers.find(p=>p.provider==="google").totals.inputTokens,120);
  assert.equal(analytics.sources.find(s=>s.source==="google-antigravity").state,"ok");
  // Duplicate event does not add tokens.
  run("collector/google-hook.ts",["google-1"],JSON.stringify(event));
  assert.equal(JSON.parse(run("collector/cli.ts",["tokens"])).totals.totalTokens,150);
  // "Disable all" must revoke Google token recording too, while quota capture remains enabled.
  run("collector/cli.ts",["tokens-auto","disable","all"]);
  const changed={...event,context_window:{total_input_tokens:300,total_output_tokens:100}};
  run("collector/google-hook.ts",["google-1"],JSON.stringify(changed));
  const persisted=JSON.parse(await readFile(join(home,".quotaops","google-statusline","google-1.json"),"utf8"));
  assert.equal(persisted.totals.totalTokens,150);
  assert.equal(JSON.parse(run("collector/cli.ts",["collect","google-1"])).status,"ok");
  assert.match(run("collector/cli.ts",["tokens-auto","status"]),/Antigravity numeric counters: disabled/);
  console.log("PASS: Antigravity CLI statusLine hook -> sanitized storage -> Google quota collector -> optional Token Analytics.");

  const configPath=join(home,".quotaops","collector.json");
  const statePath=join(home,".quotaops","google-statusline","google-1.json");
  const lockPath=configPath+".lock";
  // A real subprocess exits while it owns the transaction lock (no finally).
  // It uses an isolated synthetic home and never touches an owner's config.
  const configUrl=new URL("../collector/config.ts",import.meta.url).href;
  const beforeCrashConfig=await readFile(configPath,"utf8");
  const beforeCrashState=await readFile(statePath,"utf8");
  const crashed=spawnSync(process.execPath,["--experimental-strip-types","--input-type=module","--eval",
    `import {withCollectorConfig} from ${JSON.stringify(configUrl)}; await withCollectorConfig(()=>process.exit(23));`],
    {env,encoding:"utf8",timeout:25000});
  if(crashed.error)throw crashed.error;
  assert.equal(crashed.status,23);
  assert.equal((await stat(lockPath)).isDirectory(),true);
  assert.equal(attempt("collector/cli.ts",["tokens-auto","enable","google-antigravity"]).status,1);
  assert.equal(attempt("collector/google-hook.ts",["google-1"],JSON.stringify(changed)).status,1);
  assert.equal(await readFile(configPath,"utf8"),beforeCrashConfig);
  assert.equal(await readFile(statePath,"utf8"),beforeCrashState);
  // Every child is reaped; the manual recovery procedure removes only the
  // empty test lock. No automatic stale-lock breaking is allowed.
  await rmdir(lockPath);
  run("collector/cli.ts",["tokens-auto","enable","google-antigravity"]);
  run("collector/google-hook.ts",["google-1"],JSON.stringify(changed));
  assert.equal(JSON.parse(await readFile(statePath,"utf8")).totals.totalTokens,150);
  console.log("PASS: crashed configuration lock owner -> fail-closed CLI and hook -> explicit recovery -> new baseline.");

  function childRun(script,args,input){
    return new Promise((resolve,reject)=>{
      const child=spawn(process.execPath,["--experimental-strip-types",script,...args],
        {env,stdio:["pipe","ignore","ignore"],windowsHide:true});
      const timer=setTimeout(()=>{child.kill();},25000);
      child.stdin.on("error",()=>{}); // Early refusal may close the input pipe.
      child.once("error",error=>{clearTimeout(timer);reject(error);});
      child.once("close",(code,signal)=>{clearTimeout(timer);if(signal)reject(Error("child interrupted"));else resolve(code);});
      child.stdin.end(input);
    });
  }
  // Two real concurrent processes. Either linearization is valid: if the
  // hook publishes first its delta is consented; if revocation wins no delta
  // may be stored. After acknowledged revoke, all later events are quota-only.
  const racing={...event,context_window:{total_input_tokens:330,total_output_tokens:110}};
  const [hookResult,revokeResult]=await Promise.allSettled([
    childRun("collector/google-hook.ts",["google-1"],JSON.stringify(racing)),
    childRun("collector/cli.ts",["tokens-auto","disable","google-antigravity"]),
  ]);
  assert.equal(hookResult.status,"fulfilled");
  assert.ok([0,1].includes(hookResult.value));
  assert.equal(revokeResult.status,"fulfilled");
  assert.equal(revokeResult.value,0);
  const revoked=JSON.parse(await readFile(configPath,"utf8"));
  assert.equal(revoked.tokenAnalyticsSources.googleAntigravity,false);
  assert.equal(revoked.googleTokenConsentEpoch,undefined);
  const atRevoke=JSON.parse(await readFile(statePath,"utf8")).totals.totalTokens;
  assert.ok([150,190].includes(atRevoke),"only the pre-revocation delta is permitted");
  const later={...event,context_window:{total_input_tokens:900,total_output_tokens:300}};
  run("collector/google-hook.ts",["google-1"],JSON.stringify(later));
  assert.equal(JSON.parse(await readFile(statePath,"utf8")).totals.totalTokens,atRevoke);
  run("collector/cli.ts",["tokens-auto","enable","google-antigravity"]);
  run("collector/google-hook.ts",["google-1"],JSON.stringify(later));
  assert.equal(JSON.parse(await readFile(statePath,"utf8")).totals.totalTokens,atRevoke);
  run("collector/google-hook.ts",["google-1"],JSON.stringify({...later,context_window:{total_input_tokens:910,total_output_tokens:305}}));
  assert.equal(JSON.parse(await readFile(statePath,"utf8")).totals.totalTokens,atRevoke+15);
  console.log("PASS: concurrent real hook/revoke -> no post-revocation delta -> re-opt-in baseline -> new delta only.");
}finally{await rm(home,{recursive:true,force:true});}
