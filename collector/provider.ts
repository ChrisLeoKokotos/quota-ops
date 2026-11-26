import { readGoogleStatusline } from "./google-statusline.ts";
import type {
  CollectorAccountConfig,
  CollectorAccountResult,
} from "./types.ts";
import {
  collectClaudeUsageFromBrowser,
  openClaudeLogin,
} from "./browser.ts";
import {
  collectOpenAIUsageFromBrowser,
  openOpenAILogin,
} from "./openai.ts";

export async function openProviderLogin(
  account: CollectorAccountConfig,
): Promise<void> {
  if (account.provider === "google") {
    throw new Error("Google uses the Antigravity CLI statusLine, not browser login.");
  }
  if (account.provider === "openai") {
    await openOpenAILogin(account);
    return;
  }

  await openClaudeLogin(account);
}

export async function collectProviderUsage(
  account: CollectorAccountConfig,
  options: { visible?: boolean; signal?: AbortSignal | undefined } = {},
): Promise<CollectorAccountResult> {
  if (account.provider === "google") {
    return await readGoogleStatusline(account);
  }
  if (account.provider === "openai") {
    return await collectOpenAIUsageFromBrowser(account, {
      visible: options.visible === true,
      signal: options.signal,
    });
  }

  return await collectClaudeUsageFromBrowser(account, options);
}
