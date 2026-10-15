import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Readiness probe for the Windows launcher.
 *
 * The launcher previously reported success as soon as the dashboard returned
 * 200 on `/`. That only shows Next.js is serving its shell — the collector
 * terminal can have exited with an error and the launcher would still claim
 * the application started. This probe checks both services independently and
 * reports which one failed.
 *
 * The collector's bearer token is read from the user's own QuotaOps home and
 * used only as a request header. It is never printed, logged or included in
 * any message this script produces.
 */

const DASHBOARD_URL = "http://127.0.0.1:3000/";
const COLLECTOR_HEALTH_URL = "http://127.0.0.1:4317/health";
const ATTEMPT_TIMEOUT_MS = 1_500;
const RETRY_DELAY_MS = 1_000;

/** Overridable so the probe itself can be tested without a 45 second wait. */
function totalAttempts(): number {
  const raw = Number(process.env.QUOTAOPS_READINESS_ATTEMPTS ?? "");
  return Number.isInteger(raw) && raw > 0 ? raw : 45;
}

type ProbeResult = { ok: true } | { ok: false; reason: string };

function collectorTokenPath(): string {
  return join(homedir(), ".quotaops", "collector.token");
}

async function readCollectorToken(): Promise<string | null> {
  try {
    const token = (await readFile(collectorTokenPath(), "utf8")).trim();
    return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : null;
  } catch {
    return null;
  }
}

async function probeDashboard(): Promise<ProbeResult> {
  try {
    const response = await fetch(DASHBOARD_URL, {
      signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
    });
    return response.ok
      ? { ok: true }
      : { ok: false, reason: `dashboard returned HTTP ${response.status}` };
  } catch {
    return { ok: false, reason: "dashboard is not answering on 127.0.0.1:3000" };
  }
}

async function probeCollector(): Promise<ProbeResult> {
  const token = await readCollectorToken();
  if (!token) {
    return {
      ok: false,
      reason: "collector token file is missing or invalid; the collector has not started",
    };
  }

  try {
    const response = await fetch(COLLECTOR_HEALTH_URL, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
    });

    if (!response.ok) {
      return { ok: false, reason: `collector health returned HTTP ${response.status}` };
    }

    const payload = (await response.json()) as { status?: unknown };
    return payload.status === "ok"
      ? { ok: true }
      : { ok: false, reason: "collector health did not report status ok" };
  } catch {
    return { ok: false, reason: "collector is not answering on 127.0.0.1:4317" };
  }
}

async function main(): Promise<void> {
  let dashboard: ProbeResult = { ok: false, reason: "not probed" };
  let collector: ProbeResult = { ok: false, reason: "not probed" };

  const attempts = totalAttempts();

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    [dashboard, collector] = await Promise.all([
      probeDashboard(),
      probeCollector(),
    ]);
    if (dashboard.ok && collector.ok) {
      process.stdout.write("[QuotaOps] Dashboard and collector are both running.\n");
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
  }

  // Name the half that failed so the user knows which window to read.
  if (!dashboard.ok) {
    process.stdout.write(`[QuotaOps] Dashboard not ready: ${dashboard.reason}\n`);
  }
  if (!collector.ok) {
    process.stdout.write(`[QuotaOps] Collector not ready: ${collector.reason}\n`);
  }
  process.exitCode = 1;
}

await main();
