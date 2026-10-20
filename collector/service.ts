import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { collectProviderUsage } from "./provider.ts";
import { collectLocalTokenAnalytics } from "./token-analytics.ts";
import { MonitoringController } from "./monitoring.ts";
import { loadCollectorConfig } from "./config.ts";
import {
  collectorTokenMatches,
  getOrCreateCollectorToken,
} from "./security.ts";
import type {
  CollectorAccountResult,
  CollectorSnapshotResponse,
} from "./types.ts";
import type { TokenAnalyticsSnapshot } from "../lib/token-analytics.ts";

const HOST = "127.0.0.1";
const MAX_REQUESTS_PER_MINUTE = 120;

function sendJson(
  request: IncomingMessage,
  response: ServerResponse,
  status: number,
  value: unknown,
): void {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Cross-Origin-Resource-Policy", "same-site");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.end(JSON.stringify(value));
}

function suppliedBearerToken(request: IncomingMessage): string {
  const header = request.headers.authorization;
  if (!header?.startsWith("Bearer ")) return "";
  return header.slice("Bearer ".length).trim();
}

async function main(): Promise<void> {
  const config = await loadCollectorConfig();
  const collectorToken = await getOrCreateCollectorToken();
  let results: CollectorAccountResult[] = [];
  let tokenAnalytics: TokenAnalyticsSnapshot | null = null;
  // generatedAt is a provider collection timestamp, not the time a client
  // retrieved a cached /snapshot (which can be many minutes old).
  let generatedAt = new Date(0).toISOString();

  const monitoring = new MonitoringController(
    async (invalidated) => {
      const current = await loadCollectorConfig();
      const enabled = current.accounts.filter((account) => account.enabled);
      const nextResults: CollectorAccountResult[] = [];

      for (const account of enabled) {
        if (invalidated()) return null;
        nextResults.push(await collectProviderUsage(account));
      }
      if (invalidated()) return null;
      // Local private histories are read only with the stored consent.
      const nextTokens = current.tokenAnalyticsEnabled
        ? await collectLocalTokenAnalytics(current.tokenAnalyticsSources)
        : null;
      if (invalidated()) return null;
      return { nextResults, nextTokens };
    },
    (value, at) => {
      if (value === null) return;
      results = value.nextResults;
      tokenAnalytics = value.nextTokens;
      generatedAt = at;
    },
  );

  const snapshot = (): CollectorSnapshotResponse => ({
    version: 1,
    generatedAt,
    accounts: results,
    tokens: tokenAnalytics,
  });

  let rateWindowStartedAt = Date.now();
  let requestCount = 0;

  const server = createServer((request, response) => {
    const expectedHost = `${HOST}:${config.port}`;
    if (request.headers.host !== expectedHost) {
      sendJson(request, response, 400, { error: "invalid_host" });
      return;
    }

    if (request.headers.origin) {
      sendJson(request, response, 403, { error: "browser_direct_access_denied" });
      return;
    }

    if (!collectorTokenMatches(collectorToken, suppliedBearerToken(request))) {
      sendJson(request, response, 401, { error: "unauthorized" });
      return;
    }

    const now = Date.now();
    if (now - rateWindowStartedAt >= 60_000) {
      rateWindowStartedAt = now;
      requestCount = 0;
    }

    requestCount += 1;
    if (requestCount > MAX_REQUESTS_PER_MINUTE) {
      sendJson(request, response, 429, { error: "rate_limited" });
      return;
    }

    // Explicit POST operations require exactly the same authenticated
    // loopback boundary as reads. The renderer has no IPC method for them.
    if (request.method === "POST") {
      if (request.url === "/monitoring/pause") {
        monitoring.pause();
        sendJson(request, response, 200, { status: "ok", ...monitoring.status() });
        return;
      }
      if (request.url === "/monitoring/resume") {
        monitoring.resume();
        sendJson(request, response, 200, { status: "ok", ...monitoring.status() });
        return;
      }
      if (request.url === "/monitoring/refresh") {
        const queued = monitoring.queueRefresh();
        sendJson(request, response, queued ? 202 : 409, {
          status: queued ? "accepted" : "paused", ...monitoring.status(),
        });
        return;
      }
      sendJson(request, response, 404, { error: "not_found" });
      return;
    }

    if (request.method !== "GET") {
      sendJson(request, response, 405, { error: "method_not_allowed" });
      return;
    }

    if (request.url === "/health") {
      sendJson(request, response, 200, {
        status: "ok",
        ...monitoring.status(),
      });
      return;
    }

    if (request.url === "/snapshot") {
      sendJson(request, response, 200, snapshot());
      return;
    }

    sendJson(request, response, 404, { error: "not_found" });
  });

  server.requestTimeout = 5_000;
  server.headersTimeout = 5_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 32;

  server.listen(config.port, HOST, () => {
    process.stdout.write(
      `QuotaOps collector listening on http://${HOST}:${config.port}\n`,
    );
  });

  monitoring.queueRefresh();
  const timer = setInterval(
    () => monitoring.queueRefresh(),
    config.pollIntervalSeconds * 1000,
  );

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(timer);
    monitoring.stop();
    // A running Playwright browser must close through its normal finally
    // block before the utility process exits. Discard all in-flight results.
    void monitoring.waitUntilIdle().then(() => {
      server.close(() => {
        process.exitCode = 0;
      });
    }).catch(() => {
      process.exitCode = 1;
      server.close();
    });
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // The installed Electron app owns the collector utility process and asks it
  // to drain on Quit. The renderer has no access to this process channel.
  const utilityParent = (process as NodeJS.Process & {
    parentPort?: {
      on(event: "message", callback: (event: { data: unknown }) => void): void;
    };
  }).parentPort;
  utilityParent?.on("message", (event) => {
    const data = event.data;
    if (data && typeof data === "object" &&
        "action" in data && data.action === "shutdown") shutdown();
  });
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `QuotaOps collector failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
