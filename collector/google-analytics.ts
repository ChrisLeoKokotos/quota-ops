import { addTokenTotals, type TokenAnalyticsSnapshot } from "../lib/token-analytics.ts";
import { readGoogleTokenStates } from "./google-statusline.ts";
import type { CollectorAccountConfig } from "./types.ts";

/**
 * Explicitly consented Google CLI token counters are merged with local Claude
 * and Codex counters. No Google raw payload is ever exposed by this function.
 */
export async function mergeGoogleAnalytics(
  base:TokenAnalyticsSnapshot, accounts:CollectorAccountConfig[], consent:boolean,
):Promise<TokenAnalyticsSnapshot>{
  const identity={source:"google-antigravity" as const,provider:"google" as const};
  if(!consent)
    return {...base,sources:[...base.sources,{...identity,state:"disabled" as const,files:0,
      message:"Google CLI token observations are not enabled."}]};
  const report=await readGoogleTokenStates(accounts);
  return {
    ...base,
    totals:addTokenTotals(base.totals,report.totals),
    providers:report.files
      ? [...base.providers,{provider:"google",totals:report.totals}]
      : base.providers,
    daily:[...base.daily,...report.daily],
    sources:[...base.sources,{...identity,
      state:report.files?"ok" as const:"not_found" as const,
      files:report.files,
      message:report.files?null:"No sanitized Google statusLine observations recorded."}],
  };
}
