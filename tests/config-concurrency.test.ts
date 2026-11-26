import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { releaseCollectorConfigLock } from "../collector/config.ts";

const exec = promisify(execFile);
const configUrl = new URL("../collector/config.ts", import.meta.url).href;
const securityUrl = new URL("../collector/security.ts", import.meta.url).href;

test("cross-process config transactions do not restore revoked consent or lose unrelated edits", async () => {
  const home = await mkdtemp(join(tmpdir(), "qo-config-lock-"));
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  const worker = (body: string) => exec(process.execPath, [
    "--experimental-strip-types", "--input-type=module", "--eval",
    `import { updateCollectorConfig, loadCollectorConfig, withCollectorConfig } from ${JSON.stringify(configUrl)};
     import { ensureCollectorHomeSecurity } from ${JSON.stringify(securityUrl)};
     import { writeFile, access, mkdir } from "node:fs/promises";
     import { join } from "node:path";
     import { setTimeout as delay } from "node:timers/promises";
     import { randomUUID } from "node:crypto";
     const home = process.env.USERPROFILE;
     await ensureCollectorHomeSecurity();
     ${body}`
  ], { env, timeout: 30000 });
  const waitFor = async (name: string) => {
    const until = Date.now() + 15000;
    while (Date.now() < until) {
      try { await readFile(join(home, name)); return; } catch { await delay(20); }
    }
    throw new Error("worker marker timed out: " + name);
  };
  try {
    await worker(`await updateCollectorConfig(c => ({...c, tokenAnalyticsEnabled:true,
      tokenAnalyticsSources:{...c.tokenAnalyticsSources,claudeCode:true,googleAntigravity:true},
      googleTokenConsentEpoch:randomUUID(),tokenConsentRevision:randomUUID()}));`);
    const revocation = worker(`await updateCollectorConfig(async c => {
      await writeFile(join(home,"held"),"1");
      const end=Date.now()+15000;
      while(true){try{await access(join(home,"contender"));break;}catch{if(Date.now()>end)throw Error("contender timeout");await delay(20);}}
      await delay(150);
      return {...c,tokenAnalyticsSources:{...c.tokenAnalyticsSources,claudeCode:false},tokenConsentRevision:randomUUID()};
    });`);
    // Attach handlers immediately so a failing worker cannot become an unhandled rejection.
    void revocation.catch(()=>undefined);
    await waitFor("held");
    const other = worker(`await writeFile(join(home,"contender"),"1");
      await updateCollectorConfig(c=>({...c,pollIntervalSeconds:1200}));`);
    await Promise.all([revocation,other]);
    const raw = JSON.parse(await readFile(join(home,".quotaops","collector.json"),"utf8"));
    assert.equal(raw.tokenAnalyticsSources.claudeCode,false);
    assert.equal(raw.tokenAnalyticsSources.googleAntigravity,true);
    assert.equal(raw.pollIntervalSeconds,1200);
    // Real CLI mutations use the same transaction and preserve each other's
    // independent opt-in scopes, including the separate Google epoch.
    const cli = (...args: string[]) => exec(process.execPath, [
      "--experimental-strip-types", fileURLToPath(new URL("../collector/cli.ts", import.meta.url)), ...args,
    ], { env, timeout: 30000 });
    await Promise.all([cli("tokens-auto","enable","codex"),cli("tokens-auto","disable","google-antigravity")]);
    const after = JSON.parse(await readFile(join(home,".quotaops","collector.json"),"utf8"));
    assert.equal(after.tokenAnalyticsSources.claudeCode,false);
    assert.equal(after.tokenAnalyticsSources.codex,true);
    assert.equal(after.tokenAnalyticsSources.googleAntigravity,false);
    assert.equal(after.googleTokenConsentEpoch,undefined);
    await cli("tokens-auto","enable","google-antigravity");
    const reenabled = JSON.parse(await readFile(join(home,".quotaops","collector.json"),"utf8"));
    assert.notEqual(reenabled.googleTokenConsentEpoch,raw.googleTokenConsentEpoch);
    assert.equal(reenabled.tokenAnalyticsSources.codex,true);
    // Failure to acquire the common lock must never run a writer/publication.
    await worker(`await mkdir(join(home,".quotaops","collector.json.lock"));
      let ran=false;try{await withCollectorConfig(()=>{ran=true;});throw Error("unexpected lock success");}
      catch(e){if(ran||!String(e).includes("lock busy"))throw e;}`);
    const unchanged = JSON.parse(await readFile(join(home,".quotaops","collector.json"),"utf8"));
    assert.deepEqual(unchanged,reenabled);
  } finally { await rm(home,{recursive:true,force:true}); }
});

test("configuration lock release retries only bounded transient EBUSY", async () => {
  const busy = Object.assign(new Error("busy"), { code: "EBUSY" });
  let calls = 0;
  let pauses = 0;
  await releaseCollectorConfigLock("fixture.lock", async path => {
    assert.equal(path, "fixture.lock");
    if (++calls < 3) throw busy;
  }, async ms => {
    assert.equal(ms, 50);
    pauses++;
  });
  assert.equal(calls, 3);
  assert.equal(pauses, 2);

  calls = 0;
  pauses = 0;
  await assert.rejects(releaseCollectorConfigLock("fixture.lock", async () => {
    calls++;
    throw busy;
  }, async () => { pauses++; }), error => error === busy);
  assert.equal(calls, 6);
  assert.equal(pauses, 5);

  for (const code of ["ENOENT", "ENOTEMPTY", "EACCES"]) {
    const failure = Object.assign(new Error(code), { code });
    calls = 0;
    await assert.rejects(releaseCollectorConfigLock("fixture.lock", async () => {
      calls++;
      throw failure;
    }, async () => { assert.fail("non-EBUSY failure must not retry"); }), error => error === failure);
    assert.equal(calls, 1);
  }
});
