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
//   idle         zero accounts; collector idle at Quit.
//   inflight     one disposable, never-signed-in Claude profile inside the
//                test home; Quit is invoked while that collection runs.
//   after-error  same profile; Quit after its collection has ended in a
//                provider error (signed out), with the account held.
//   verify-path  same profile, held after its challenge/sign-in error: invokes the
//                tray's per-account item, checks that a NON-automated browser
//                opens, that automation stays off the profile while it is
//                open, and that the account is checked once after it closes.
//                Briefly shows a browser window on the desktop.
//   background-focus  same profile; while the scheduled (background)
//                collection runs (Windows: browser on a hidden desktop),
//                samples the foreground window owner and fails if a
//                test-owned browser ever owns it.
//   visible-consent  tray "Refresh with visible browser...": Cancel must open
//                nothing; after "Open browser windows" a visible browser runs,
//                and tray Quit is invoked while it is active. Shows a window.
//   lifecycle    window close -> hidden, tray "Open QuotaOps" -> shown, three
//                times; tray Pause / Resume reach the collector; then Quit.
//   crash-recovery  the collector process is killed; QuotaOps restarts it.
//   port-foreign another program holds 127.0.0.1:4317 at start; QuotaOps
//                explains it, stays usable and still quits cleanly.
//   main-killed  the main process is killed (Task Manager style); no
//                collector, browser or listener may survive it.
//   token-consent  synthetic Claude Code history with a known total in the
//                test home: tray "Turn on token analytics..." -> Cancel keeps
//                it off; -> "Turn on" saves consent and the snapshot carries
//                exactly that total (no prompt text); the dashboard shows the
//                token panel; tray "Token analytics: on (turn off)" -> off.
//   inflight, after-error, verify-path, background-focus and visible-consent
//   make an unauthenticated request to claude.ai (opt-in).
//
// Never uses real profiles, tokens or ~/.quotaops; terminates only processes
// it started (the unpacked executable and browsers whose command line names
// its own temporary home).
import { execFile, execFileSync, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
const installed = args.includes("--installed");
if (installed && (process.env.GITHUB_ACTIONS !== "true" || process.env.RUNNER_ENVIRONMENT !== "github-hosted" || !process.env.LOCALAPPDATA)) {
  throw new Error("--installed requires a disposable GitHub-hosted runner");
}
// The installed path is only needed for the credential-free consent scenario.
if (installed && scenario !== "token-consent") throw new Error("--installed supports token-consent only");
const SCENARIOS = ["idle", "inflight", "after-error", "verify-path", "background-focus", "visible-consent",
  "lifecycle", "crash-recovery", "port-foreign", "main-killed", "token-consent"];
// Scenarios that need no provider account and no network.
const OFFLINE_SCENARIOS = new Set(["idle", "lifecycle", "crash-recovery", "port-foreign", "main-killed", "token-consent"]);
if (!SCENARIOS.includes(scenario) || !Number.isInteger(cycles) || cycles < 1 || cycles > 20) {
  throw new Error(`Usage: --scenario ${SCENARIOS.join("|")} [--allow-provider-network] [--cycles 1..20]`);
}
if (!OFFLINE_SCENARIOS.has(scenario) && !allowNetwork) {
  throw new Error("This scenario requests claude.ai anonymously; pass --allow-provider-network to opt in.");
}
if (process.platform !== "win32") throw new Error("Windows only.");

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const unpacked = installed
  ? join(process.env.LOCALAPPDATA, "Programs", "QuotaOps")
  : join(root, "release", "windows", "win-unpacked");
const executable = join(unpacked, "QuotaOps.exe");
const trayDriver = join(root, "scripts", "windows-tray-menu-invoke.ps1");
const buttonDriver = join(root, "scripts", "windows-uia-invoke-button.ps1");
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
    // Browser main processes (no --type=): automated ones carry Playwright's
    // DevTools pipe; the person's verification window must not.
    `$m=@($b|Where-Object{$_.CommandLine -notmatch '--type='});` +
    `$auto=@($m|Where-Object{$_.CommandLine -match '--remote-debugging-pipe'});` +
    `$person=@($m|Where-Object{$_.CommandLine -notmatch '--remote-debugging-pipe'});` +
    `$headed=@($auto|Where-Object{$_.CommandLine -notmatch '--headless'});` +
    `"$($a.Count)|$($b.Count)|$((@($a)+@($b)|ForEach-Object{$_.ProcessId}) -join ',')|$($auto.Count)|$(($person|ForEach-Object{$_.ProcessId}) -join ',')|$($headed.Count)|$(($b|ForEach-Object{$_.ProcessId}) -join ',')"`;
  const out = execFileSync("powershell.exe", ["-NoProfile", "-Command", script], { encoding: "utf8", windowsHide: true }).trim();
  const [app, browsers, pids, automated, personPids, headed, browserPids] = out.split("|");
  return {
    app: Number(app),
    browsers: Number(browsers),
    pids: (pids ?? "").split(",").filter(Boolean),
    automatedBrowsers: Number(automated),
    personBrowserPids: (personPids ?? "").split(",").filter(Boolean),
    headedAutomatedBrowsers: Number(headed),
    browserPids: (browserPids ?? "").split(",").filter(Boolean),
  };
}

/**
 * Sample the foreground window's owning process every ~250 ms. Reports only
 * whether the owner is a test-owned browser (its command line names our temp
 * home) and the owner's process name otherwise; no titles, no content.
 */
function watchForeground(sandboxName, seconds) {
  const script =
    "Add-Type 'using System;using System.Runtime.InteropServices;public static class Fg{" +
    "[DllImport(\"user32.dll\")]public static extern IntPtr GetForegroundWindow();" +
    "[DllImport(\"user32.dll\")]public static extern uint GetWindowThreadProcessId(IntPtr h,out uint p);}';" +
    `$end=(Get-Date).AddSeconds(${seconds});` +
    "while((Get-Date) -lt $end){$h=[Fg]::GetForegroundWindow();$p=0;[void][Fg]::GetWindowThreadProcessId($h,[ref]$p);" +
    "$c=Get-CimInstance Win32_Process -Filter \"ProcessId=$p\" -ErrorAction SilentlyContinue;" +
    `if($c -and ([string]$c.CommandLine) -like '*${sandboxName}*'){'OWNED:'+$c.Name}elseif($c){'OTHER:'+$c.Name}else{'NONE'};` +
    "Start-Sleep -Milliseconds 250}";
  const child = spawn("powershell.exe", ["-NoProfile", "-Command", script], { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
  let output = "";
  child.stdout.on("data", (chunk) => { output += String(chunk); });
  const finished = new Promise((done) => child.on("exit", () => done()));
  return {
    stop: async () => {
      try { child.kill(); } catch {}
      await finished;
      return output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    },
  };
}

function invokeButton(pid, name) {
  return new Promise((done) => {
    execFile("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", buttonDriver,
      "-TargetPid", String(pid), "-Name", name], { encoding: "utf8", windowsHide: true, timeout: 30_000 },
    (error, stdout) => done({ ok: !error, output: String(stdout).trim().split(/\r?\n/).pop() }));
  });
}

/** Minimize test-owned browser windows so the scripted tray click can open the menu. */
function minimizeOwnedBrowsers(pids) {
  if (pids.length === 0) return;
  const script =
    "Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes;" +
    `foreach($id in @(${pids.join(",")})){` +
    "$c=New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty,[int]$id);" +
    "foreach($w in [System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children,$c)){" +
    "$p=$null;if($w.TryGetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern,[ref]$p)){" +
    "try{$p.SetWindowVisualState([System.Windows.Automation.WindowVisualState]::Minimized)}catch{}}}}";
  try { execFileSync("powershell.exe", ["-NoProfile", "-Command", script], { stdio: "ignore", windowsHide: true, timeout: 20_000 }); } catch {}
}

function invokeTrayItem(pid, item) {
  return new Promise((done) => {
    execFile("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", trayDriver,
      "-TargetPid", String(pid), "-Item", item], { encoding: "utf8", windowsHide: true, timeout: 45_000 },
    (error, stdout, stderr) => {
      const out = String(stdout).trim().split(/\r?\n/).pop() ?? "";
      const why = error ? (error.killed ? "driver timed out" : String(stderr).trim().split(/\r?\n/)[0] ?? "") : "";
      done({ ok: !error, output: [out, why].filter(Boolean).join(" | ").slice(0, 300) });
    });
  });
}

class MainKilledDone extends Error {}

/** The bundled collector's utility process (Node service) among test-owned processes. */
function utilityCollectorPid() {
  const script =
    `$u='${unpacked.replace(/'/g, "''")}'.ToLower();` +
    "$p=Get-CimInstance Win32_Process|Where-Object{$_.ExecutablePath -and $_.ExecutablePath.ToLower().StartsWith($u) -and ([string]$_.CommandLine) -match 'node\\.mojom\\.NodeService'};" +
    "($p|Select-Object -First 1).ProcessId";
  const out = execFileSync("powershell.exe", ["-NoProfile", "-Command", script], { encoding: "utf8", windowsHide: true }).trim();
  return out || null;
}

function mainWindowScript(pid, body) {
  return "Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes;" +
    `$c=New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty,${pid});` +
    "$w=[System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children,$c)|" +
    "Where-Object{$_.Current.Name -eq 'QuotaOps' -and $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Window}|Select-Object -First 1;" +
    body;
}

/** Close the test-owned QuotaOps window through UI Automation (no input). */
function setMainWindowState(pid, action) {
  if (action !== "close") return;
  const body = "if($w){$p=$null;if($w.TryGetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern,[ref]$p)){$p.Close()}}";
  try { execFileSync("powershell.exe", ["-NoProfile", "-Command", mainWindowScript(pid, body)], { stdio: "ignore", windowsHide: true, timeout: 20_000 }); } catch {}
}

function mainWindowVisible(pid) {
  const body = "if($w -and -not $w.Current.IsOffscreen){'visible'}else{'hidden'}";
  try {
    return execFileSync("powershell.exe", ["-NoProfile", "-Command", mainWindowScript(pid, body)], { encoding: "utf8", windowsHide: true, timeout: 20_000 }).trim() === "visible";
  } catch {
    return false;
  }
}

// Fixed-label, read-only UIA proof. Restrict lookup to the test-owned window.
async function waitForTokenOff(pid) {
  const body = "if($w){$c=New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty,'Token analytics is off.');" +
    "if($w.FindFirst([System.Windows.Automation.TreeScope]::Descendants,$c)){'OFF'}}";
  const until=Date.now()+30000;
  while(Date.now()<until){
    const found=await new Promise(resolve=>{
      execFile("powershell.exe",["-NoProfile","-Command",mainWindowScript(pid,body)],
        {windowsHide:true,timeout:5000},(error,stdout)=>resolve(!error&&stdout.trim()==="OFF"));
    });
    if(found)return true;
    await sleep(500);
  }
  return false;
}
const TOKEN_PROMPT = "PRIVATE E2E PROMPT that must never reach the snapshot";

async function snapshot(token) {
  try {
    const response = await fetch(`http://${HOST}:${PORT}/snapshot`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: AbortSignal.timeout(5_000),
      redirect: "error",
    });
    return response.status === 200 ? await response.json() : null;
  } catch {
    return null;
  }
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
  // port-foreign: a non-QuotaOps program owns the port before QuotaOps starts.
  let foreign = null;
  if (scenario === "port-foreign") {
    const { createServer } = await import("node:http");
    foreign = createServer((_request, response) => { response.statusCode = 404; response.end(); });
    await new Promise((resolve) => foreign.listen(PORT, HOST, resolve));
  }
  const sandbox = await mkdtemp(join(tmpdir(), "quotaops-packaged-test-"));
  const sandboxName = basename(sandbox);
  const home = join(sandbox, "user");
  const roaming = join(sandbox, "Roaming");
  const smokeUserData = join(roaming, "QuotaOpsSmoke");
  const token = randomBytes(32).toString("base64url");
  const accounts = !OFFLINE_SCENARIOS.has(scenario)
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
  if (scenario === "token-consent") {
    // One assistant message written twice (streaming duplicate): counts once.
    // 100 input + 50 output + 1000 cache read + 200 cache write = 1350.
    const project = join(home, ".claude", "projects", "e2e-project");
    await mkdir(project, { recursive: true });
    const message = {
      type: "assistant", uuid: "u-1", sessionId: "s-1", timestamp: new Date().toISOString(),
      message: { id: "msg_e2e_1", content: [{ type: "text", text: TOKEN_PROMPT }],
        usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200 } },
    };
    const user = { type: "user", uuid: "u-0", timestamp: new Date().toISOString(), message: { content: TOKEN_PROMPT } };
    await writeFile(join(project, "s-1.jsonl"), [user, message, message].map((r) => JSON.stringify(r)).join("\n") + "\n");
  }
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
    // Shape-only trace of what crosses IPC (counts and presence, no values).
    ...(scenario === "token-consent" ? { QUOTAOPS_IPC_TRACE: "1" } : {}),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const probe = spawnSync(process.execPath, ["-p", "require('node:os').homedir()"], { env, encoding: "utf8", windowsHide: true });
  if (resolve(probe.stdout.trim()).toLowerCase() !== resolve(home).toLowerCase()) {
    throw new Error("USERPROFILE isolation preflight failed; refusing to launch.");
  }

  const marks = new Map();
  let exitedAt = null;
  let exitCode = null;
  const child = spawn(executable, scenario === "token-consent" ? ["--force-renderer-accessibility"] : [], { cwd: unpacked, env, stdio: ["ignore", "pipe", "pipe"] });
  child.on("exit", (code) => { exitedAt = Date.now(); exitCode = code; });
  let buffer = "";
  let partialLine = "";
  const ipcTrace = [];
  const onData = (chunk) => {
    buffer = (buffer + String(chunk)).slice(-16_384);
    for (const match of buffer.matchAll(/\[quotaops-startup\] ([a-z0-9_]+)/g)) {
      if (!marks.has(match[1])) marks.set(match[1], Date.now());
    }
    const lines = (partialLine + String(chunk)).split(/\r?\n/);
    partialLine = lines.pop().slice(-4_096);
    for (const line of lines) {
      if (line.startsWith("[ipc] snapshot -> ")) ipcTrace.push(line);
    }
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);

  const failures = [];
  let quitLatencyMs = null;
  let collectingAtQuit = null;
  let focusSummary = "";
  let tokenDisplay = "";
  let driverRetries = 0;
  try {
    const readyBy = Date.now() + 30_000;
    let state = null;
    if (scenario === "port-foreign") {
      while (Date.now() < readyBy && exitedAt === null && !marks.has("collector_port_blocked")) await sleep(300);
      if (!marks.has("collector_exited_5")) failures.push("collector did not report the port as in use (exit 5)");
      if (!marks.has("collector_port_blocked")) failures.push("app did not explain that another program holds the port");
      if (exitedAt !== null) failures.push("QuotaOps exited instead of staying usable");
      state = { collecting: false };
    } else {
      while (Date.now() < readyBy && exitedAt === null) {
        state = await health(token);
        if (state && (OFFLINE_SCENARIOS.has(scenario) || state.collecting)) break;
        await sleep(300);
      }
    }
    if (!state) throw new Error("collector did not become healthy");
    if (scenario === "lifecycle") {
      for (let round = 1; round <= 3; round++) {
        setMainWindowState(child.pid, "close");
        await sleep(1_200);
        if (mainWindowVisible(child.pid)) failures.push(`round ${round}: closing the window did not hide it`);
        if (exitedAt !== null) { failures.push(`round ${round}: closing the window quit the app`); break; }
        const shown = await invokeTrayItem(child.pid, "Open QuotaOps");
        await sleep(1_200);
        if (!shown.ok || !mainWindowVisible(child.pid)) failures.push(`round ${round}: tray "Open QuotaOps" did not show the window`);
      }
      const paused = await invokeTrayItem(child.pid, "Pause monitoring");
      await sleep(1_500);
      if (!paused.ok || (await health(token))?.paused !== true) failures.push("tray Pause did not pause the collector");
      const resumed = await invokeTrayItem(child.pid, "Resume monitoring");
      await sleep(1_500);
      if (!resumed.ok || (await health(token))?.paused !== false) failures.push("tray Resume did not resume the collector");
      if (census(sandboxName).app < 3) failures.push("app processes missing after lifecycle steps");
    }
    if (scenario === "token-consent") {
      const consent = async () => JSON.parse(await readFile(join(home, ".quotaops", "collector.json"), "utf8")).tokenAnalyticsSources;
      const before = await snapshot(token);
      if (before?.tokens !== null) failures.push("token analytics ran before consent");
      if (before?.tokenStatus?.state !== "disabled") failures.push(`scan state before consent: ${before?.tokenStatus?.state}`);
      let opened = await invokeTrayItem(child.pid, "Turn on token analytics...");
      if (!opened.ok) throw new Error(`tray token item not available: ${opened.output}`);
      const cancelled = await invokeButton(child.pid, "Cancel");
      if (!cancelled.ok) throw new Error(`token dialog Cancel not found: ${cancelled.output}`);
      await sleep(2_000);
      if ((await consent()).claudeCode !== false || (await snapshot(token))?.tokens !== null) {
        failures.push("Cancel turned token analytics on");
      }
      opened = await invokeTrayItem(child.pid, "Turn on token analytics...");
      if (!opened.ok) throw new Error(`tray token item not available again: ${opened.output}`);
      const agreed = await invokeButton(child.pid, "Turn on");
      if (!agreed.ok) throw new Error(`token dialog "Turn on" not found: ${agreed.output}`);
      let body = null;
      for (let i = 0; i < 30; i++) {
        await sleep(500);
        body = await snapshot(token);
        if (body?.tokens) break;
      }
      const sources = await consent();
      if (sources.claudeCode !== true || sources.codex !== true) failures.push("consent was not saved after Turn on");
      const claudeSource = body?.tokens?.sources?.find?.((source) => source.source === "claude-code");
      if (!body?.tokens) failures.push("no token analytics after Turn on");
      else if (claudeSource?.state !== "ok") failures.push(`claude-code source state ${claudeSource?.state}`);
      if (body?.tokens && body.tokens.totals?.totalTokens !== 1350) {
        failures.push(`token total ${body.tokens.totals?.totalTokens} instead of 1350`);
      }
      if (JSON.stringify(body ?? {}).includes(TOKEN_PROMPT)) failures.push("prompt text reached the snapshot");
      if (body?.tokenStatus?.state !== "ready") failures.push(`scan state after Turn on: ${body?.tokenStatus?.state}`);
      // No account record in this fixture: all usage is explicitly unattributed.
      const rows = body?.tokens?.accounts ?? [];
      if (rows.length !== 1 || rows[0].account !== null || rows[0].attribution !== "no_account_record" ||
          rows[0].totals?.totalTokens !== 1350) failures.push("unattributed usage was not reported as such");
      // The renderer must RECEIVE the totals through IPC (the projection
      // once dropped every real token snapshot). Hide and show the window,
      // as a person would, so the dashboard reads the snapshot again; the
      // shape-only IPC trace says whether tokens crossed into the renderer.
      const traceStart = ipcTrace.length;
      setMainWindowState(child.pid, "close");
      await sleep(1_200);
      const shown = await invokeTrayItem(child.pid, "Open QuotaOps");
      if (!shown.ok) failures.push(`tray "Open QuotaOps" did not run: ${shown.output}`);
      let received = false;
      for (let i = 0; i < 40 && !received; i++) {
        await sleep(500);
        received = ipcTrace.slice(traceStart).some((line) => line.includes("tokens=present"));
      }
      if (!received) failures.push("the dashboard did not receive token analytics through IPC after Turn on");
      else tokenDisplay = " rendererTokens=present total=1350";
      const offTraceStart = ipcTrace.length;
      const off = await invokeTrayItem(child.pid, "Token analytics: on (turn off)");
      if (!off.ok) failures.push(`tray "turn off" item not available: ${off.output}`);
      await sleep(2_000);
      const after = await snapshot(token);
      if ((await consent()).claudeCode !== false || after?.tokens !== null || after?.tokenStatus?.state !== "disabled") {
        failures.push("turning token analytics off did not stop it");
      }
      if (!await waitForTokenOff(child.pid)) failures.push("installed renderer did not show token analytics off");
      const until=Date.now()+15000;
      while(Date.now()<until && !ipcTrace.slice(offTraceStart).some(line=>line.includes("tokens=none"))) await sleep(500);
      if (!ipcTrace.slice(offTraceStart).some(line=>line.includes("tokens=none"))) {
        failures.push("renderer did not receive a token-free IPC snapshot after revoke");
      }
      // Once the UI confirms off, any subsequent delivered snapshot must stay
      // token-free. This uses actual native IPC, not a Playwright mock bridge.
      const offConfirmedAt=ipcTrace.length;
      await sleep(3500);
      if(ipcTrace.slice(offConfirmedAt).some(line=>line.includes("tokens=present"))) {
        failures.push("revoked token snapshot resurfaced after renderer showed off");
      }
      else tokenDisplay += " rendererOff=confirmed";
    }
    if (scenario === "crash-recovery") {
      const collectorPid = utilityCollectorPid();
      if (!collectorPid) throw new Error("collector process not found");
      try { execFileSync("taskkill.exe", ["/PID", collectorPid, "/F"], { stdio: "ignore", windowsHide: true }); } catch {}
      let recovered = false;
      for (let i = 0; i < 40 && !recovered; i++) {
        await sleep(500);
        recovered = marks.has("collector_restart_scheduled") && (await health(token)) !== null &&
          utilityCollectorPid() !== null && utilityCollectorPid() !== collectorPid;
      }
      if (!marks.has("collector_restart_scheduled")) failures.push("QuotaOps did not schedule a collector restart");
      if (!recovered) failures.push("collector did not come back within 20 s");
    }
    if (scenario === "main-killed") {
      try { execFileSync("taskkill.exe", ["/PID", String(child.pid), "/F"], { stdio: "ignore", windowsHide: true }); } catch {}
      await sleep(6_000);
      const left = census(sandboxName);
      if (left.app > 0) failures.push(`${left.app} QuotaOps process(es) survived the main process`);
      if (left.browsers > 0) failures.push(`${left.browsers} browser process(es) survived the main process`);
      if (await portListening()) failures.push("port 4317 still listening after the main process died");
      throw new MainKilledDone();
    }
    if (scenario === "background-focus") {
      // The scheduled collection starts with the collector; observe all of it.
      const watch = watchForeground(sandboxName, 60);
      let sawBrowser = false;
      let headed = 0;
      const until = Date.now() + 60_000;
      while (Date.now() < until && (await health(token))?.collecting === true) {
        const now = census(sandboxName);
        if (now.automatedBrowsers > 0) sawBrowser = true;
        headed = Math.max(headed, now.headedAutomatedBrowsers);
        await sleep(600);
      }
      const owners = await watch.stop();
      const owned = owners.filter((line) => line.startsWith("OWNED:"));
      focusSummary = ` foregroundSamples=${owners.length} browserOwnedForeground=${owned.length} headedOnHiddenDesktop=${headed > 0}`;
      if (!sawBrowser) failures.push("no background browser was observed (collection too short to test)");
      // Windows default "hidden": an ordinary (headed) browser on a separate,
      // never-shown desktop. What must never happen is that it reaches the
      // person's foreground.
      if (owned.length > 0) failures.push(`a test-owned browser took the foreground (${owned[0]})`);
    }
    if (scenario === "visible-consent") {
      const settledBy = Date.now() + 60_000;
      while (Date.now() < settledBy && (await health(token))?.collecting !== false) await sleep(500);
      const item = "Refresh with visible browser...";
      let opened = await invokeTrayItem(child.pid, item);
      if (!opened.ok) throw new Error(`tray item "${item}" not available: ${opened.output}`);
      const cancelled = await invokeButton(child.pid, "Cancel");
      if (!cancelled.ok) throw new Error(`consent dialog Cancel not found: ${cancelled.output}`);
      await sleep(5_000);
      if (census(sandboxName).browsers > 0) failures.push("a browser started although the person chose Cancel");
      opened = await invokeTrayItem(child.pid, item);
      if (!opened.ok) throw new Error(`tray item "${item}" not available again: ${opened.output}`);
      const agreed = await invokeButton(child.pid, "Open browser windows");
      if (!agreed.ok) throw new Error(`consent dialog button not found: ${agreed.output}`);
      let visibleBrowser = false;
      for (let i = 0; i < 40 && !visibleBrowser; i++) {
        await sleep(500);
        visibleBrowser = census(sandboxName).headedAutomatedBrowsers > 0;
      }
      if (!visibleBrowser) failures.push("no visible browser ran after consent");
      // Harness only: a real tray click gets foreground rights from the shell;
      // a scripted one does not while another app's window is in front.
      minimizeOwnedBrowsers(census(sandboxName).browserPids);
      await sleep(800);
    }
    // Let the in-flight browser get past launch into page work.
    if (scenario === "inflight") await sleep(2_500);
    if (scenario === "after-error" || scenario === "verify-path") {
      const settledBy = Date.now() + 60_000;
      while (Date.now() < settledBy && (await health(token))?.collecting !== false) await sleep(500);
    }
    if (scenario === "verify-path") {
      // The tray learns the held state on its next snapshot read.
      // A disposable profile is either challenged or simply signed out.
      const items = ["Manual verification required", "Sign in"]
        .map((prefix) => `${prefix}: ${accounts[0].label.slice(0, 40)}...`);
      let opened = null;
      for (let attempt = 0; attempt < 8 && !opened?.ok; attempt++) {
        for (const item of items) {
          opened = await invokeTrayItem(child.pid, item);
          if (opened.ok) break;
        }
        if (!opened.ok) await sleep(8_000);
      }
      if (!opened?.ok) throw new Error(`tray attention item not available: ${opened?.output}`);
      let person = [];
      for (let i = 0; i < 30 && person.length === 0; i++) {
        await sleep(500);
        person = census(sandboxName).personBrowserPids;
      }
      if (person.length !== 1) throw new Error(`expected one non-automated browser, saw ${person.length}`);
      // Ask for a refresh while it is open: automation must stay off it.
      await fetch(`http://${HOST}:${PORT}/monitoring/refresh`, {
        method: "POST", headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(2_000),
      }).catch(() => undefined);
      for (let i = 0; i < 6; i++) {
        await sleep(1_000);
        if (census(sandboxName).automatedBrowsers > 0) {
          failures.push("an automated browser opened the profile while the person had it open");
          break;
        }
      }
      // The person closes the window; QuotaOps should check the account once.
      // QuotaOps only observes the browser process ending, so ending the
      // test-owned browser process is the same event. (A plain WM_CLOSE via
      // taskkill without /F did not close Chrome.)
      for (const pid of person) {
        try { execFileSync("taskkill.exe", ["/PID", pid, "/T", "/F"], { stdio: "ignore", windowsHide: true }); } catch {}
      }
      let rechecked = false;
      for (let i = 0; i < 60 && !rechecked; i++) {
        await sleep(500);
        rechecked = census(sandboxName).automatedBrowsers > 0 || (await health(token))?.collecting === true;
      }
      if (!rechecked) failures.push("account was not re-checked after the verification window closed");
      const settledAgain = Date.now() + 60_000;
      while (Date.now() < settledAgain && (await health(token))?.collecting !== false) await sleep(500);
    }
    collectingAtQuit = (await health(token))?.collecting ?? null;
    if (scenario === "inflight" && collectingAtQuit !== true) {
      failures.push("collection was not in flight when Quit was invoked");
    }
    if (scenario === "visible-consent" && collectingAtQuit !== true) {
      failures.push("the visible collection had ended before Quit; Quit was not tested during it");
    }
    if ((scenario === "after-error" || scenario === "verify-path") && collectingAtQuit !== false) {
      failures.push("provider collection had not finished before Quit");
    }

    let driver = await invokeTrayItem(child.pid, "Quit");
    // Harness retry only: if the scripted click never reached the app (no
    // tray_quit_requested mark), the menu was not driven, e.g. a cold UI
    // Automation start on a CI runner. A delivered Quit is never retried, so
    // an app that ignores Quit still fails.
    if (!driver.ok && !marks.has("tray_quit_requested") && exitedAt === null) {
      driverRetries++;
      await sleep(2_000);
      driver = await invokeTrayItem(child.pid, "Quit");
    }
    if (!driver.ok) failures.push(`tray driver failed: ${driver.output}`);

    const exitBy = Date.now() + 30_000;
    while (exitedAt === null && Date.now() < exitBy) await sleep(100);
    await sleep(300);
    const clicked = marks.get("tray_quit_requested");
    if (exitedAt === null) failures.push("QuotaOps did not exit within 30 s of tray Quit");
    else if (clicked) quitLatencyMs = exitedAt - clicked;
    // With the port held by another program there is no owned collector to shut down.
    const requiredMarks = scenario === "port-foreign"
      ? ["tray_quit_requested", "before_quit", "electron_will_quit"]
      : ["tray_quit_requested", "before_quit", "collector_shutdown_posted", "collector_shutdown_completed", "electron_will_quit"];
    for (const required of requiredMarks) {
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
    if (foreign) await new Promise((resolve) => foreign.close(resolve));
    if (await portListening()) failures.push("port 4317 still listening");
  } catch (error) {
    if (!(error instanceof MainKilledDone)) failures.push(error instanceof Error ? error.message : String(error));
  } finally {
    if (foreign) await new Promise((resolve) => foreign.close(() => resolve()));
    const left = census(sandboxName);
    for (const pid of left.pids) {
      try { execFileSync("taskkill.exe", ["/PID", pid, "/T", "/F"], { stdio: "ignore", windowsHide: true }); } catch {}
    }
    await sleep(800);
    if (!(await portListening())) await rm(sandbox, { recursive: true, force: true }).catch(() => undefined);
  }
  const summary = `cycle ${cycle}/${cycles} scenario=${scenario} collectingAtQuit=${collectingAtQuit} ` +
    `quitLatencyMs=${quitLatencyMs ?? "n/a"}${focusSummary}${tokenDisplay}${driverRetries ? ` driverRetries=${driverRetries}` : ""} marks=${[...marks.keys()].filter((m) => /quit|collector_shutdown|collector_exited/.test(m)).join(",")}`;
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
