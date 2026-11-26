import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { chromium, type BrowserContext } from "playwright-core";

/**
 * QO-SEC-03 regression check for the browser process detector.
 *
 * The point is not that a browser opens and closes — the existing smoke test
 * covers that. The point is that the detector actually *sees* a QuotaOps-owned
 * browser while it is running. A detector that always reports zero would pass
 * a teardown check no matter how many processes were left behind, which is
 * exactly the defect this replaces.
 *
 * It launches a synthetic browser against a throwaway profile root, asserts
 * the detector finds it, closes it, and asserts the detector then reports
 * clean. No provider login, no credentials, no real profile.
 */

if (process.platform !== "win32") {
  throw new Error("This browser lifecycle check must run on Windows.");
}

const execFileAsync = promisify(execFile);
const detector = join(
  dirname(fileURLToPath(import.meta.url)),
  "windows-browser-processes.ps1",
);

interface DetectorResult {
  status: "CLEAN" | "RUNNING" | "INCONCLUSIVE";
  quotaOpsProcesses: number;
  browsersInspected: number;
  browsersNotInspected: number;
}

async function detect(profileRoot: string): Promise<DetectorResult> {
  try {
    const { stdout } = await execFileAsync("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      detector,
      "-ProfileRoot",
      profileRoot,
      "-Json",
    ]);
    return JSON.parse(stdout.trim()) as DetectorResult;
  } catch (error) {
    // Exit codes 1 and 2 are meaningful, not failures to run.
    const failure = error as { stdout?: string };
    if (failure.stdout) return JSON.parse(failure.stdout.trim()) as DetectorResult;
    throw error;
  }
}

const profileRoot = await mkdtemp(join(tmpdir(), "quotaops-lifecycle-"));
const profileDir = join(profileRoot, "synthetic");
let context: BrowserContext | null = null;

try {
  const before = await detect(profileRoot);
  assert.equal(
    before.quotaOpsProcesses,
    0,
    "no browser should be attributed to a profile root that has never been used",
  );

  for (const channel of ["chrome", "msedge"] as const) {
    try {
      context = await chromium.launchPersistentContext(profileDir, {
        channel,
        headless: true,
        chromiumSandbox: true,
        acceptDownloads: false,
        args: ["--disable-extensions"],
      });
      break;
    } catch {
      // Either installed supported browser is acceptable.
    }
  }
  if (!context) throw new Error("Neither Chrome nor Edge launched for the lifecycle check.");

  const during = await detect(profileRoot);
  if (during.status === "INCONCLUSIVE") {
    throw new Error(
      `Detector could not inspect ${during.browsersNotInspected} browser process(es). ` +
        "Re-run in a session able to read process command lines; an inconclusive run is not a pass.",
    );
  }
  assert.equal(
    during.quotaOpsProcesses > 0,
    true,
    "the detector must see a running browser launched against the QuotaOps profile root",
  );

  await context.close();
  context = null;

  // Chrome's helper processes exit slightly after the browser process.
  let after = await detect(profileRoot);
  for (let attempt = 0; attempt < 20 && after.quotaOpsProcesses > 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    after = await detect(profileRoot);
  }

  assert.equal(
    after.quotaOpsProcesses,
    0,
    `${after.quotaOpsProcesses} browser process(es) survived teardown`,
  );

  process.stdout.write(
    `PASS: detector saw ${during.quotaOpsProcesses} QuotaOps browser process(es) while running and 0 after teardown.\n`,
  );
} finally {
  await context?.close().catch(() => undefined);
  await rm(profileRoot, { recursive: true, force: true });
}
