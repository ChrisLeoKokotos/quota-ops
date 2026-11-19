import { createHash, randomUUID } from "node:crypto";
import { open, lstat, mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { clampPercent, type QuotaWindow } from "../lib/quota.ts";
import { addTokenTotals, emptyTokenTotals, type TokenTotals } from "../lib/token-analytics.ts";
import { getGoogleStatuslineRoot } from "./paths.ts";
import type { CollectorAccountConfig, CollectorAccountResult } from "./types.ts";

const ACCOUNT=/^[a-z0-9][a-z0-9_-]{0,31}$/;
const BUCKET=/^[a-zA-Z0-9][a-zA-Z0-9_:-]{0,79}$/;
const MAX_BYTES=512*1024, MAX_SESSIONS=512, MAX_DAYS=800, FRESH_MS=15*60*1000;
const obj=(v:unknown):Record<string,unknown>|null=>
  v!==null&&typeof v==="object"&&!Array.isArray(v)?v as Record<string,unknown>:null;
const count=(n:unknown):number|null=>
  typeof n==="number"&&Number.isSafeInteger(n)&&n>=0?n:null;
const safeDate=(v:unknown,seconds:unknown,now:number):string|null=>{
  if(typeof v==="string"){
    const n=Date.parse(v);if(Number.isFinite(n)&&n>=0)return new Date(n).toISOString();
  }
  if(typeof seconds==="number"&&Number.isFinite(seconds)&&seconds>=0&&seconds<=31*86400)
    return new Date(now+Math.round(seconds*1000)).toISOString();
  return null;
};
interface Counter{input:number;output:number}
interface Stored{
  version:1;updatedAt:string;plan:string;windows:QuotaWindow[];
  sessions:Record<string,Counter>;totals:TokenTotals;daily:Record<string,TokenTotals>;
}
export interface GoogleProjection{
  checkedAt:string;plan:string;windows:QuotaWindow[];sessionHash:string|null;
  input:number|null;output:number|null;cacheRead:number;cacheWrite:number;
}
/** Drop all sensitive statusline fields. Never persist full payload, email or raw session ID. */
export function projectGoogleStatusline(payload:unknown,now=Date.now()):GoogleProjection|null{
  const root=obj(payload);if(!root||root.product!=="antigravity")return null;
  const windows:QuotaWindow[]=[];
  for(const [id,raw] of Object.entries(obj(root.quota)??{}).slice(0,32)){
    const bucket=obj(raw),fraction=bucket?.remaining_fraction;
    if(!BUCKET.test(id)||typeof fraction!=="number"||!Number.isFinite(fraction)||
      fraction<0||fraction>1)continue;
    windows.push({
      id:"google-bucket:"+id,
      label:id.replace(/[-_:]+/g," ").slice(0,80),
      usedPercent:bucket?.disabled===true?100:clampPercent((1-fraction)*100),
      resetAt:safeDate(bucket?.reset_time,bucket?.reset_in_seconds,now),
    });
  }
  const ctx=obj(root.context_window),current=obj(ctx?.current_usage);
  const session=root.session_id??root.conversation_id;
  return {
    checkedAt:new Date(now).toISOString(),
    plan:typeof root.plan_tier==="string"&&root.plan_tier.length<=60?root.plan_tier:"Antigravity",
    windows,
    sessionHash:typeof session==="string"&&session.length>0&&session.length<=256
      ?createHash("sha256").update(session).digest("hex"):null,
    input:count(ctx?.total_input_tokens),output:count(ctx?.total_output_tokens),
    cacheRead:count(current?.cache_read_input_tokens)??0,
    cacheWrite:count(current?.cache_creation_input_tokens)??0,
  };
}
const totalsOk=(v:unknown):v is TokenTotals=>{
  const o=obj(v);return !!o&&["inputTokens","outputTokens","cacheReadTokens","cacheWriteTokens","totalTokens"]
    .every(k=>count(o[k])!==null);
};
function isState(v:unknown):v is Stored{
  const s=obj(v),sessions=obj(s?.sessions),daily=obj(s?.daily);
  return !!s&&s.version===1&&typeof s.updatedAt==="string"&&typeof s.plan==="string"&&
    Array.isArray(s.windows)&&s.windows.length<=32&&s.windows.every((raw:unknown)=>{
      const w=obj(raw);return !!w&&typeof w.id==="string"&&w.id.startsWith("google-bucket:")&&
        typeof w.label==="string"&&typeof w.usedPercent==="number"&&w.usedPercent>=0&&
        w.usedPercent<=100&&(w.resetAt===null||typeof w.resetAt==="string");
    })&&!!sessions&&Object.keys(sessions).length<=MAX_SESSIONS&&
    Object.values(sessions).every(v=>{const o=obj(v);return !!o&&count(o.input)!==null&&count(o.output)!==null;})&&
    totalsOk(s.totals)&&!!daily&&Object.keys(daily).length<=MAX_DAYS&&
    Object.entries(daily).every(([k,v])=>/^\d{4}-\d{2}-\d{2}$/.test(k)&&totalsOk(v));
}
async function noLink(path:string):Promise<void>{
  try{const s=await lstat(path);if(s.isSymbolicLink()||(!s.isFile()&&!s.isDirectory()))throw Error("unsafe statusline file");}
  catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;}
}
function fileFor(id:string,root:string):string{
  if(!ACCOUNT.test(id))throw Error("invalid google account id");
  return join(root,id+".json");
}
async function readState(id:string,root:string):Promise<Stored|null>{
  const path=fileFor(id,root);await noLink(root);await noLink(path);
  try{
    if((await stat(path)).size>MAX_BYTES)return null;
    const data=await readFile(path,"utf8");
    if(Buffer.byteLength(data)>MAX_BYTES)return null;
    const parsed:unknown=JSON.parse(data);return isState(parsed)?parsed:null;
  }catch(e){
    if((e as NodeJS.ErrnoException).code==="ENOENT"||e instanceof SyntaxError)return null;
    throw e;
  }
}
const initial=():Stored=>({version:1,updatedAt:new Date(0).toISOString(),plan:"Antigravity",
  windows:[],sessions:Object.create(null) as Record<string,Counter>,totals:emptyTokenTotals(),
  daily:Object.create(null) as Record<string,TokenTotals>});
/** Serialized read/modify/write: repeated statusline ticks do not double-count tokens. */
export async function ingestGoogleStatusline(id:string,payload:unknown,
  root=getGoogleStatuslineRoot(),now=Date.now()):Promise<boolean>{
  const event=projectGoogleStatusline(payload,now);if(!event)return false;
  const path=fileFor(id,root);
  await mkdir(root,{recursive:true,mode:0o700});await noLink(root);await noLink(path);
  let lock:Awaited<ReturnType<typeof open>>|null=null;
  for(let i=0;i<35;i++){
    try{lock=await open(path+".lock","wx",0o600);break;}
    catch(e){if((e as NodeJS.ErrnoException).code!=="EEXIST")throw e;await delay(20);}
  }
  if(!lock)return false;
  try{
    const s=(await readState(id,root))??initial();
    s.updatedAt=event.checkedAt;s.plan=event.plan;
    s.windows=event.windows; // Missing quotas must not refresh older percentages as if current.
    if(event.sessionHash&&event.input!==null&&event.output!==null){
      const key=event.sessionHash,prev=s.sessions[key];
      if(prev||Object.keys(s.sessions).length<MAX_SESSIONS){
        const input=Math.max(prev?.input??0,event.input);
        const output=Math.max(prev?.output??0,event.output);
        const di=input-(prev?.input??0),do_=output-(prev?.output??0);
        if(di||do_){
          const date=new Date(now).toISOString().slice(0,10);
          if(s.daily[date]||Object.keys(s.daily).length<MAX_DAYS){
            const read=Math.min(event.cacheRead,di),write=Math.min(event.cacheWrite,di-read);
            const d:TokenTotals={inputTokens:di,outputTokens:do_,
              cacheReadTokens:read,cacheWriteTokens:write,totalTokens:di+do_};
            s.sessions[key]={input,output};
            s.totals=addTokenTotals(s.totals,d);
            s.daily[date]=addTokenTotals(s.daily[date]??emptyTokenTotals(),d);
          }
        }
      }
    }
    const temp=path+"."+randomUUID()+".tmp";
    try{
      const data=JSON.stringify(s);
      if(Buffer.byteLength(data)>MAX_BYTES)return false;
      const fd=await open(temp,"wx",0o600);
      try{await fd.writeFile(data,"utf8");}finally{await fd.close();}
      await rename(temp,path);
    }finally{await rm(temp,{force:true}).catch(()=>undefined);}
    return true;
  }finally{await lock.close();await rm(path+".lock",{force:true});}
}
export async function readGoogleStatusline(account:CollectorAccountConfig,
  root=getGoogleStatuslineRoot(),now=Date.now()):Promise<CollectorAccountResult>{
  const s=await readState(account.id,root).catch(()=>null);
  const ts=s?Date.parse(s.updatedAt):NaN;
  if(!s||!Number.isFinite(ts)||ts>now+60000||now-ts>FRESH_MS||s.windows.length===0)
    return {id:account.id,label:account.label,status:"unavailable",checkedAt:new Date(now).toISOString(),
      account:null,message:"Antigravity statusLine missing/stale. Open CLI with the QuotaOps statusline hook."};
  return {id:account.id,label:account.label,status:"ok",checkedAt:s.updatedAt,message:null,
    account:{id:account.id,label:account.label,provider:"google",plan:s.plan,windows:s.windows,updatedAt:s.updatedAt}};
}
export async function readGoogleTokenStates(accounts:CollectorAccountConfig[],
  root=getGoogleStatuslineRoot()):Promise<{totals:TokenTotals;daily:({date:string;provider:"google"}&TokenTotals)[];files:number}>{
  let totals=emptyTokenTotals(),files=0;
  const days=new Map<string,TokenTotals>();
  for(const account of accounts.filter(a=>a.enabled&&a.provider==="google")){
    const s=await readState(account.id,root).catch(()=>null);if(!s)continue;
    files++;totals=addTokenTotals(totals,s.totals);
    for(const [date,count] of Object.entries(s.daily))
      days.set(date,addTokenTotals(days.get(date)??emptyTokenTotals(),count));
  }
  return {totals,files,daily:[...days].sort(([a],[b])=>a.localeCompare(b))
    .map(([date,count])=>({date,provider:"google",...count}))};
}
