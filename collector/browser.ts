import { chromium, type BrowserContext, type Page } from "playwright-core";

import type { CollectorAccountConfig, CollectorAccountResult } from "./types.ts";
import { parseClaudeUsagePayload } from "./usage-parser.ts";

const CLAUDE_USAGE_URL = "https://claude.ai/settings/usage";

async function launchProfile(
  account: CollectorAccountConfig,
  headless: boolean,
): Promise<BrowserContext> {
  const options = {
    headless,
    viewport: { width: 1280, height: 900 },
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
        const url = new URL(response.url());
        if (url.hostname !== "claude.ai" || !url.pathname.startsWith("/api/")) {
          return;
        }

        const contentType = response.headers()["content-type"] ?? "";
        if (!contentType.includes("application/json")) return;

        const payload: unknown = await response.json();
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
      "Log in to the intended Claude account in that window.",
      "When Settings > Usage is visible, return here and press Enter.",
      "",
    ].join("\n"),
  );

  await new Promise<void>((resolve) => {
    process.stdin.resume();
    process.stdin.once("data", () => resolve());
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
  } catch (error) {
    return result(
      account,
      "unavailable",
      error instanceof Error
        ? `Local collector error: ${error.message}`
        : "Local collector error.",
    );
  } finally {
    await context?.close().catch(() => undefined);
  }
}
