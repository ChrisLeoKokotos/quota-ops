import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { join } from "node:path";

import { chromium, type BrowserContext, type Page } from "playwright-core";

import { assertSafeProfileDirectory } from "./security.ts";
import type { CollectorAccountConfig, CollectorAccountResult } from "./types.ts";
import {
  looksLikeClaudeUsageUrl,
  parseClaudeUsagePayload,
  resolveClaudeUsageOrganizationIds,
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

async function preferredClaudeOrganizationId(
  context: BrowserContext,
): Promise<string | null> {
  try {
    const cookies = await context.cookies("https://claude.ai");
    const activeOrg = cookies.find((cookie) => cookie.name === "lastActiveOrg");
    if (!activeOrg?.value) return null;

    const decoded = decodeURIComponent(activeOrg.value);
    return /^[A-Za-z0-9_-]+$/.test(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

function claudeUsageOrganizationId(url: string): string | null {
  try {
    const parsed = new URL(url);
    const match =
      /^\/api\/organizations\/([A-Za-z0-9_-]+)\/usage\/?$/.exec(
        parsed.pathname,
      );

    if (
      parsed.protocol !== "https:" ||
      parsed.hostname !== "claude.ai" ||
      parsed.search !== "" ||
      parsed.hash !== "" ||
      !match
    ) {
      return null;
    }

    return match[1] ?? null;
  } catch {
    return null;
  }
}

function isClaudeOrganizationsUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === "https:" &&
      parsed.hostname === "claude.ai" &&
      parsed.pathname === "/api/organizations" &&
      parsed.search === "" &&
      parsed.hash === ""
    );
  } catch {
    return false;
  }
}

async function readJsonResponse(
  response: import("playwright-core").Response,
  maxBytes: number,
): Promise<unknown | null> {
  try {
    if (!response.ok()) return null;

    const contentType = (await response.headerValue("content-type")) ?? "";
    if (!contentType.toLowerCase().includes("application/json")) return null;

    const contentLength = await response.headerValue("content-length");
    if (
      contentLength &&
      Number.isFinite(Number(contentLength)) &&
      Number(contentLength) > maxBytes
    ) {
      return null;
    }

    const body = await response.body();
    if (body.byteLength > maxBytes) return null;

    return JSON.parse(body.toString("utf8")) as unknown;
  } catch {
    return null;
  }
}

async function collectUsageFromRealPageRequests(
  page: Page,
  preferredOrganizationId: string | null,
  timeoutMs = 10_000,
): Promise<{
  parsed: ReturnType<typeof parseClaudeUsagePayload>;
  reason: string | null;
}> {
  let organizationsPayload: unknown | null = null;
  const usageByOrganization = new Map<
    string,
    NonNullable<ReturnType<typeof parseClaudeUsagePayload>>
  >();

  const onResponse = async (response: import("playwright-core").Response) => {
    const url = response.url();

    if (isClaudeOrganizationsUrl(url)) {
      const payload = await readJsonResponse(response, 262_144);
      if (payload !== null) organizationsPayload = payload;
      return;
    }

    if (!looksLikeClaudeUsageUrl(url)) return;

    const organizationId = claudeUsageOrganizationId(url);
    if (!organizationId) return;

    const payload = await readJsonResponse(response, 65_536);
    if (payload === null) return;

    const parsed = parseClaudeUsagePayload(payload);
    if (parsed) usageByOrganization.set(organizationId, parsed);
  };

  page.on("response", onResponse);

  try {
    await page.goto(CLAUDE_USAGE_URL, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (
        preferredOrganizationId &&
        usageByOrganization.has(preferredOrganizationId)
      ) {
        return {
          parsed: usageByOrganization.get(preferredOrganizationId) ?? null,
          reason: null,
        };
      }

      if (!preferredOrganizationId) {
        const rankedOrganizationIds = resolveClaudeUsageOrganizationIds(
          organizationsPayload,
          null,
        );

        for (const organizationId of rankedOrganizationIds) {
          const parsed = usageByOrganization.get(organizationId);
          if (parsed) return { parsed, reason: null };
        }

        if (
          !organizationsPayload &&
          usageByOrganization.size === 1
        ) {
          return {
            parsed: usageByOrganization.values().next().value ?? null,
            reason: null,
          };
        }
      }

      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    if (preferredOrganizationId) {
      const rankedOrganizationIds = resolveClaudeUsageOrganizationIds(
        organizationsPayload,
        preferredOrganizationId,
      );

      for (const organizationId of rankedOrganizationIds) {
        const parsed = usageByOrganization.get(organizationId);
        if (parsed) return { parsed, reason: "preferred_usage_not_observed" };
      }

      if (usageByOrganization.size === 1) {
        return {
          parsed: usageByOrganization.values().next().value ?? null,
          reason: "preferred_usage_not_observed",
        };
      }
    }

    if (usageByOrganization.size > 0) {
      return {
        parsed: null,
        reason: "usage_org_ambiguous",
      };
    }

    if (organizationsPayload !== null) {
      return {
        parsed: null,
        reason: "usage_response_not_observed",
      };
    }

    return {
      parsed: null,
      reason: "claude_page_api_not_observed",
    };
  } finally {
    page.off("response", onResponse);
  }
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
  const preferredOrganizationId =
    await preferredClaudeOrganizationId(context);

  const collected = await collectUsageFromRealPageRequests(
    page,
    preferredOrganizationId,
  );

  const currentUrl = page.url();

  if (isLoginLocation(currentUrl)) {
    return result(
      account,
      "login_required",
      "Claude login is required for this local profile.",
    );
  }

  if (!collected.parsed) {
    return result(
      account,
      "unsupported",
      `Could not read the Usage response generated by Claude's own page (${collected.reason ?? "unknown"}). Open this profile manually and verify Settings > Usage is available.`,
    );
  }

  const checkedAt = new Date().toISOString();
  return result(account, "ok", null, checkedAt, {
    id: account.id,
    label: account.label,
    provider: "claude",
    plan: "Team",
    windows: [
      {
        id: "five-hour",
        label: "5-hour",
        ...collected.parsed.fiveHour,
      },
      {
        id: "weekly",
        label: "Weekly",
        ...collected.parsed.weekly,
      },
    ],
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
  try {
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
  } finally {
    await context.close().catch(() => undefined);
  }
}

/**
 * Launch Chrome/Edge over Playwright's private pipe instead of opening an
 * unauthenticated loopback DevTools HTTP port. The authenticated profile stays
 * on this machine and is always closed after each collection.
 *
 * The Windows headless path requires real-account E2E validation before
 * considering this a production release.
 */
export async function collectClaudeUsageFromBrowser(
  account: CollectorAccountConfig,
): Promise<CollectorAccountResult> {
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
