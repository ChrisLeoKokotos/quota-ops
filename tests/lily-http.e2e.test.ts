import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { getCollectorTokenPath, getLilyReadTokenPath } from "../collector/paths.ts";

// An actual Node HTTP server with an empty isolated QuotaOps home. No logins,
// browser profiles, external provider requests, or real user data are used.
test("Lily-only token cannot read collector endpoints and vice versa", { timeout: 24_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(),"quotaops-lily-e2e-"));
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  const child = spawn(process.execPath, [
    "--experimental-strip-types",resolve("collector/service.ts"),
  ], {cwd:resolve("."), env, stdio:["ignore","pipe","pipe"]});
  let output="";
  child.stderr.on("data", b => { output+=(b as Buffer).toString("utf8").slice(0,3000); });
  try {
    let alive = false;
    for (let i=0;i<45;i++) {
      if (child.exitCode !== null) break;
      try {
        const result=await fetch("http://127.0.0.1:4317/health",{signal:AbortSignal.timeout(400)});
        if(result.status===401){alive=true;break;}
      }catch{}
      await wait(180);
    }
    assert.ok(alive,"Local collector failed to start: "+output.slice(0,350));
    // Token files belong only to the disposable temporary home.
    const collector = (await readFile(join(home,".quotaops","collector.token"),"utf8")).trim();
    const lily = (await readFile(join(home,".quotaops","lily-read.token"),"utf8")).trim();
    assert.equal(collector.length,43);
    assert.equal(lily.length,43);
    assert.notEqual(collector,lily);
    const request=(path:string,token:string,headers:Record<string,string>={}) =>
      fetch("http://127.0.0.1:4317"+path,{
        headers:{Authorization:"Bearer "+token,...headers},signal:AbortSignal.timeout(900),
      });
    assert.equal((await request("/snapshot",lily)).status,401);
    assert.equal((await request("/lily/v1/snapshot",collector)).status,401);
    assert.equal((await request("/lily/v1/snapshot","x".repeat(43))).status,401);
    const denied=await request("/lily/v1/snapshot",lily,{Origin:"https://untrusted.example"});
    assert.equal(denied.status,403);
    const response=await request("/lily/v1/snapshot",lily);
    assert.equal(response.status,200);
    assert.match(response.headers.get("content-type")??"",/application\/json/i);
    assert.ok(Number(response.headers.get("content-length"))>0);
    const body=await response.json() as Record<string,unknown>;
    assert.equal(body.version,1);
    assert.equal(body.scope,"lily_readonly");
    assert.deepEqual(body.accounts,[]);
    assert.equal((body.tokens as Record<string,unknown>).scope,"locally_observed");
    assert.equal((await request("/snapshot",collector)).status,200);
  } finally {
    child.kill();
    await wait(200);
    await rm(home,{recursive:true,force:true});
  }
});
