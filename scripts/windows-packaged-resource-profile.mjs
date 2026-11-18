// Reproducible resource profile of the packaged Windows app (issue C).
//
// Launches the unpacked build in an isolated temporary home, samples every
// test-owned process by role (Electron main, renderer, GPU, other utility,
// collector utility, provider browser) and prints JSON lines plus a summary.
// Never reads real profiles; terminates only processes it started.
//
// Usage:
//   node scripts/windows-packaged-resource-profile.mjs --label idle --duration-s 300
//   node scripts/windows-packaged-resource-profile.mjs --label cycles --accounts 1 \
//        --poll-interval-s 30 --duration-s 330 --interval-s 5 --allow-provider-network
//   [--unpacked <dir>] [--hide-window-at-s N] [--out file.jsonl] [--disable-gpu]
//
// --accounts N creates N disposable, never-signed-in Claude profiles; each
// collection then makes an unauthenticated request to claude.ai (opt-in).
import { execFile, execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : fallback;
};
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const unpacked = resolve(opt("--unpacked", join(root, "release", "windows", "win-unpacked")));
const label = opt("--label", "profile");
const durationS = Number(opt("--duration-s", "300"));
const intervalS = Number(opt("--interval-s", "15"));
const accountsN = Number(opt("--accounts", "0"));
const pollS = Number(opt("--poll-interval-s", "300"));
const hideAtS = opt("--hide-window-at-s", null);
const out = opt("--out", null);
if (accountsN > 0 && !argv.includes("--allow-provider-network")) {
  throw new Error("--accounts > 0 requests claude.ai anonymously; pass --allow-provider-network.");
}
if (!(pollS >= 30) || !(durationS > 0) || !(intervalS >= 1) || accountsN < 0 || accountsN > 10) {
  throw new Error("invalid arguments");
}
if (process.platform !== "win32") throw new Error("Windows only.");
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const portOpen = () => new Promise((done) => {
  const s = connect({ host: "127.0.0.1", port: 4317 });
  s.setTimeout(800);
  s.once("connect", () => { s.destroy(); done(true); });
  s.once("error", () => { s.destroy(); done(false); });
  s.once("timeout", () => { s.destroy(); done(true); });
});
if (await portOpen()) throw new Error("Port 4317 is occupied; refusing.");

const sandbox = await mkdtemp(join(tmpdir(), "quotaops-packaged-test-"));
const sandboxName = basename(sandbox);
const home = join(sandbox, "user");
const roaming = join(sandbox, "Roaming");
const token = randomBytes(32).toString("base64url");
await Promise.all([
  mkdir(join(home, ".quotaops"), { recursive: true }),
  mkdir(join(roaming, "QuotaOpsSmoke"), { recursive: true }),
  mkdir(join(sandbox, "Local"), { recursive: true }),
  mkdir(join(home, "AppData", "Local", "Temp"), { recursive: true }),
  mkdir(join(home, "AppData", "Roaming"), { recursive: true }),
]);
await writeFile(join(home, ".quotaops", "collector.token"), token + "\n");
await writeFile(join(home, ".quotaops", "collector.json"), JSON.stringify({
  version: 1, port: 4317, pollIntervalSeconds: pollS, tokenAnalyticsEnabled: false,
  tokenAnalyticsSources: { claudeCode: false, codex: false },
  accounts: Array.from({ length: accountsN }, (_, i) => ({
    id: `profile-claude-${i + 1}`, label: `Disposable ${i + 1}`, provider: "claude",
    profileDir: join(home, ".quotaops", "browser-profiles", `profile-claude-${i + 1}`), enabled: true,
  })),
}) + "\n");

const env = {
  ...process.env, USERPROFILE: home, APPDATA: roaming, LOCALAPPDATA: join(sandbox, "Local"),
  QUOTAOPS_SMOKE_USER_DATA: join(roaming, "QuotaOpsSmoke"), QUOTAOPS_STARTUP_DIAGNOSTICS: "1",
  QUOTAOPS_SMOKE_REQUEST_QUIT: "0",
};
delete env.ELECTRON_RUN_AS_NODE;

const t0 = Date.now();
const marks = {};
// Experiment switch only (memory comparison); not a product setting.
const electronArgs = argv.includes("--disable-gpu") ? ["--disable-gpu"] : [];
const child = spawn(join(unpacked, "QuotaOps.exe"), electronArgs, { cwd: unpacked, env, stdio: ["ignore", "pipe", "pipe"] });
let buf = "";
const onData = (chunk) => {
  buf = (buf + String(chunk)).slice(-16_384);
  for (const m of buf.matchAll(/\[quotaops-startup\] ([a-z0-9_]+)/g)) marks[m[1]] ??= Date.now() - t0;
};
child.stdout.on("data", onData);
child.stderr.on("data", onData);

// One PowerShell call per sample: role, private bytes, working set, CPU
// seconds and handles for every test-owned process. No command lines or
// window titles are emitted.
const sampleScript =
  `$u='${unpacked.replace(/'/g, "''")}'.ToLower();` +
  `$all=Get-CimInstance Win32_Process;` +
  `$rows=foreach($p in $all){` +
  ` $role=$null; $cl=[string]$p.CommandLine;` +
  ` if($p.ExecutablePath -and $p.ExecutablePath.ToLower().StartsWith($u)){` +
  `  if($cl -notmatch '--type='){$role='main'}` +
  `  elseif($cl -match '--type=renderer'){$role='renderer'}` +
  `  elseif($cl -match '--type=gpu-process'){$role='gpu'}` +
  `  elseif($cl -match 'node\\.mojom\\.NodeService'){$role='collector'}` +
  `  elseif($cl -match '--type=crashpad-handler'){$role='crashpad'}` +
  `  else{$role='utility'} }` +
  ` elseif(($p.Name -eq 'chrome.exe' -or $p.Name -eq 'msedge.exe') -and $cl -like '*${sandboxName}*'){$role='browser'}` +
  ` if($role){ $g=Get-Process -Id $p.ProcessId -ErrorAction SilentlyContinue;` +
  `  if($g){ [pscustomobject]@{r=$role;pid=$p.ProcessId;priv=$g.PrivateMemorySize64;ws=$g.WorkingSet64;cpu=$g.TotalProcessorTime.TotalSeconds;h=$g.HandleCount} } } };` +
  `@($rows)|ConvertTo-Json -Compress`;
const sample = () => new Promise((done) => {
  execFile("powershell.exe", ["-NoProfile", "-Command", sampleScript], { encoding: "utf8", windowsHide: true, maxBuffer: 4 << 20 },
    (_e, stdout) => { try { const v = JSON.parse(String(stdout).trim() || "[]"); done(Array.isArray(v) ? v : [v]); } catch { done([]); } });
});
const health = async () => {
  try {
    const r = await fetch("http://127.0.0.1:4317/health", { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(1500) });
    return r.ok ? (await r.json()).collecting : null;
  } catch { return null; }
};

const roles = ["main", "renderer", "gpu", "utility", "collector", "browser"];
let previous = null;
const rows = [];
let hidden = false;
const ncpu = Number(execFileSync("powershell.exe", ["-NoProfile", "-Command", "[Environment]::ProcessorCount"], { encoding: "utf8" }).trim()) || 1;
while (Date.now() - t0 < durationS * 1000) {
  const at = Date.now();
  const procs = await sample();
  const collecting = await health();
  const byRole = Object.fromEntries(roles.map((r) => [r, { n: 0, privMB: 0, wsMB: 0, cpuS: 0, handles: 0 }]));
  for (const p of procs) {
    const b = byRole[p.r] ?? byRole.utility;
    b.n++; b.privMB += p.priv / 2 ** 20; b.wsMB += p.ws / 2 ** 20; b.cpuS += p.cpu; b.handles += p.h;
  }
  const totalPriv = roles.reduce((s, r) => s + byRole[r].privMB, 0);
  const totalWs = roles.reduce((s, r) => s + byRole[r].wsMB, 0);
  const totalCpu = roles.reduce((s, r) => s + byRole[r].cpuS, 0);
  // CPU% of whole machine across the sample interval (all cores = 100%).
  const cpuPct = previous ? Math.max(0, (totalCpu - previous.cpu) / ((at - previous.at) / 1000) / ncpu * 100) : null;
  previous = { at, cpu: totalCpu };
  const row = {
    label, tS: +((at - t0) / 1000).toFixed(1), collecting,
    totalPrivMB: +totalPriv.toFixed(1), totalWsMB: +totalWs.toFixed(1),
    cpuPct: cpuPct === null ? null : +cpuPct.toFixed(2),
    roles: Object.fromEntries(roles.map((r) => [r, { n: byRole[r].n, privMB: +byRole[r].privMB.toFixed(1), handles: byRole[r].handles }])),
  };
  rows.push(row);
  const line = JSON.stringify(row);
  process.stdout.write(line + "\n");
  if (out) await appendFile(out, line + "\n");
  if (hideAtS !== null && !hidden && (Date.now() - t0) / 1000 >= Number(hideAtS)) {
    hidden = true;
    // Close the test window through UI Automation: QuotaOps hides to tray.
    const ps = "Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes;" +
      `$c=New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty,${child.pid});` +
      "foreach($w in [System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children,$c)){" +
      "$p=$null;if($w.TryGetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern,[ref]$p)){$p.Close();'closed'}}";
    execFileSync("powershell.exe", ["-NoProfile", "-Command", ps], { encoding: "utf8", windowsHide: true });
    process.stdout.write(`{"event":"window_closed_to_tray","tS":${((Date.now() - t0) / 1000).toFixed(1)}}\n`);
  }
  const wait = intervalS * 1000 - (Date.now() - at);
  if (wait > 0) await sleep(wait);
}

const pick = (f) => rows.map(f).filter((v) => typeof v === "number");
const summary = {
  label, samples: rows.length, startupMarksMs: { collector_listening: marks.collector_listening, window_ready: marks.window_ready },
  totalPrivMB: { first: rows[0]?.totalPrivMB, last: rows.at(-1)?.totalPrivMB, max: Math.max(...pick((r) => r.totalPrivMB)) },
  collectorPrivMB: { first: rows[0]?.roles.collector.privMB, last: rows.at(-1)?.roles.collector.privMB, max: Math.max(...pick((r) => r.roles.collector.privMB)) },
  browserPrivMBMax: Math.max(0, ...pick((r) => r.roles.browser.privMB)),
  maxBrowserProcesses: Math.max(0, ...pick((r) => r.roles.browser.n)),
  cpuPct: { mean: +(pick((r) => r.cpuPct).reduce((a, b) => a + b, 0) / Math.max(1, pick((r) => r.cpuPct).length)).toFixed(2), max: Math.max(0, ...pick((r) => r.cpuPct)) },
  idleCpuPctMean: (() => { const v = rows.filter((r) => r.collecting === false && r.roles.browser.n === 0).map((r) => r.cpuPct).filter((x) => typeof x === "number"); return v.length ? +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(2) : null; })(),
  handles: { first: rows[0] && roles.reduce((s, r) => s + rows[0].roles[r].handles, 0), last: rows.at(-1) && roles.reduce((s, r) => s + rows.at(-1).roles[r].handles, 0) },
};
process.stdout.write("SUMMARY " + JSON.stringify(summary) + "\n");

// Quit through the app's own path is covered by the tray E2E; here the test
// only needs its own processes gone.
const left = (await sample()).map((p) => String(p.pid));
for (const pid of [String(child.pid), ...left]) {
  try { execFileSync("taskkill.exe", ["/PID", pid, "/T", "/F"], { stdio: "ignore", windowsHide: true }); } catch {}
}
await sleep(1500);
if (!(await portOpen())) await rm(sandbox, { recursive: true, force: true }).catch(() => undefined);
