// Synthetic end-to-end local Google statusLine -> collector service -> trusted dashboard -> real Chrome.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";

const home=await mkdtemp(join(tmpdir(),"qo-google-dashboard-"));
const env={...process.env,HOME:home,USERPROFILE:home};
const started=[];
let browser=null;
function run(script,args=[],input){
  const r=spawnSync(process.execPath,["--experimental-strip-types",script,...args],
    {cwd:process.cwd(),env,encoding:"utf8",input,timeout:25000,maxBuffer:256*1024});
  if(r.status!==0)throw Error(script+" failed: "+r.stderr.slice(-800));
  return r.stdout;
}
function service(script,args,pattern){
  return new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,["--experimental-strip-types",script,...args],
      {env,cwd:process.cwd(),stdio:["ignore","pipe","pipe"],windowsHide:true});
    started.push(child);
    let stdout="",stderr="",settled=false;
    const timer=setTimeout(()=>fail(Error(script+" did not start: "+stderr)),90000);
    function fail(error){if(!settled){settled=true;clearTimeout(timer);reject(error);}}
    child.once("error",fail);
    child.once("exit",code=>fail(Error(script+" exited "+code+": "+stderr.slice(-1000))));
    child.stderr.on("data",chunk=>{stderr=(stderr+String(chunk)).slice(-3000);});
    child.stdout.on("data",chunk=>{
      stdout=(stdout+String(chunk)).slice(-3000);
      const m=stdout.match(pattern);
      if(m&&!settled){settled=true;clearTimeout(timer);resolve(m[1]??"ready");}
    });
  });
}
try{
  run("collector/cli.ts",["add","google","google-1","Google Automatic E2E"]);
  run("collector/cli.ts",["tokens-auto","enable","google-antigravity"]);
  run("collector/google-hook.ts",["google-1"],JSON.stringify({
    product:"antigravity",session_id:"test-session",
    email:"never-show@example.com",plan_tier:"Pro",
    quota:{"gemini-5h":{remaining_fraction:0.75,reset_time:"2099-11-20T00:00:00Z"},
      "gemini-weekly":{remaining_fraction:0.55,reset_time:"2099-11-21T00:00:00Z"}},
    context_window:{total_input_tokens:100,total_output_tokens:50,
      current_usage:{cache_read_input_tokens:10}},
  }));
  await service("collector/service.ts",[],/QuotaOps collector listening on (http:\/\/127\.0\.0\.1:\d+)/);
  const url=await service("server/dashboard-server.ts",["--production"],
    /QuotaOps dashboard listening on (http:\/\/127\.0\.0\.1:\d+)/);
  try{browser=await chromium.launch({channel:"chrome",headless:true});}
  catch{browser=await chromium.launch({channel:"msedge",headless:true});}
  const context=await browser.newContext({viewport:{width:1440,height:1000}});
  const page=await context.newPage();
  await page.goto(url,{waitUntil:"domcontentloaded",timeout:45000});
  const card=page.locator(".account-card").filter({hasText:"Google Automatic E2E"});
  await card.getByText("google-bucket:gemini-5h").count(); // use rendered quota labels below
  await card.getByText("gemini 5h",{exact:true}).waitFor({timeout:30000});
  const text=await card.innerText();
  assert.match(text,/auto-synced/);
  assert.match(text,/25%/);
  assert.match(text,/45%/);
  await page.locator(".token-source").filter({hasText:"Antigravity CLI"}).waitFor({timeout:30000});
  const saved=await page.evaluate(()=>JSON.parse(localStorage.getItem("quotaops:accounts:v2")??"[]"));
  assert.equal(saved.find(a=>a.id==="google-1")?.provider,"google");
  assert.equal(saved.find(a=>a.id==="google-1")?.source,"collector");
  console.log("PASS: Antigravity synthetic statusLine -> live collector -> proxy -> browser account/Token Analytics.");
}finally{
  await browser?.close().catch(()=>undefined);
  for(const child of started.reverse()){
    if(child.exitCode!==null)continue;
    child.kill("SIGTERM");
    await Promise.race([new Promise(resolve=>child.once("exit",resolve)),
      new Promise(resolve=>setTimeout(resolve,2500))]);
    if(child.exitCode===null)child.kill("SIGKILL");
  }
  await rm(home,{recursive:true,force:true});
}
