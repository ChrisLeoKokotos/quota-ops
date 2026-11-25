/** Antigravity CLI documented statusLine command, sanitizes JSON on stdin. */
import { loadCollectorConfig, withCollectorConfig } from "./config.ts";
import { ingestGoogleStatusline } from "./google-statusline.ts";
import { ensureCollectorHomeSecurity } from "./security.ts";
const id=process.argv[2]??"";
const chunks:Buffer[]=[];let size=0;
try{
  for await(const c of process.stdin){
    const b=Buffer.isBuffer(c)?c:Buffer.from(c);size+=b.length;
    if(size>128*1024)throw Error("oversized payload");
    chunks.push(b);
  }
  await ensureCollectorHomeSecurity();
  const cfg=await loadCollectorConfig();
  if(!cfg.accounts.some(a=>a.id===id&&a.provider==="google"&&a.enabled))throw Error("unconfigured account");
  const payload:unknown=JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const epoch=cfg.tokenAnalyticsEnabled && cfg.tokenAnalyticsSources.googleAntigravity === true
    ? cfg.googleTokenConsentEpoch ?? "legacy" : null;
  const receivedAt=Date.now();
  // Global config lock first, then the per-account statusline lock. No
  // configuration writer can revoke consent between validation and rename.
  await withCollectorConfig(async latest=>{
    if(!latest.accounts.some(a=>a.id===id&&a.provider==="google"&&a.enabled))throw Error("unconfigured account");
    const currentEpoch=latest.tokenAnalyticsEnabled&&latest.tokenAnalyticsSources.googleAntigravity===true
      ? latest.googleTokenConsentEpoch??"legacy":null;
    // Do not let an event from a superseded epoch modify a new epoch's state.
    if(currentEpoch!==epoch)throw Error("consent changed");
    if(!await ingestGoogleStatusline(id,payload,undefined,receivedAt,epoch))
      throw Error("invalid statusline");
  });
}catch{
  process.exitCode=1; // Never log raw JSON, path, email or token fields.
}
process.stdout.write("QuotaOps · Antigravity\n");
