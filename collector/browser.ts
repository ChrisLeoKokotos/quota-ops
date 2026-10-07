import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { join } from "node:path";

import { chromium, type BrowserContext, type Page } from "playwright-core";

import { assertSafeProfileDirectory } from "./security.ts";
import type { CollectorAccountConfig, CollectorAccountResult } from "./types.ts";
import {
  looksLikeClaudeUsageUrl,
  parseClaudeUsagePayload,
} from "./usage-parser.ts";

const CLAUDE_USAGE_URL = "https://claude.ai/settings/usage";

async function findWindowsBrowserExecutable(): Promise<string> {
  const roots = [
    process.env.LOCALAPPDATA,
    process.env.PROGRAMFILES,
    process.env["PROGRAMFILES(X86)"],
  ].filter((value): value is string => Boolean(value));

  const candidates = [
    ...roots.map((root) =>
      join(root, "Google", "Chrome", "Application", "chrome.exe"),
    ),
    ...roots.map((root) =>
      join(root, "Microsoft", "Edge", "Application", "msedge.exe"),
    ),
  ];

  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next locally installed browser.
    }
  }

  throw new Error(
    "Could not find an installed Chrome or Edge browser for interactive Claude login.",
  );
}

async function openInteractiveWindowsLogin(
  account: CollectorAccountConfig,
): Promise<void> {
  await assertSafeProfileDirectory(account.profileDir);
  const executablePath = await findWindowsBrowserExecutable();

  const child = spawn(
    executablePath,
    [
      `--user-data-dir=${account.profileDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      CLAUDE_USAGE_URL,
    ],
    {
      detached: true,
      stdio: "ignore",
      windowsHide: false,
    },
  );

  await new Promise<void>((resolve, reject) => {
    child.once("spawn", () => resolve());
    child.once("error", reject);
  });
  child.unref();

  process.stdout.write(
    [
      "",
      `Opened the isolated system-browser profile for ${account.label}.`,
      "Complete Claude\'s normal login and any provider verification in that window.",
      "When Settings > Usage is visible, close that browser window completely.",
      "Then return here and press Enter.",
      "",
    ].join("\\n"),
  );

  await new Promise<void>((resolve) => {
    process.stdin.resume();
    process.stdin.once("data", () => {
      process.stdin.pause();
      resolve();
    });
  });
}

async function launchProfile(
  account: CollectorAccountConfig,
  headless: boolean,
): Promise<BrowserContext> {
  await assertSafeProfileDirectory(account.profileDir);

  const options = {
    headless,
    viewport: { width: 1280, height: 900 },
    acceptDownloads: false,
    chromiumSandbox: true,
    args: ["--disable-extensions"],
  };

  try {
    return await chromium.launchPersistentContext(account.profileDir, {
      ...options,
      channel: "chrome",
    });
  } catch (chromeError) {
    try {
      return await chromium.launchPersistentContext(account.profileDir, {
        ...options,
        channel: "msedge",
      });
    } catch {
      throw chromeError;
    }
  }
}

async function waitForUsagePayload(
  page: Page,
  timeoutMs: number,
): Promise<unknown | null> {
  return await new Promise((resolve) => {
    let settled = false;

    const finish = (value: unknown | null) => {
      if (settled) return;
      settled = true;
      page.off("response", onResponse);
      resolve(value);
    };

    const timer = setTimeout(() => finish(null), timeoutMs);

    const onResponse = async (response: import("playwright-core").Response) => {
      try {
        if (!looksLikeClaudeUsageUrl(response.url())) return;

        const contentType = (await response.headerValue("content-type")) ?? "";
        if (!contentType.toLowerCase().includes("application/json")) return;

        const contentLength = await response.headerValue("content-length");
        if (
          contentLength &&
          Number.isFinite(Number(contentLength)) &&
          Number(contentLength) > 65_536
        ) {
          return;
        }

        const body = await response.body();
        if (body.byteLength > 65_536) return;

        const payload: unknown = JSON.parse(body.toString("utf8"));
        if (!parseClaudeUsagePayload(payload)) return;

        clearTimeout(timer);
        finish(payload);
      } catch {
        // Ignore unrelated or unreadable responses.
      }
    };

    page.on("response", onResponse);
  });
}

function result(
  account: CollectorAccountConfig,
  status: CollectorAccountResult["status"],
  message: string | null,
  checkedAt = new Date().toISOString(),
  quotaAccount: CollectorAccountResult["account"] = null,
): CollectorAccountResult {
  return {
    id: account.id,
    label: account.label,
    status,
    account: quotaAccount,
    checkedAt,
    message,
  };
}

export async function openClaudeLogin(
  account: CollectorAccountConfig,
): Promise<void> {
  if (process.platform === "win32") {
    await openInteractiveWindowsLogin(account);
    return;
  }

  const context = await launchProfile(account, false);
  const page = context.pages()[0] ?? (await context.newPage());

  await page.goto(CLAUDE_USAGE_URL, {
    waitUntil: "domcontentloaded",
    timeout: 30_000,
  });

  process.stdout.write(
    [
      "",
      `Opened the isolated browser profile for ${account.label}.`,
      "Complete Claude\'s normal login and any provider verification in that window.",
      "When Settings > Usage is visible, return here and press Enter.",
      "",
    ].join("\\n"),
  );

  await new Promise<void>((resolve) => {
    process.stdin.resume();
    process.stdin.once("data", () => {
      process.stdin.pause();
      resolve();
    });
  });

  await context.close();
}

export async function collectClaudeUsageFromBrowser(
  account: CollectorAccountConfig,
): Promise<CollectorAccountResult> {
  let context: BrowserContext | null = null;

  try {
    context = await launchProfile(account, true);
    const page = context.pages()[0] ?? (await context.newPage());
    const payloadPromise = waitForUsagePayload(page, 15_000);

    await page.goto(CLAUDE_USAGE_URL, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });

    const payload = await payloadPromise;
    const currentUrl = page.url();

    if (
      currentUrl.includes("/login") ||
      currentUrl.includes("/oauth") ||
      currentUrl.includes("/onboarding")
    ) {
      return result(
        account,
        "login_required",
        "Claude login is required for this local profile.",
      );
    }

    const parsed = payload ? parseClaudeUsagePayload(payload) : null;
    if (!parsed) {
      return result(
        account,
        "unsupported",
        "Could not recognize Claude usage data. Open this profile manually and verify Settings > Usage is available.",
      );
    }

    const checkedAt = new Date().toISOString();
    return result(account, "ok", null, checkedAt, {
      id: account.id,
      label: account.label,
      provider: "claude",
      plan: "team",
      fiveHour: parsed.fiveHour,
      weekly: parsed.weekly,
      updatedAt: checkedAt,
    });
  } catch {
    return result(
      account,
      "unavailable",
      "Local browser collector is unavailable for this account.",
    );
  } finally {
    await context?.close().catch(() => undefined);
  }
}
