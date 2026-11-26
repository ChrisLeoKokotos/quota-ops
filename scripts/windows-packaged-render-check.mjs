// Windows rendering check for the packaged app: software rendering (the
// Windows default) versus GPU acceleration, at device scale 1, 1.5 and 2
// (`--force-device-scale-factor`, an emulation of high-DPI displays).
//
// Per run: startup time, a scripted wheel-scroll / resize / minimize-restore
// workload on the test-owned window (scripts/windows-render-probe.ps1), UI
// thread latency during it, whether frames are non-blank before and after,
// CPU used by the app's processes during the workload, and private memory.
// Isolated temporary home, zero accounts; only test-owned processes touched.
//
// Usage: node scripts/windows-packaged-render-check.mjs [--scales 1,1.5,2] [--modes software,gpu]
import { execFile, execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : fallback;
};
const scales = opt("--scales", "1,1.5,2").split(",").map(Number);
const modes = opt("--modes", "software,gpu").split(",");
if (!scales.every((s) => [1, 1.25, 1.5, 2].includes(s)) || !modes.every((m) => ["software", "gpu"].includes(m))) {
  throw new Error("scales must be from 1,1.25,1.5,2; modes from software,gpu");
}
if (process.platform !== "win32") throw new Error("Windows only.");
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const unpacked = join(root, "release", "windows", "win-unpacked");
const probe = join(root, "scripts", "windows-render-probe.ps1");
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const portOpen = () => new Promise((done) => {
  const s = connect({ host: "127.0.0.1", port: 4317 });
  s.setTimeout(800);
  s.once("connect", () => { s.destroy(); done(true); });
  s.once("error", () => { s.destroy(); done(false); });
  s.once("timeout", () => { s.destroy(); done(true); });
});
const ncpu = Number(execFileSync("powershell.exe", ["-NoProfile", "-Command", "[Environment]::ProcessorCount"], { encoding: "utf8" }).trim()) || 1;

function appTotals() {
  const script =
    `$u='${unpacked.replace(/'/g, "''")}'.ToLower();` +
    "$ids=@(Get-CimInstance Win32_Process|Where-Object{$_.ExecutablePath -and $_.ExecutablePath.ToLower().StartsWith($u)}|ForEach-Object{$_.ProcessId});" +
    "$cpu=0;$priv=0;foreach($id in $ids){$g=Get-Process -Id $id -ErrorAction SilentlyContinue;if($g){$cpu+=$g.TotalProcessorTime.TotalSeconds;$priv+=$g.PrivateMemorySize64}};" +
    "[string]::Format([Globalization.CultureInfo]::InvariantCulture,'{0}|{1}|{2}',$cpu,$priv,($ids -join ','))";
  const [cpu, priv, pids] = execFileSync("powershell.exe", ["-NoProfile", "-Command", script], { encoding: "utf8", windowsHide: true }).trim().split("|");
  return { cpu: Number(cpu), privMB: Number(priv) / 2 ** 20, pids: (pids ?? "").split(",").filter(Boolean) };
}

async function run(mode, scale) {
  if (await portOpen()) throw new Error("Port 4317 is occupied; refusing.");
  const sandbox = await mkdtemp(join(tmpdir(), "quotaops-packaged-test-"));
  const home = join(sandbox, "user");
  const roaming = join(sandbox, "Roaming");
  await Promise.all([
    mkdir(join(home, ".quotaops"), { recursive: true }),
    mkdir(join(roaming, "QuotaOpsSmoke"), { recursive: true }),
    mkdir(join(sandbox, "Local"), { recursive: true }),
    mkdir(join(home, "AppData", "Local", "Temp"), { recursive: true }),
  ]);
  await writeFile(join(home, ".quotaops", "collector.token"), randomBytes(32).toString("base64url") + "\n");
  await writeFile(join(home, ".quotaops", "collector.json"), JSON.stringify({
    version: 1, port: 4317, pollIntervalSeconds: 300, tokenAnalyticsEnabled: false,
    tokenAnalyticsSources: { claudeCode: false, codex: false }, accounts: [],
  }) + "\n");
  const env = {
    ...process.env, USERPROFILE: home, APPDATA: roaming, LOCALAPPDATA: join(sandbox, "Local"),
    QUOTAOPS_SMOKE_USER_DATA: join(roaming, "QuotaOpsSmoke"), QUOTAOPS_STARTUP_DIAGNOSTICS: "1",
    QUOTAOPS_SMOKE_REQUEST_QUIT: "0",
  };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.QUOTAOPS_HARDWARE_ACCELERATION;
  if (mode === "gpu") env.QUOTAOPS_HARDWARE_ACCELERATION = "1";
  const args = scale === 1 ? [] : [`--force-device-scale-factor=${scale}`];
  const t0 = Date.now();
  let windowReadyMs = null;
  const child = spawn(join(unpacked, "QuotaOps.exe"), args, { cwd: unpacked, env, stdio: ["ignore", "pipe", "pipe"] });
  const onData = (chunk) => {
    if (windowReadyMs === null && String(chunk).includes("[quotaops-startup] window_ready")) windowReadyMs = Date.now() - t0;
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  let result = { mode, scale };
  try {
    for (let i = 0; i < 60 && windowReadyMs === null; i++) await sleep(250);
    await sleep(4_000);
    const before = appTotals();
    const started = Date.now();
    const output = await new Promise((done) => execFile("powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", probe, "-TargetPid", String(child.pid)],
      { encoding: "utf8", windowsHide: true, timeout: 120_000 }, (_e, stdout) => done(String(stdout).trim())));
    const seconds = (Date.now() - started) / 1000;
    const after = appTotals();
    let probeResult;
    try { probeResult = JSON.parse(output.split(/\r?\n/).pop()); } catch { probeResult = { error: output.slice(0, 200) }; }
    result = {
      mode, scale, windowReadyMs,
      workloadSeconds: +seconds.toFixed(1),
      cpuPercentOfOneCore: +(((after.cpu - before.cpu) / seconds) * 100).toFixed(1),
      cpuPercentOfMachine: +(((after.cpu - before.cpu) / seconds / ncpu) * 100).toFixed(2),
      privateMB: { before: +before.privMB.toFixed(1), after: +after.privMB.toFixed(1) },
      ...probeResult,
    };
  } finally {
    for (const pid of [String(child.pid), ...appTotals().pids]) {
      try { execFileSync("taskkill.exe", ["/PID", pid, "/T", "/F"], { stdio: "ignore", windowsHide: true }); } catch {}
    }
    await sleep(1_200);
    if (!(await portOpen())) await rm(sandbox, { recursive: true, force: true }).catch(() => undefined);
  }
  return result;
}

const results = [];
for (const scale of scales) {
  for (const mode of modes) {
    const r = await run(mode, scale);
    results.push(r);
    process.stdout.write(JSON.stringify(r) + "\n");
  }
}
const blank = results.filter((r) => ["nonblankBefore", "nonblankAfterScroll", "nonblankAfterResize", "nonblankAfterRestore"]
  .some((k) => !(r[k] > 20)));
process.stdout.write(blank.length
  ? `FAIL: ${blank.length} run(s) produced a blank or uncapturable frame.\n`
  : `PASS: every run rendered non-blank frames before and after scroll, resize and minimize/restore.\n`);
process.exitCode = blank.length ? 1 : 0;
