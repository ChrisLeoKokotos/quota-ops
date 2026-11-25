/** Antigravity CLI documented statusLine command, sanitizes JSON on stdin. */
import { loadCollectorConfig } from "./config.ts";
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
  if(!await ingestGoogleStatusline(id,payload,undefined,Date.now(),
    cfg.tokenAnalyticsEnabled && cfg.tokenAnalyticsSources.googleAntigravity === true
      ? cfg.googleTokenConsentEpoch ?? "legacy" : null))
    throw Error("invalid statusline");
}catch{
  process.exitCode=1; // Never log raw JSON, path, email or token fields.
}
process.stdout.write("QuotaOps · Antigravity\n");
