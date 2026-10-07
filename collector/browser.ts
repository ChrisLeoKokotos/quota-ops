import { spawn, type ChildProcess } from "node:child_process";
import { access } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";

import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";

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
    "Could not find an installed Chrome or Edge browser for Claude collection.",
  );
}

async function waitForEnter(): Promise<void> {
  await new Promise<void>((resolve) => {
    process.stdin.resume();
    process.stdin.once("data", () => {
      process.stdin.pause();
      resolve();
    });
  });
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
      "--disable-background-mode",
      CLAUDE_USAGE_URL,
    ],
    {
      detached: true,
      stdio: "ignore",
      windowsHide: false,
    },
  );

  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  child.unref();

  process.stdout.write(
    [
      "",
      `Opened the isolated system-browser profile for ${account.label}.`,
      "Complete Claude's normal login and any provider verification in that window.",
      "When Settings > Usage is visible, close that browser window completely.",
      "Then return here and press Enter.",
      "",
    ].join("\n"),
  );

  await waitForEnter();
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

async function reserveLoopbackPort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not reserve a loopback DevTools port."));
        return;
      }

      const port = address.port;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

async function waitForDevToolsEndpoint(
  port: number,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const url = `http://127.0.0.1:${port}/json/version`;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, {
        method: "GET",
        cache: "no-store",
        signal: AbortSignal.timeout(500),
      });
      if (response.ok) return;
    } catch {
      // The browser may still be starting.
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error("devtools_not_ready");
}

async function stopSpawnedBrowser(
  browser: Browser | null,
  child: ChildProcess | null,
): Promise<void> {
  if (browser) {
    await browser.close().catch(() => undefined);
  }

  if (child && child.exitCode === null && !child.killed) {
    child.kill();
  }
}

async function launchWindowsCollectionBrowser(
  account: CollectorAccountConfig,
): Promise<{ browser: Browser; context: BrowserContext; child: ChildProcess }> {
  await assertSafeProfileDirectory(account.profileDir);

  const executablePath = await findWindowsBrowserExecutable();
  const port = await reserveLoopbackPort();

  const child = spawn(
    executablePath,
    [
      `--user-data-dir=${account.profileDir}`,
      "--remote-debugging-address=127.0.0.1",
      `--remote-debugging-port=${port}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--disable-background-mode",
      "--headless=new",
      "about:blank",
    ],
    {
      detached: false,
      stdio: "ignore",
      windowsHide: true,
    },
  );

  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", () => reject(new Error("browser_spawn_failed")));
  });

  try {
    await waitForDevToolsEndpoint(port);
  } catch {
    if (child.exitCode === null && !child.killed) {
      child.kill();
    }
    throw new Error("devtools_not_ready");
  }

  try {
    const browser = await chromium.connectOverCDP(
      `http://127.0.0.1:${port}`,
      { timeout: 10_000 },
    );
    const context = browser.contexts()[0];
    if (!context) {
      await browser.close().catch(() => undefined);
      throw new Error("profile_context_missing");
    }

    return { browser, context, child };
  } catch (error) {
    if (child.exitCode === null && !child.killed) {
      child.kill();
    }
    if (error instanceof Error && error.message === "profile_context_missing") {
      throw error;
    }
    throw new Error("devtools_connect_failed");
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

function isLoginLocation(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== "claude.ai") return false;
    return (
      parsed.pathname.includes("/login") ||
      parsed.pathname.includes("/oauth") ||
      parsed.pathname.includes("/onboarding")
    );
  } catch {
    return false;
  }
}

async function collectFromContext(
  account: CollectorAccountConfig,
  context: BrowserContext,
): Promise<CollectorAccountResult> {
  const page = context.pages()[0] ?? (await context.newPage());
  const payloadPromise = waitForUsagePayload(page, 15_000);

  await page.goto(CLAUDE_USAGE_URL, {
    waitUntil: "domcontentloaded",
    timeout: 30_000,
  });

  const payload = await payloadPromise;
  const currentUrl = page.url();

  if (isLoginLocation(currentUrl)) {
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
      "Complete Claude's normal login and any provider verification in that window.",
      "When Settings > Usage is visible, return here and press Enter.",
      "",
    ].join("\n"),
  );

  await waitForEnter();
  await context.close();
}

export async function collectClaudeUsageFromBrowser(
  account: CollectorAccountConfig,
): Promise<CollectorAccountResult> {
  if (process.platform === "win32") {
    let browser: Browser | null = null;
    let child: ChildProcess | null = null;

    try {
      const launched = await launchWindowsCollectionBrowser(account);
      browser = launched.browser;
      child = launched.child;
      return await collectFromContext(account, launched.context);
    } catch (error) {
      const reason =
        error instanceof Error &&
        [
          "browser_spawn_failed",
          "devtools_not_ready",
          "devtools_connect_failed",
          "profile_context_missing",
        ].includes(error.message)
          ? error.message
          : "collection_failed";

      return result(
        account,
        "unavailable",
        `Local browser collector is unavailable (${reason}).`,
      );
    } finally {
      await stopSpawnedBrowser(browser, child);
    }
  }

  let context: BrowserContext | null = null;

  try {
    context = await launchProfile(account, true);
    return await collectFromContext(account, context);
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
