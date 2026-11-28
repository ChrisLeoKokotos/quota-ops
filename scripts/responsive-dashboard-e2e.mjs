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
// Full production dashboard, real local collector with synthetic inputs.
const viewports = [[2560,1440],[1920,1080],[1536,864],[1366,768],[1281,720],[1280,720],[1201,720],[1200,720],[1121,720],[1120,720],
  [1024,768],[960,540],[768,1024],[761,540],[760,540],[640,480],[480,360],[390,844],[320,568]];
const longLabel = "LongAccountName".repeat(3);
try {
  run("collector/cli.ts",["add","google","responsive-google","Synthetic responsive Google"]);
  run("collector/cli.ts",["tokens-auto","enable","google-antigravity"]);
  run("collector/google-hook.ts",["responsive-google"],JSON.stringify({product:"antigravity",session_id:"synthetic-responsive",context_window:{total_input_tokens:0,total_output_tokens:0}}));
  run("collector/google-hook.ts",["responsive-google"],JSON.stringify({
    product:"antigravity",session_id:"synthetic-responsive",
    plan_tier:"Pro",quota:{
      "very-long-model-group-five-hour":{remaining_fraction:0.75,reset_time:"2099-11-20T00:00:00Z"},
      "weekly":{remaining_fraction:0.55,reset_time:"2099-11-21T00:00:00Z"}},
    context_window:{total_input_tokens:8_000_000_000_000,total_output_tokens:999_999_999_999,
      current_usage:{cache_read_input_tokens:4_000_000_000_000}},
  }));
  await service("collector/service.ts",[],/QuotaOps collector listening on (http:\/\/127\.0\.0\.1:\d+)/);
  const url=await service("server/dashboard-server.ts",["--production"],/QuotaOps dashboard listening on (http:\/\/127\.0\.0\.1:\d+)/);
  try{browser=await chromium.launch({channel:"chrome",headless:true});}
  catch{browser=await chromium.launch({channel:"msedge",headless:true});}
  const page=await browser.newPage({viewport:{width:1440,height:900},reducedMotion:"reduce"});
  await page.goto(url,{waitUntil:"domcontentloaded"});
  await page.locator(".token-hero strong").first().waitFor({timeout:30000});
  await page.evaluate(label=>{
    const now=Date.now();
    const accounts=Array.from({length:5},(_,i)=>({
      id:"responsive-"+i,label:i===0?label:"Synthetic account "+i,
      email:"long".repeat(20)+"@"+ "example".repeat(12)+".invalid",
      provider:"claude",plan:"Synthetic",source:"manual",updatedAt:new Date(now).toISOString(),
      windows:[{id:"five-hour",label:"LongQuotaWindow".repeat(4),usedPercent:10+i*15,resetAt:new Date(now+14400000).toISOString()},
        {id:"weekly",label:"Weekly",usedPercent:10+i*15,resetAt:new Date(now+259200000).toISOString()}],
    }));
    localStorage.setItem("quotaops:accounts:v2",JSON.stringify(accounts));
  },longLabel);
  await page.reload({waitUntil:"domcontentloaded"});
  const advisor=page.getByRole("region",{name:"Smart Account Advisor"});
  await advisor.getByRole("status").getByText(longLabel,{exact:true}).waitFor({timeout:30000});
  await page.locator(".token-hero strong").first().waitFor({timeout:30000});
  // Two headline numbers: generated (output) and total processed, both exact.
  assert.match(await page.locator(".token-hero-pair > div").nth(0).locator("small").innerText(), /999[,\s.]999[,\s.]999[,\s.]999/);
  assert.match(await page.locator(".token-hero-pair > div").nth(1).locator("small").innerText(), /8[,\s.]999[,\s.]999[,\s.]999[,\s.]999/);
  const card=page.locator(".account-card").filter({hasText:longLabel});
  await card.getByText("Account details",{exact:true}).click();
  await card.getByText("Edit",{exact:true}).first().click();
  async function verify(label) {
    // Measure document overflow and key local layout boxes, not screenshots
    // of synthetic fixtures alone. No global overflow-x:hidden workaround.
    const bad=await page.evaluate(()=>{
      const failures=[];
      const width=document.documentElement.clientWidth;
      if(document.documentElement.scrollWidth>width+1) failures.push("document horizontal overflow");
      const selectors=[".sidebar",".sidebar-top",".sidebar-nav",".sidebar-footer",".workspace",".page-header",".header-actions",
        ".metric",".metric strong",".advisor-controls",".advisor-status",".advisor-result",".token-panel",
        ".token-hero strong",".token-hero small",".token-breakdown strong",".token-source-card",".token-source-card strong",
        ".token-range",".token-total strong",".account-card",".account-header",".account-header h2",".account-header p",
        ".quota-row",".quota-row-main",".reset-copy",".edit-grid",".account-settings-grid",".modal-card",".modal-actions"];
      for(const selector of selectors)for(const el of document.querySelectorAll(selector)){
        // Chromium retains layout geometry for closed details descendants;
        // they are not rendered. Keep the summary and every open editor.
        const closed=el.closest("details:not([open])");
        if(closed && !el.closest("summary"))continue;
        const r=el.getBoundingClientRect(), style=getComputedStyle(el);
        if(!r.width||!r.height||style.display==="none"||style.visibility==="hidden")continue;
        if(r.left< -1||r.right>width+1)failures.push(selector+" outside viewport");
        if(el.scrollWidth>el.clientWidth+1)failures.push(selector+" local overflow "+el.scrollWidth+"/"+el.clientWidth);
      }
      for(const e of document.querySelectorAll(".token-hero strong,.token-breakdown strong,.token-source-card strong,.token-total strong,.metric-highlight strong")){
        if(getComputedStyle(e).textOverflow==="ellipsis")failures.push("numeric/recommendation text truncated");
      }
      const status=document.querySelector(".advisor-status");
      if(status && getComputedStyle(status).gridTemplateColumns.split(" ").length!==1)failures.push("advisor status must be one column");
      return failures.slice(0,25);
    });
    assert.deepEqual(bad,[],label+" : "+bad.join("; "));
  }
  // The old 940px break abruptly changed the content width. On the fluid
  // rail the shell width must vary continuously over its transition band.
  let previousWidth = null;
  for (const width of [1119,1120,1121,1199,1200,1201,1279,1280,1281]) {
    await page.setViewportSize({width,height:720});
    const actual=await page.locator(".workspace").evaluate(el=>el.getBoundingClientRect().width);
    if(previousWidth && width-previousWidth.viewport===1)
      assert.ok(Math.abs(actual-previousWidth.actual)<3,"workspace jumps at "+width);
    previousWidth={viewport:width,actual};
  }
  let checks=0;
  for(const [width,height] of viewports){
    await page.setViewportSize({width,height});
    for(const theme of ["light","dark"]){
      if(await page.locator("html").getAttribute("data-theme")!==theme){
        await page.getByRole("button",{name:theme==="dark"?"Dark mode":"Light mode",exact:true}).click();
      }
      for(const open of [true,false]){
        const toggle=page.getByRole("button",{name:open?"Open sidebar":"Close sidebar",exact:true});
        if(await toggle.count())await toggle.click();
        await page.locator(".app-shell").waitFor();
        if(open){
          for(const name of ["Overview","Accounts"])assert.equal(await page.getByRole("link",{name,exact:true}).count(),1);
          for(const name of [theme==="dark"?"Light mode":"Dark mode","Enable notifications","Keyboard shortcuts"])
            assert.equal(await page.getByRole("button",{name,exact:true}).count(),1);
        }
        await verify(width+"x"+height+" "+theme+" sidebar="+open);
        checks++;
      }
      await page.getByRole("button",{name:"Open sidebar",exact:true}).click();
    }
    // Verify native controls/modal at each size, including short heights.
    await page.getByRole("button",{name:"Add account",exact:true}).first().click();
    const modal=page.getByRole("dialog",{name:"Add account"});
    await modal.getByLabel("Provider").selectOption("google");
    await verify(width+"x"+height+" modal");
    await modal.getByRole("button",{name:"Close",exact:true}).click();
    // Check the advisor control is operable after every resize.
    await advisor.getByLabel("Task").selectOption("heavy");
    await advisor.getByLabel("Task").selectOption("coding");
    console.log("PASS responsive "+width+"x"+height+" light/dark, open/closed, modal");
  }
  console.log("PASS: "+checks+" responsive layout combinations plus "+viewports.length+" modal checks.");
  await page.close();

  // Real React renderer with a deterministic synthetic desktop bridge.
  // Resolve the newest snapshot first, then a revoked pre-change response.
  // No provider credentials and no actual Electron privilege are involved.
  const racePage=await browser.newPage({viewport:{width:1440,height:900}});
  await racePage.addInitScript(()=>{
    let hold=false, consentListener=null;
    const pending=[];
    const fixture=(enabled)=>{
      const now=new Date().toISOString();
      const totals={inputTokens:987654321,outputTokens:0,cacheReadTokens:0,cacheWriteTokens:0,totalTokens:987654321};
      return {version:1,generatedAt:now,accounts:[],
        tokens:enabled?{generatedAt:now,scope:"locally_observed",totals,providers:[{provider:"claude",totals}],daily:[],
          sources:[{source:"claude-code",provider:"claude",state:"ok",files:1,message:null}]}:null,
        tokenStatus:{state:enabled?"ready":"disabled",scannedAt:enabled?now:null,pending:false}};
    };
    window.quotaops={version:1,getSnapshot:()=>hold?new Promise(resolve=>pending.push(resolve)):Promise.resolve(fixture(true)),
      setTokenAnalytics:async()=>({status:"off"}),
      onTokenConsentChanged:callback=>{consentListener=callback;return()=>{consentListener=null;};}};
    window.__qoRace={
      begin:()=>{hold=true;document.dispatchEvent(new Event("visibilitychange"));},
      count:()=>pending.length,
      revoke:()=>consentListener?.(),
      finish:(index,enabled)=>pending[index](fixture(enabled))
    };
  });
  await racePage.goto(url,{waitUntil:"domcontentloaded"});
  await racePage.locator(".token-hero strong").first().waitFor({timeout:30000});
  await racePage.evaluate(()=>window.__qoRace.begin());
  await racePage.waitForFunction(()=>window.__qoRace.count()===1);
  await racePage.evaluate(()=>window.__qoRace.revoke());
  await racePage.waitForFunction(()=>window.__qoRace.count()>=2);
  await racePage.locator(".token-hero strong").first().waitFor({state:"hidden"});
  await racePage.evaluate(()=>window.__qoRace.finish(1,false));
  await racePage.getByText("Token analytics is off.",{exact:true}).waitFor();
  await racePage.evaluate(()=>window.__qoRace.finish(0,true));
  // Two animation frames allow the delayed promise and React updates to settle.
  await racePage.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  assert.equal(await racePage.locator(".token-hero strong").count(),0);
  assert.equal(await racePage.getByText("Token analytics is off.",{exact:true}).count(),1);
  await racePage.close();
  console.log("PASS delayed IPC renderer response after consent invalidation");
}finally{
  await browser?.close().catch(()=>undefined);
  for(const child of started.reverse()){
    if(child.exitCode!==null)continue;
    child.kill("SIGTERM");
    await Promise.race([new Promise(resolve=>child.once("exit",resolve)),new Promise(resolve=>setTimeout(resolve,2500))]);
    if(child.exitCode===null)child.kill("SIGKILL");
  }
  await rm(home,{recursive:true,force:true});
}
