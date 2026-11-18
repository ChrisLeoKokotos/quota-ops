import { spawn } from "node:child_process";

import { findWindowsBrowserExecutable } from "./browser.ts";
import { assertSafeProfileDirectory } from "./security.ts";
import type { CollectorAccountConfig } from "./types.ts";

/**
 * Open an account's isolated profile in the normal, NON-automated browser so a
 * person can sign in or complete the provider's own human verification
 * (issue #49). This is the installed app's equivalent of the CLI login flow.
 *
 * - No Playwright, no DevTools pipe or port, no injected script: the provider
 *   sees an ordinary browser session, and the person does the verifying.
 * - Fixed executable search, a profile path validated under the protected
 *   profile root, and a fixed provider URL; nothing comes from the request.
 * - Nothing is read from the window. QuotaOps only learns when it closes.
 */
const PROVIDER_URL: Record<CollectorAccountConfig["provider"], string> = {
  claude: "https://claude.ai/settings/usage",
  openai: "https://chatgpt.com/",
};

export interface InteractiveProfile {
  /** Resolves when the browser process exits (the person closed it). */
  exited: Promise<void>;
  /** Close the window, e.g. when QuotaOps quits. */
  close(): void;
}

export async function openProfileForPerson(
  account: CollectorAccountConfig,
): Promise<InteractiveProfile> {
  if (process.platform !== "win32") throw new Error("interactive_profile_unsupported_platform");
  await assertSafeProfileDirectory(account.profileDir);
  const executable = await findWindowsBrowserExecutable();
  const child = spawn(
    executable,
    [
      `--user-data-dir=${account.profileDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      // Exit when the last window closes, so "closed" is observable.
      "--disable-background-mode",
      PROVIDER_URL[account.provider],
    ],
    { stdio: "ignore", windowsHide: false },
  );
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    child.once("error", () => resolve());
  });
  return {
    exited,
    close: () => {
      try { child.kill(); } catch { /* already closed */ }
    },
  };
}
