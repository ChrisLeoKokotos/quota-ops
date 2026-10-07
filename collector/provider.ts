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
  if (account.provider === "openai") {
    await openOpenAILogin(account);
    return;
  }

  await openClaudeLogin(account);
}

export async function collectProviderUsage(
  account: CollectorAccountConfig,
): Promise<CollectorAccountResult> {
  if (account.provider === "openai") {
    return await collectOpenAIUsageFromBrowser(account);
  }

  return await collectClaudeUsageFromBrowser(account);
}
