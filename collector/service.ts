import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { collectProviderUsage } from "./provider.ts";
import { loadCollectorConfig } from "./config.ts";
import {
  collectorTokenMatches,
  getOrCreateCollectorToken,
} from "./security.ts";
import type {
  CollectorAccountResult,
  CollectorSnapshotResponse,
} from "./types.ts";

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
  let collecting = false;

  const snapshot = (): CollectorSnapshotResponse => ({
    version: 1,
    generatedAt: new Date().toISOString(),
    accounts: results,
  });

  const refresh = async (): Promise<void> => {
    if (collecting) return;
    collecting = true;

    try {
      const current = await loadCollectorConfig();
      const enabled = current.accounts.filter((account) => account.enabled);
      const nextResults: CollectorAccountResult[] = [];

      for (const account of enabled) {
        nextResults.push(await collectProviderUsage(account));
      }

      results = nextResults;
    } finally {
      collecting = false;
    }
  };

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

    if (request.method !== "GET") {
      sendJson(request, response, 405, { error: "method_not_allowed" });
      return;
    }

    if (request.url === "/health") {
      sendJson(request, response, 200, {
        status: "ok",
        collecting,
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

  void refresh();
  const timer = setInterval(
    () => void refresh(),
    config.pollIntervalSeconds * 1000,
  );

  const shutdown = () => {
    clearInterval(timer);
    server.close(() => process.exit(0));
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `QuotaOps collector failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
