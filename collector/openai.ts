import { chromium, type BrowserContext, type Page } from "playwright-core";

import { assertSafeProfileDirectory } from "./security.ts";
import type { CollectorAccountConfig, CollectorAccountResult } from "./types.ts";
import { parseOpenAIUsagePayload } from "./openai-usage-parser.ts";

const CHATGPT_HOME = "https://chatgpt.com/";

async function waitForEnter(): Promise<void> {
  await new Promise<void>((resolve) => {
    process.stdin.resume();
    process.stdin.once("data", () => {
      process.stdin.pause();
      resolve();
    });
  });
}

async function launchOpenAIProfile(
  account: CollectorAccountConfig,
  visible: boolean,
): Promise<BrowserContext> {
  await assertSafeProfileDirectory(account.profileDir);

  const options = {
    headless: false,
    viewport: { width: 1280, height: 900 },
    acceptDownloads: false,
    chromiumSandbox: true,
    args: visible
      ? ["--disable-extensions"]
      : [
          "--disable-extensions",
          "--start-minimized",
          "--window-position=-32000,-32000",
          "--window-size=1280,900",
        ],
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

async function fetchOpenAIUsage(page: Page): Promise<{
  payload: unknown | null;
  loginRequired: boolean;
  reason: string | null;
}> {
  try {
    return await page.evaluate(async () => {
      const decodeJwtPayload = (token: string): Record<string, unknown> => {
        try {
          const encoded = token.split(".")[1];
          if (!encoded) return {};
          const normalized = encoded.replace(/-/g, "+").replace(/_/g, "/");
          const padded = normalized.padEnd(
            normalized.length + ((4 - (normalized.length % 4)) % 4),
            "=",
          );
          return JSON.parse(atob(padded)) as Record<string, unknown>;
        } catch {
          return {};
        }
      };

      const sessionResponse = await fetch("/api/auth/session", {
        credentials: "include",
        cache: "no-store",
        headers: { Accept: "application/json" },
      });

      if (sessionResponse.status === 401 || sessionResponse.status === 403) {
        return {
          payload: null,
          loginRequired: true,
          reason: `session_http_${sessionResponse.status}`,
        };
      }

      if (!sessionResponse.ok) {
        return {
          payload: null,
          loginRequired: false,
          reason: `session_http_${sessionResponse.status}`,
        };
      }

      const session = (await sessionResponse.json()) as Record<string, unknown>;
      const accessToken =
        typeof session.accessToken === "string"
          ? session.accessToken
          : typeof session.access_token === "string"
            ? session.access_token
            : null;

      if (!accessToken) {
        return {
          payload: null,
          loginRequired: true,
          reason: "session_missing_access_token",
        };
      }

      const claims = decodeJwtPayload(accessToken);
      const authClaims =
        claims["https://api.openai.com/auth"] &&
        typeof claims["https://api.openai.com/auth"] === "object"
          ? (claims["https://api.openai.com/auth"] as Record<string, unknown>)
          : {};

      const sessionAccount =
        session.account && typeof session.account === "object"
          ? (session.account as Record<string, unknown>)
          : {};
      const sessionUser =
        session.user && typeof session.user === "object"
          ? (session.user as Record<string, unknown>)
          : {};

      const accountIdCandidates = [
        sessionAccount.id,
        session.accountId,
        session.account_id,
        sessionUser.accountId,
        sessionUser.account_id,
        authClaims.chatgpt_account_id,
        claims.chatgpt_account_id,
      ];
      const accountId = accountIdCandidates.find(
        (value): value is string =>
          typeof value === "string" && value.trim().length > 0,
      );

      const headers: Record<string, string> = {
        Accept: "application/json",
        Authorization: `Bearer ${accessToken}`,
      };
      if (accountId) headers["ChatGPT-Account-Id"] = accountId;

      const endpoints = [
        "/backend-api/codex/usage",
        "/backend-api/wham/usage",
        "/api/codex/usage",
      ];

      let lastReason: string | null = null;
      for (const endpoint of endpoints) {
        const response = await fetch(endpoint, {
          credentials: "include",
          cache: "no-store",
          headers,
        });

        if (response.status === 404) {
          lastReason = "usage_http_404";
          continue;
        }

        if (response.status === 401) {
          return {
            payload: null,
            loginRequired: true,
            reason: "usage_http_401",
          };
        }

        if (!response.ok) {
          lastReason = `usage_http_${response.status}`;
          continue;
        }

        const contentType = response.headers.get("content-type") ?? "";
        if (!contentType.toLowerCase().includes("application/json")) {
          lastReason = "usage_not_json";
          continue;
        }

        return {
          payload: (await response.json()) as unknown,
          loginRequired: false,
          reason: null,
        };
      }

      return {
        payload: null,
        loginRequired: false,
        reason: lastReason ?? "usage_unavailable",
      };
    });
  } catch {
    return {
      payload: null,
      loginRequired: false,
      reason: "usage_fetch_failed",
    };
  }
}

export async function openOpenAILogin(
  account: CollectorAccountConfig,
): Promise<void> {
  const context = await launchOpenAIProfile(account, true);
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(CHATGPT_HOME, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });

    process.stdout.write(
      [
        "",
        `Opened the isolated ChatGPT browser profile for ${account.label}.`,
        "Complete OpenAI's normal login and any verification in that window.",
        "Confirm chatgpt.com is signed in, then return here and press Enter.",
        "",
      ].join("\n"),
    );

    await waitForEnter();
  } finally {
    await context.close().catch(() => undefined);
  }
}

export async function collectOpenAIUsageFromBrowser(
  account: CollectorAccountConfig,
): Promise<CollectorAccountResult> {
  let context: BrowserContext | null = null;

  try {
    context = await launchOpenAIProfile(account, false);
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(CHATGPT_HOME, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });

    const fetched = await fetchOpenAIUsage(page);
    if (fetched.loginRequired) {
      return result(
        account,
        "login_required",
        "ChatGPT login is required for this local profile.",
      );
    }

    const parsed = fetched.payload
      ? parseOpenAIUsagePayload(fetched.payload)
      : null;

    if (!parsed) {
      return result(
        account,
        "unsupported",
        `Could not read OpenAI/Codex usage data (${fetched.reason ?? "unrecognized_usage"}).`,
      );
    }

    const checkedAt = new Date().toISOString();
    return result(account, "ok", null, checkedAt, {
      id: account.id,
      label: account.label,
      provider: "openai",
      plan: parsed.plan,
      windows: parsed.windows,
      updatedAt: checkedAt,
    });
  } catch {
    return result(
      account,
      "unavailable",
      "Local browser collector is unavailable for this OpenAI account.",
    );
  } finally {
    await context?.close().catch(() => undefined);
  }
}
