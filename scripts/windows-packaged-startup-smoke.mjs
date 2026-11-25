// Windows-only packaged-runtime startup smoke, WITHOUT touching real QuotaOps
// profiles. Spawns the unpacked executable under an isolated temporary home
// with zero provider accounts and verifies the bundled collector starts.
// On completion, terminates only the process tree spawned by this test.
//
// Usage: node scripts/windows-packaged-startup-smoke.mjs [--quit | --advisor] [--installed]
// --advisor uses five synthetic Antigravity statusLine inputs (no provider network).
// --installed is restricted to a disposable GitHub-hosted Windows CI job.
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "node:net";

const args = process.argv.slice(2);
const testQuit = args.includes("--quit");
const testAdvisor = args.includes("--advisor");
const installed = args.includes("--installed");
if (new Set(args).size !== args.length || args.some(a => !["--quit", "--advisor", "--installed"].includes(a)) ||
    (testQuit && testAdvisor)) {
  throw new Error("Usage: [--quit | --advisor] [--installed]");
}
if (installed && (process.env.GITHUB_ACTIONS !== "true" || process.env.RUNNER_ENVIRONMENT !== "github-hosted" || !process.env.LOCALAPPDATA)) {
  throw new Error("--installed requires a disposable GitHub-hosted runner");
}
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const appDir = installed ? join(process.env.LOCALAPPDATA, "Programs", "QuotaOps") :
  join(root, "release", "windows", "win-unpacked");
const executable = join(appDir, "QuotaOps.exe");
const resourceRoot = join(appDir, "resources");
const HOST = "127.0.0.1";
const PORT = 4317;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

if (process.platform !== "win32") {
  throw new Error("This packaged runtime smoke requires interactive Windows.");
}

for (const relative of [
  "app.asar",
  "static-dist/index.html",
  "static-dist/csp-script-hashes.json",
  "collector-runtime/collector/service.ts",
  "collector-runtime/package.json",
  "collector-runtime/node_modules/playwright-core/package.json",
]) {
  if (!existsSync(join(resourceRoot, relative))) {
    throw new Error(`Missing packaged resource: ${relative}. Rebuild the installer first.`);
  }
}
if (!existsSync(executable)) {
  throw new Error("Missing win-unpacked/QuotaOps.exe; rebuild first.");
}

// Do NOT try to displace an actual collector or share its browser profiles.
// Port check is performed before creating or changing even the test sandbox.
async function isPortListening() {
  return await new Promise((resolve) => {
    const socket = connect({ host: HOST, port: PORT });
    socket.setTimeout(1200);
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", () => { socket.destroy(); resolve(false); });
    socket.once("timeout", () => { socket.destroy(); resolve(true); });
  });
}
if (await isPortListening()) {
  throw new Error("Port 4317 is occupied. Quit the existing collector from its own session before this isolated test.");
}

const sandbox = await mkdtemp(join(tmpdir(), "quotaops-packaged-test-"));
const userHome = join(sandbox, "user");
const appData = join(sandbox, "Roaming");
const localAppData = join(sandbox, "Local");
// Electron/Chromium's Windows profile may not follow APPDATA environment
// overrides. Explicitly select an isolated profile before the single-instance lock.
const smokeUserData = join(appData, "QuotaOpsSmoke");
const collectorHome = join(userHome, ".quotaops");
const token = randomBytes(32).toString("base64url");
let child = null;
let started = false;
let observedExit = null;
let combinedOutput = "";
let cleaned = false;

function capture(stream) {
  stream?.on("data", (chunk) => {
    // Keep only a bounded tail in memory. Never print raw collector
    // logs or browser/session payloads.
    combinedOutput = (combinedOutput + String(chunk)).slice(-12_000);
  });
}
function recordExit(code, signal) {
  observedExit = { code, signal };
}

try {
  await Promise.all([
    mkdir(collectorHome, { recursive: true }),
    mkdir(smokeUserData, { recursive: true }),
    mkdir(localAppData, { recursive: true }),
  ]);
  await writeFile(join(collectorHome, "collector.token"), token + "\n", { flag: "wx", mode: 0o600 });
  const fixtures = [
    { id: "advisor-bottleneck", label: "Advisor bottleneck", short: 94, weekly: 0 },
    { id: "advisor-balanced", label: "Advisor balanced", short: 40, weekly: 40 },
    { id: "advisor-weekly", label: "Advisor weekly bottleneck", short: 0, weekly: 96 },
    { id: "advisor-missing", label: "Advisor missing reading" },
    { id: "advisor-exhausted", label: "Advisor exhausted", short: 100, weekly: 0 },
  ];
  const accounts = testAdvisor ? fixtures.map(f => ({
    id: f.id, label: f.label, provider: "google", enabled: true,
    profileDir: join(collectorHome, "browser-profiles", f.id),
  })) : [];
  await writeFile(join(collectorHome, "collector.json"), JSON.stringify({
    version: 1,
    port: PORT,
    pollIntervalSeconds: 300,
    tokenAnalyticsEnabled: false,
    tokenAnalyticsSources: { claudeCode: false, codex: false },
    accounts,
  }) + "\n", { flag: "wx", mode: 0o600 });

  const env = {
    ...process.env,
    USERPROFILE: userHome,
    APPDATA: appData,
    LOCALAPPDATA: localAppData,
    QUOTAOPS_SMOKE_USER_DATA: smokeUserData,
    // A Node-as-Electron development override would invalidate this test.
    QUOTAOPS_IPC_TRACE: "1",
    QUOTAOPS_STARTUP_DIAGNOSTICS: "1",
    QUOTAOPS_SMOKE_REQUEST_QUIT: testQuit ? "1" : "0",
  };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.QUOTAOPS_CSP_PROBE;

  // Fail closed BEFORE launching Electron unless the active Node runtime
  // confirms this child's home points to the isolated test directory.
  const homeProbe = spawnSync(process.execPath, [
    "-p", "require('node:os').homedir()",
  ], { env, encoding: "utf8", windowsHide: true, timeout: 8_000 });
  if (homeProbe.error || homeProbe.status !== 0 ||
      resolve(homeProbe.stdout.trim()).toLowerCase() !== resolve(userHome).toLowerCase()) {
    throw new Error("Windows USERPROFILE isolation preflight failed; refusing packaged launch");
  }

  if (testAdvisor) {
    // Exercise the actual packaged statusLine input path; no mock server,
    // credentials, provider calls, or modifications of runtime security.
    for (const fixture of fixtures) {
      if (fixture.short === undefined) continue;
      const now = Date.now();
      const hook = join(resourceRoot, "collector-runtime", "collector", "google-hook.ts");
      const event = {
        product: "antigravity", plan_tier: "Synthetic",
        quota: {
          "five-hour": { remaining_fraction: (100-fixture.short)/100, reset_time: new Date(now+4*3600000).toISOString() },
          weekly: { remaining_fraction: (100-fixture.weekly)/100, reset_time: new Date(now+3*86400000).toISOString() },
        },
      };
      const result = spawnSync(process.execPath, ["--experimental-strip-types", hook, fixture.id],
        { env, cwd: appDir, input: JSON.stringify(event), encoding: "utf8", windowsHide: true, timeout: 20_000 });
      if (result.status !== 0) throw new Error("Synthetic packaged statusLine input failed");
    }
  }
  child = spawn(executable, testAdvisor ? ["--force-renderer-accessibility"] : [], {
    cwd: dirname(executable),
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: false,
  });
  child.on("exit", recordExit);
  child.on("error", (error) => {
    observedExit = { code: "spawn_error", signal: error.code ?? "unknown" };
  });
  capture(child.stdout);
  capture(child.stderr);

  let healthy = false;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && observedExit === null) {
    try {
      const response = await fetch(`http://${HOST}:${PORT}/health`, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
        signal: AbortSignal.timeout(1200),
        redirect: "error",
      });
      if (response.status === 200) {
        const body = await response.json();
        if (body.status === "ok" && typeof body.collecting === "boolean") {
          healthy = true;
          break;
        }
      }
    } catch {
      // Collector may still be booting; never print response bodies.
    }
    await sleep(350);
  }

  if (!healthy || observedExit !== null) {
    throw new Error(
      `packaged application did not start its authenticated collector within 30 seconds` +
      (observedExit ? ` (exit: ${JSON.stringify(observedExit)})` : ""),
    );
  }

  if (testAdvisor) {
    // Wait for all five real collector results, including missing data. No
    // fake snapshot endpoint is injected. Then inspect the actual packaged
    // renderer using Windows UI Automation scoped to the spawned PID.
    let ready = false;
    const advisorDeadline = Date.now() + 45_000;
    while (Date.now() < advisorDeadline && observedExit === null) {
      try {
        const response = await fetch(`http://${HOST}:${PORT}/snapshot`, {
          headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
          signal: AbortSignal.timeout(1200), redirect: "error",
        });
        if (response.ok) {
          const body = await response.json();
          const byId = new Map((body.accounts ?? []).map(a => [a.id, a]));
          ready = body.accounts?.length === 5 &&
            fixtures.filter(f => f.short !== undefined).every(f => byId.get(f.id)?.status === "ok") &&
            byId.get("advisor-missing")?.status === "unavailable";
          if (ready) break;
        }
      } catch { /* not ready yet */ }
      await sleep(350);
    }
    if (!ready) throw new Error("Synthetic five-account collector did not settle");
    const driver = spawnSync("powershell.exe", ["-NoProfile", "-File",
      join(root, "scripts", "windows-advisor-uia.ps1"), "-TargetPid", String(child.pid)],
      { windowsHide: true, encoding: "utf8", timeout: 100_000 });
    if (driver.status !== 0 || !String(driver.stdout).includes("ADVISOR_UI_PASS")) {
      throw new Error("Packaged advisor UI Automation did not confirm the recommendation and headroom");
    }
    process.stdout.write("PASS: packaged collector -> authenticated IPC -> rendered Smart Account Advisor (five synthetic profiles, balanced account recommended).\n");
  }

  // A brief stable period distinguishes healthy startup from immediate exit.
  await sleep(3000);
  if (observedExit !== null && !testQuit) {
    throw new Error(`packaged application exited just after startup: ${JSON.stringify(observedExit)}`);
  }

  // Confirm environment isolation via the collector files in the test home.
  const cfg = JSON.parse(await readFile(join(collectorHome, "collector.json"), "utf8"));
  if (cfg.accounts?.length !== accounts.length || cfg.tokenAnalyticsEnabled !== false) {
    throw new Error("temporary collector settings unexpectedly changed");
  }

  if (testQuit) {
    // The tested app is the only process allowed to request its own Quit.
    // Never taskkill a real app or leave a test-owned collector listening.
    const quitDeadline = Date.now() + 30_000;
    while (Date.now() < quitDeadline && observedExit === null) await sleep(350);
    await sleep(200); // allow stdout diagnostics from the exiting Electron
    const marks = (name) => combinedOutput.includes(`[quotaops-startup] ${name}`);
    if (observedExit === null || observedExit.code !== 0 ||
        !marks("smoke_quit_requested") ||
        !marks("before_quit") ||
        !marks("collector_shutdown_posted") ||
        !marks("collector_shutdown_completed") ||
        !marks("electron_will_quit") ||
        marks("collector_shutdown_deadline")) {
      throw new Error("isolated Quit lifecycle did not complete cleanly");
    }
    for (let i = 0; i < 20 && await isPortListening(); i++) await sleep(250);
    if (await isPortListening()) {
      throw new Error("collector listener remains after test-owned Quit");
    }
  }

  started = true;
  process.stdout.write(
    (testQuit
      ? "PASS: packaged QuotaOps quit gracefully and closed its collector.\n"
      : "PASS: packaged QuotaOps stayed alive and started its authenticated collector.\n") +
    (testAdvisor ? "PASS: smoke used five synthetic provider profiles in an isolated temporary home.\n" :
      "PASS: smoke ran with zero provider accounts in an isolated temporary home.\n") +
    "No real session, browser profile, or QuotaOps configuration was used.\n",
  );
} catch (error) {
  process.exitCode = 1;
  const reason = error instanceof Error ? error.message : String(error);
  process.stderr.write(`FAIL: packaged runtime startup: ${reason}\n`);
  // Report only whitelisted diagnostic categories; never print the full
  // combined Electron output, which may contain user-controlled content.
  const safeStages = [...combinedOutput.matchAll(/\[quotaops-startup\] ([a-z0-9_]+)/g)]
    .slice(0, 25).map((match) => match[1]).join(",");
  process.stderr.write(`Startup stages: ${safeStages || "none"}\n`);
  process.stderr.write(`Diagnostic markers: ipc_snapshot=${/\[ipc\] snapshot/.test(combinedOutput)}; electron_error=${/uncaughtException|UnhandledPromiseRejection|ERR_/.test(combinedOutput)}\n`);
} finally {
  // The test owns the PID and uses a temporary profile with no accounts.
  // Terminate its process tree, including the utility child; do NOT kill
  // other QuotaOps/Chrome/Edge processes by name.
  if (child && child.pid && observedExit === null) {
    try {
      execFileSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        timeout: 15_000,
        windowsHide: true,
      });
    } catch {
      process.stderr.write("WARNING: could not terminate the test-owned process tree automatically.\n");
    }
  }
  // Never remove a temporary profile if its collector still owns the port.
  // Retain it for manual inspection; user data outside sandbox is untouched.
  await sleep(750);
  const stillListening = await isPortListening();
  if (!stillListening) {
    try {
      await rm(sandbox, { recursive: true, force: true });
      cleaned = true;
    } catch {
      process.stderr.write("WARNING: could not remove isolated smoke sandbox.\n");
    }
  }
  if (stillListening) {
    process.stderr.write("WARNING: collector listener remains on 4317; confirm and close the test-owned process before real QuotaOps use.\n");
    process.exitCode = 1;
  }
  if (!cleaned) {
    process.stderr.write("A temporary isolated smoke directory was retained; do not delete it until all test processes have exited.\n");
  }
}

if (started && !cleaned) {
  process.exitCode = 1;
}
