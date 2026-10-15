import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { findLiveDashboard } from "../lib/dashboard-descriptor.ts";

/**
 * Readiness probe for the Windows launcher.
 *
 * Two things it deliberately does not do.
 *
 * It does not treat an HTTP 200 as proof that QuotaOps started. The dashboard
 * runs on a port the OS allocates at launch, so any given port may belong to
 * an unrelated process; the dashboard is confirmed by asking the listener to
 * echo the instance id recorded in the runtime descriptor.
 *
 * It does not treat a live dashboard as proof the collector is running. The
 * collector terminal can exit with an error while the dashboard serves its
 * shell perfectly well, so the collector is checked separately through its
 * authenticated health endpoint.
 *
 * On success the dashboard URL is printed on its own final line, so the batch
 * launcher reads the address rather than assuming one.
 *
 * The collector's bearer token is read from the user's own QuotaOps home and
 * used only as a request header. It is never printed, logged or included in
 * any message this script produces, including failures.
 */

const COLLECTOR_HEALTH_URL = "http://127.0.0.1:4317/health";
const ATTEMPT_TIMEOUT_MS = 1_500;
const RETRY_DELAY_MS = 1_000;

/** Overridable so the probe itself can be tested without a 45 second wait. */
function totalAttempts(): number {
  const raw = Number(process.env.QUOTAOPS_READINESS_ATTEMPTS ?? "");
  return Number.isInteger(raw) && raw > 0 ? raw : 45;
}

type ProbeResult = { ok: true; detail: string } | { ok: false; reason: string };

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
  const result = await findLiveDashboard();

  if (result.state === "absent") {
    return {
      ok: false,
      reason: "the dashboard has not published a runtime descriptor yet",
    };
  }
  if (result.state === "stale") {
    return { ok: false, reason: `dashboard not confirmed — ${result.reason}` };
  }

  const url = `http://127.0.0.1:${result.descriptor.port}/`;
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
    });
    return response.ok
      ? { ok: true, detail: url }
      : { ok: false, reason: `dashboard returned HTTP ${response.status}` };
  } catch {
    return { ok: false, reason: "dashboard is not answering on its allocated port" };
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
      ? { ok: true, detail: COLLECTOR_HEALTH_URL }
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
      // Last line, no prefix: the launcher reads this as the URL to open.
      process.stdout.write(`${dashboard.detail}\n`);
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
