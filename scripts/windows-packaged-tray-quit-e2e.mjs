// Windows packaged E2E for the REAL System Tray -> Quit action (issue #47).
//
// Unlike `windows-packaged-startup-smoke.mjs --quit`, which calls app.quit()
// from a test timer with zero accounts, this opens the packaged app's own tray
// menu and invokes its "Quit" item (scripts/windows-tray-menu-invoke.ps1),
// optionally while a provider collection is in flight.
//
// Usage:
//   node scripts/windows-packaged-tray-quit-e2e.mjs [--cycles N]
//   node scripts/windows-packaged-tray-quit-e2e.mjs --scenario inflight --allow-provider-network
//
// Scenarios:
//   idle      zero accounts; collector idle at Quit.
//   inflight  one disposable, never-signed-in Claude profile inside the test
//             home; Quit is invoked while that collection runs. This makes an
//             unauthenticated page request to claude.ai, so it is opt-in.
//
// Never uses real profiles, tokens or ~/.quotaops; terminates only processes
// it started (the unpacked executable and browsers whose command line names
// its own temporary home).
import { execFile, execFileSync, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const scenario = option("--scenario") ?? "idle";
const cycles = Number(option("--cycles") ?? "1");
const allowNetwork = args.includes("--allow-provider-network");
if (!["idle", "inflight"].includes(scenario) || !Number.isInteger(cycles) || cycles < 1 || cycles > 20) {
  throw new Error("Usage: --scenario idle|inflight [--allow-provider-network] [--cycles 1..20]");
}
if (scenario === "inflight" && !allowNetwork) {
  throw new Error("The inflight scenario requests claude.ai anonymously; pass --allow-provider-network to opt in.");
}
if (process.platform !== "win32") throw new Error("Windows only.");

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const unpacked = join(root, "release", "windows", "win-unpacked");
const executable = join(unpacked, "QuotaOps.exe");
const trayDriver = join(root, "scripts", "windows-tray-menu-invoke.ps1");
const HOST = "127.0.0.1";
const PORT = 4317;
const QUIT_LATENCY_LIMIT_MS = 15_000;
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

for (const required of [executable, trayDriver, join(unpacked, "resources", "collector-runtime", "collector", "shutdown.ts")]) {
  if (!existsSync(required)) throw new Error(`Missing ${required}; rebuild the unpacked app first.`);
}

function portListening() {
  return new Promise((done) => {
    const socket = connect({ host: HOST, port: PORT });
    socket.setTimeout(800);
    socket.once("connect", () => { socket.destroy(); done(true); });
    socket.once("error", () => { socket.destroy(); done(false); });
    socket.once("timeout", () => { socket.destroy(); done(true); });
  });
}

/** Test-owned processes only: our executable path, or our temp home on the command line. */
function census(sandboxName) {
  const script =
    `$u='${unpacked.replace(/'/g, "''")}'.ToLower();` +
    `$p=Get-CimInstance Win32_Process;` +
    `$a=@($p|Where-Object{$_.ExecutablePath -and $_.ExecutablePath.ToLower().StartsWith($u)});` +
    `$b=@($p|Where-Object{($_.Name -eq 'chrome.exe' -or $_.Name -eq 'msedge.exe') -and $_.CommandLine -like '*${sandboxName}*'});` +
    `"$($a.Count)|$($b.Count)|$((@($a)+@($b)|ForEach-Object{$_.ProcessId}) -join ',')"`;
  const out = execFileSync("powershell.exe", ["-NoProfile", "-Command", script], { encoding: "utf8", windowsHide: true }).trim();
  const [app, browsers, pids] = out.split("|");
  return { app: Number(app), browsers: Number(browsers), pids: (pids ?? "").split(",").filter(Boolean) };
}

async function health(token) {
  try {
    const response = await fetch(`http://${HOST}:${PORT}/health`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: AbortSignal.timeout(1_200),
      redirect: "error",
    });
    if (response.status !== 200) return null;
    const body = await response.json();
    return body.status === "ok" && typeof body.collecting === "boolean" ? body : null;
  } catch {
    return null;
  }
}

async function runCycle(cycle) {
  if (await portListening()) throw new Error("Port 4317 is occupied; quit the other collector first.");
  const sandbox = await mkdtemp(join(tmpdir(), "quotaops-packaged-test-"));
  const sandboxName = basename(sandbox);
  const home = join(sandbox, "user");
  const roaming = join(sandbox, "Roaming");
  const smokeUserData = join(roaming, "QuotaOpsSmoke");
  const token = randomBytes(32).toString("base64url");
  const accounts = scenario === "inflight"
    ? [{
        id: "e2e-claude-1",
        label: "Disposable test profile",
        provider: "claude",
        profileDir: join(home, ".quotaops", "browser-profiles", "e2e-claude-1"),
        enabled: true,
      }]
    : [];
  await Promise.all([
    mkdir(join(home, ".quotaops"), { recursive: true }),
    mkdir(smokeUserData, { recursive: true }),
    mkdir(join(sandbox, "Local"), { recursive: true }),
    // Chrome stalls at launch when USERPROFILE points at an empty directory;
    // a real Windows profile always has these folders.
    mkdir(join(home, "AppData", "Local", "Temp"), { recursive: true }),
    mkdir(join(home, "AppData", "Roaming"), { recursive: true }),
  ]);
  await writeFile(join(home, ".quotaops", "collector.token"), token + "\n", { flag: "wx", mode: 0o600 });
  await writeFile(join(home, ".quotaops", "collector.json"), JSON.stringify({
    version: 1, port: PORT, pollIntervalSeconds: 300, tokenAnalyticsEnabled: false,
    tokenAnalyticsSources: { claudeCode: false, codex: false }, accounts,
  }) + "\n", { flag: "wx", mode: 0o600 });

  const env = {
    ...process.env,
    USERPROFILE: home,
    APPDATA: roaming,
    LOCALAPPDATA: join(sandbox, "Local"),
    QUOTAOPS_SMOKE_USER_DATA: smokeUserData,
    QUOTAOPS_STARTUP_DIAGNOSTICS: "1",
    QUOTAOPS_SMOKE_REQUEST_QUIT: "0",
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const probe = spawnSync(process.execPath, ["-p", "require('node:os').homedir()"], { env, encoding: "utf8", windowsHide: true });
  if (resolve(probe.stdout.trim()).toLowerCase() !== resolve(home).toLowerCase()) {
    throw new Error("USERPROFILE isolation preflight failed; refusing to launch.");
  }

  const marks = new Map();
  let exitedAt = null;
  let exitCode = null;
  const child = spawn(executable, [], { cwd: unpacked, env, stdio: ["ignore", "pipe", "pipe"] });
  child.on("exit", (code) => { exitedAt = Date.now(); exitCode = code; });
  let buffer = "";
  const onData = (chunk) => {
    buffer = (buffer + String(chunk)).slice(-16_384);
    for (const match of buffer.matchAll(/\[quotaops-startup\] ([a-z0-9_]+)/g)) {
      if (!marks.has(match[1])) marks.set(match[1], Date.now());
    }
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);

  const failures = [];
  let quitLatencyMs = null;
  let collectingAtQuit = null;
  try {
    const readyBy = Date.now() + 30_000;
    let state = null;
    while (Date.now() < readyBy && exitedAt === null) {
      state = await health(token);
      if (state && (scenario === "idle" || state.collecting)) break;
      await sleep(300);
    }
    if (!state) throw new Error("collector did not become healthy");
    // Let the in-flight browser get past launch into page work.
    if (scenario === "inflight") await sleep(2_500);
    collectingAtQuit = (await health(token))?.collecting ?? null;
    if (scenario === "inflight" && collectingAtQuit !== true) {
      failures.push("collection was not in flight when Quit was invoked");
    }

    const invokedAt = Date.now();
    const driver = await new Promise((done) => {
      execFile("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", trayDriver,
        "-TargetPid", String(child.pid), "-Item", "Quit"], { encoding: "utf8", windowsHide: true, timeout: 30_000 },
      (error, stdout) => done({ ok: !error, output: String(stdout).trim().split(/\r?\n/).pop() }));
    });
    if (!driver.ok) failures.push(`tray driver failed: ${driver.output}`);

    const exitBy = invokedAt + 30_000;
    while (exitedAt === null && Date.now() < exitBy) await sleep(100);
    await sleep(300);
    const clicked = marks.get("tray_quit_requested");
    if (exitedAt === null) failures.push("QuotaOps did not exit within 30 s of tray Quit");
    else if (clicked) quitLatencyMs = exitedAt - clicked;
    for (const required of ["tray_quit_requested", "before_quit", "collector_shutdown_posted",
      "collector_shutdown_completed", "electron_will_quit"]) {
      if (!marks.has(required)) failures.push(`missing lifecycle mark ${required}`);
    }
    if (marks.has("collector_shutdown_deadline")) failures.push("parent had to kill the collector (deadline)");
    if (exitCode !== null && exitCode !== 0) failures.push(`exit code ${exitCode}`);
    if (quitLatencyMs !== null && quitLatencyMs > QUIT_LATENCY_LIMIT_MS) {
      failures.push(`Quit took ${quitLatencyMs} ms (limit ${QUIT_LATENCY_LIMIT_MS})`);
    }
    await sleep(1_500);
    const left = census(sandboxName);
    if (left.app > 0) failures.push(`${left.app} QuotaOps process(es) left`);
    if (left.browsers > 0) failures.push(`${left.browsers} browser process(es) left`);
    if (await portListening()) failures.push("port 4317 still listening");
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  } finally {
    const left = census(sandboxName);
    for (const pid of left.pids) {
      try { execFileSync("taskkill.exe", ["/PID", pid, "/T", "/F"], { stdio: "ignore", windowsHide: true }); } catch {}
    }
    await sleep(800);
    if (!(await portListening())) await rm(sandbox, { recursive: true, force: true }).catch(() => undefined);
  }
  const summary = `cycle ${cycle}/${cycles} scenario=${scenario} collectingAtQuit=${collectingAtQuit} ` +
    `quitLatencyMs=${quitLatencyMs ?? "n/a"} marks=${[...marks.keys()].filter((m) => /quit|collector_shutdown|collector_exited/.test(m)).join(",")}`;
  return { summary, failures };
}

let failed = 0;
for (let cycle = 1; cycle <= cycles; cycle++) {
  const { summary, failures } = await runCycle(cycle);
  process.stdout.write(`${failures.length ? "FAIL" : "PASS"}: ${summary}\n`);
  for (const failure of failures) process.stdout.write(`  - ${failure}\n`);
  if (failures.length) failed++;
}
process.stdout.write(`${cycles - failed}/${cycles} tray-Quit cycles passed.\n`);
process.exitCode = failed ? 1 : 0;
