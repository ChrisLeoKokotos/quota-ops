import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { collectClaudeUsageFromBrowser } from "./browser.ts";
import { loadCollectorConfig } from "./config.ts";
import type {
  CollectorAccountResult,
  CollectorSnapshotResponse,
} from "./types.ts";

const HOST = "127.0.0.1";
const ALLOWED_ORIGINS = new Set([
  "http://localhost:3000",
  "http://127.0.0.1:3000",
]);

function setCors(request: IncomingMessage, response: ServerResponse): void {
  const origin = request.headers.origin;
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Vary", "Origin");
  }
}

function sendJson(
  request: IncomingMessage,
  response: ServerResponse,
  status: number,
  value: unknown,
): void {
  setCors(request, response);
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.end(JSON.stringify(value));
}

async function main(): Promise<void> {
  const config = await loadCollectorConfig();
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
      results = await Promise.all(
        enabled.map((account) => collectClaudeUsageFromBrowser(account)),
      );
    } finally {
      collecting = false;
    }
  };

  const server = createServer((request, response) => {
    if (request.method === "OPTIONS") {
      setCors(request, response);
      response.statusCode = 204;
      response.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
      response.end();
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
        configuredAccounts: config.accounts.length,
      });
      return;
    }

    if (request.url === "/snapshot") {
      sendJson(request, response, 200, snapshot());
      return;
    }

    sendJson(request, response, 404, { error: "not_found" });
  });

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
