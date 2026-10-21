// QuotaOps desktop shell — IPC architecture proof of concept.
//
// The difference from desktop/electron: there is no Next.js server and no
// dashboard HTTP listener at all. The UI is a static bundle served from a
// private scheme, and the renderer reaches the collector through one
// read-only IPC channel.
//
// What that buys, and what it changes for security:
//
//   * The ~100 MB Node server process is gone.
//   * The renderer never holds the collector's bearer token.
//   * There is no loopback dashboard port, so QO-SEC-01's peer boundary and
//     its Risk C transparent-relay exposure do not apply to the UI at all —
//     there is nothing for a relay to forward to.
//   * The collector itself is unchanged: still 127.0.0.1:4317, still bearer
//     authenticated. That boundary is untouched by this work.

const { Menu, Notification, Tray, app, BrowserWindow, dialog, ipcMain, net, protocol, session, shell, utilityProcess } = require("electron");
const { readFile } = require("node:fs/promises");
const { readFileSync, existsSync } = require("node:fs");
const { createReadStream } = require("node:fs");
const { homedir } = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const {
  MAX_ACCOUNTS,
  buildContentSecurityPolicy,
  isTrustedIpcSender,
  projectSnapshot,
  readBoundedBody,
  resolveExternalUrl,
  resolveStaticAsset,
} = require("./security.js");
const { RefreshScheduler } = require("./scheduler.js");
const { createUpdateManager, validateUpdateGate } = require("./update-manager.js");
const UPDATE_POLICY = require("./update-policy.json");

const STATIC_ROOT = app.isPackaged
  ? path.join(process.resourcesPath, "static-dist")
  : path.join(__dirname, "..", "static-dist");

/**
 * Resolves a branding asset for both layouts.
 *
 * electron-builder flattens the app directory, so packaged icons sit beside
 * main.js; in the repository they live under `desktop/branding/`. A missing
 * asset returns null and the caller falls back, so a packaging mistake shows
 * up as the default Electron icon rather than a crash on startup.
 */
function brandingAsset(name) {
  const packaged = path.join(__dirname, name);
  if (existsSync(packaged)) return packaged;

  const source = path.join(__dirname, "..", "branding", name);
  return existsSync(source) ? source : null;
}

const APP_ICON = brandingAsset("quotaops-icon.ico");
const TRAY_ICON = brandingAsset("quotaops-tray.ico");
// Packaged editions ship the collector with their own Electron/Node runtime.
// Dev still accepts an explicitly started external collector for comparison.
const BUNDLED_COLLECTOR = app.isPackaged
  ? path.join(process.resourcesPath, "collector-runtime", "collector", "service.ts")
  : null;
const COLLECTOR_SNAPSHOT = "http://127.0.0.1:4317/snapshot";
const COLLECTOR_CONTROLS = Object.freeze({
  pause: "http://127.0.0.1:4317/monitoring/pause",
  resume: "http://127.0.0.1:4317/monitoring/resume",
  refresh: "http://127.0.0.1:4317/monitoring/refresh",
});
const MAX_RESPONSE_BYTES = 262_144;
const MIN_SNAPSHOT_INTERVAL_MS = 1_000;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const APP_ORIGIN = "app://quotaops";

let mainWindow = null;
let tray = null;
let cachedToken = null;
let quitting = false;
/** Identity the IPC handler checks every sender against. */
let trustedSender = null;
let scheduler = null;
/** One snapshot request at a time; the rest observe the result. */
let inFlightSnapshot = null;
let lastSnapshotAt = 0;
let trayCommandPending = false;
let trayCommandError = null;
let ownedCollector = null;
let collectorStarted = false;
// A downloaded update may install only after user confirmation and the same
// graceful collector shutdown used by Quit.
let updateManager = null;
let installUpdateOnQuit = false;

// Explicit opt-in startup markers: no account names, URLs, paths, cookies,
// bearer tokens, HTTP bodies or raw stack traces ever enter the probe output.
const STARTUP_DIAGNOSTICS = process.env.QUOTAOPS_STARTUP_DIAGNOSTICS === "1";
function startupMark(code) {
  if (STARTUP_DIAGNOSTICS) process.stdout.write(`[quotaops-startup] ${code}\n`);
}
function classifyCollectorError(value) {
  const line = String(value).slice(0, 4096);
  if (/ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX|ERR_UNKNOWN_FILE_EXTENSION/.test(line)) return "ts_loader";
  if (/ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND|Cannot find package/.test(line)) return "module_resolution";
  if (/EACCES|EPERM|access denied/i.test(line)) return "permission";
  if (/SyntaxError/.test(line)) return "syntax";
  return "other";
}

// The isolated Windows packaged-smoke process must use a DIFFERENT Electron
// profile and single-instance-lock namespace, not just different Node HOME.
// Chromium's Windows appData resolution can ignore a child APPDATA override.
// This opt-in path is constrained to our disposable test sandbox and must be
// set before requestSingleInstanceLock() / the first ready event.
// Ordinary desktop launches always keep Electron's normal userData directory.
const smokeUserData = process.env.QUOTAOPS_SMOKE_USER_DATA;
if (smokeUserData !== undefined) {
  const home = process.env.USERPROFILE;
  const appData = process.env.APPDATA;
  const isIsolatedHome = typeof home === "string" &&
    path.isAbsolute(home) &&
    path.basename(home).toLowerCase() === "user" &&
    /^quotaops-packaged-test-[a-z0-9-]+$/i.test(path.basename(path.dirname(home)));
  const expectedUserData = typeof appData === "string"
    ? path.resolve(appData, "QuotaOpsSmoke")
    : "";
  if (!app.isPackaged || process.platform !== "win32" ||
      !STARTUP_DIAGNOSTICS || !isIsolatedHome ||
      !path.isAbsolute(smokeUserData) ||
      !existsSync(smokeUserData) ||
      path.resolve(smokeUserData).toLowerCase() !== expectedUserData.toLowerCase() ||
      path.resolve(appData).toLowerCase() !==
        path.resolve(path.dirname(home), "Roaming").toLowerCase()) {
    throw new Error("Refusing an unsafe packaged-smoke Electron userData override");
  }
  app.setPath("userData", smokeUserData);
  startupMark("smoke_electron_userdata_isolated");
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: "app",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: false,
    },
  },
]);

async function collectorToken() {
  if (cachedToken) return cachedToken;

  const file = path.join(homedir(), ".quotaops", "collector.token");
  const token = (await readFile(file, "utf8")).trim();
  if (!TOKEN_PATTERN.test(token)) {
    throw new Error("collector token is missing or malformed");
  }
  cachedToken = token;
  return token;
}

/**
 * The only privileged operation the renderer can trigger.
 *
 * Returns a projected snapshot or a fixed error enum. The token stays in the
 * main process, and the renderer receives only fields this module rebuilds —
 * never the collector's own error text and never an unknown key.
 */
async function readSnapshot() {
  let token;
  try {
    token = await collectorToken();
  } catch {
    return { error: "collector_unavailable" };
  }

  let response;
  try {
    response = await fetch(COLLECTOR_SNAPSHOT, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: AbortSignal.timeout(3_000),
      redirect: "error",
    });
  } catch {
    return { error: "collector_offline" };
  }

  if (response.status === 401) {
    // The token was rotated; re-read it once and retry.
    cachedToken = null;
    try {
      const retryToken = await collectorToken();
      response = await fetch(COLLECTOR_SNAPSHOT, {
        headers: { Authorization: `Bearer ${retryToken}`, Accept: "application/json" },
        signal: AbortSignal.timeout(3_000),
        redirect: "error",
      });
    } catch {
      return { error: "collector_offline" };
    }
  }

  if (!response.ok) return { error: "collector_unavailable" };

  const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
  if (!contentType.includes("application/json")) {
    return { error: "collector_invalid_response" };
  }

  // Bound the body while it streams. Checking the length after `text()` has
  // already buffered everything is not an allocation bound: by then the
  // memory is spent.
  const body = await readBoundedBody(response, MAX_RESPONSE_BYTES);
  if (!body.ok) {
    return {
      error: body.reason === "too_large"
        ? "collector_response_too_large"
        : "collector_invalid_response",
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(body.text);
  } catch {
    return { error: "collector_invalid_response" };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { error: "collector_invalid_response" };
  }
  if (parsed.version !== 1 || !Array.isArray(parsed.accounts)) {
    return { error: "collector_invalid_response" };
  }
  if (parsed.accounts.length > MAX_ACCOUNTS) {
    return { error: "collector_invalid_response" };
  }

  return projectSnapshot(parsed);
}

/**
 * Serves the exported bundle, refusing anything outside it.
 *
 * Containment is delegated to `resolveStaticAsset`, which compares path
 * segments and re-checks after following links rather than testing a string
 * prefix. A sibling directory whose name begins with the bundle's name would
 * pass a prefix test; so would a symlink inside the bundle.
 */
function registerStaticProtocol() {
  protocol.handle("app", async (request) => {
    let url;
    try {
      url = new URL(request.url);
    } catch {
      return new Response("bad request", { status: 400 });
    }

    if (url.host !== "quotaops") return new Response("not found", { status: 404 });

    const resolved = resolveStaticAsset(STATIC_ROOT, url.pathname);
    if (!resolved.ok) {
      return new Response("forbidden", { status: 403 });
    }

    if (resolved.exists) {
      try {
        return await net.fetch(pathToFileURL(resolved.path).toString());
      } catch {
        return new Response("not found", { status: 404 });
      }
    }

    // Client-side routing: an unknown path falls back to the entry document.
    const entry = resolveStaticAsset(STATIC_ROOT, "/index.html");
    if (!entry.ok || !entry.exists) {
      return new Response("not found", { status: 404 });
    }
    try {
      return await net.fetch(pathToFileURL(entry.path).toString());
    } catch {
      return new Response("not found", { status: 404 });
    }
  });
}

/**
 * Inline script hashes recorded by the static build.
 *
 * Allowing them by hash keeps `unsafe-inline` out of `script-src`. If the
 * manifest is missing the shell fails closed on scripts rather than widening
 * the policy: a blank dashboard is a visible, diagnosable failure, whereas a
 * silently relaxed CSP is not.
 */
function inlineScriptHashes() {
  try {
    const raw = readFileSync(path.join(STATIC_ROOT, "csp-script-hashes.json"), "utf8");
    const parsed = JSON.parse(raw);
    if (parsed?.version !== 1 || !Array.isArray(parsed.scriptHashes)) return [];
    return parsed.scriptHashes.filter(
      (hash) => typeof hash === "string" && /^sha256-[A-Za-z0-9+/]+=*$/.test(hash),
    );
  } catch {
    return [];
  }
}

function hardenSession() {
  const target = session.defaultSession;
  const policy = buildContentSecurityPolicy(inlineScriptHashes());

  target.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [policy],
        "X-Content-Type-Options": ["nosniff"],
      },
    });
  });

  target.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  target.setPermissionCheckHandler(() => false);

  if (process.env.QUOTAOPS_IPC_TRACE) {
    process.stdout.write(`[csp] ${policy}\n`);
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    show: false,
    backgroundColor: "#111317",
    title: "QuotaOps",
    // Drives the window frame and the taskbar button. Without it both fall
    // back to Electron's default icon even when the executable is branded.
    ...(APP_ICON ? { icon: APP_ICON } : {}),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      preload: path.join(__dirname, "preload.js"),
    },
  });

  mainWindow.removeMenu();

  // `shell.openExternal` launches whatever handler Windows has registered, so
  // an unfiltered call lets the renderer invoke arbitrary protocol handlers.
  // Only https destinations are passed on; everything else is dropped.
  const openExternalIfAllowed = (target) => {
    // Pass the parsed form: `new URL()` strips tabs and leading whitespace and
    // rewrites backslashes, so validating one spelling and handing ShellExecute
    // another means the string checked is not the string executed.
    const safe = resolveExternalUrl(target);
    if (safe) void shell.openExternal(safe);
  };

  mainWindow.webContents.on("will-navigate", (event, target) => {
    if (!target.startsWith(`${APP_ORIGIN}/`)) {
      event.preventDefault();
      openExternalIfAllowed(target);
    }
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openExternalIfAllowed(url);
    return { action: "deny" };
  });

  // Closing the window hides it; quitting is a separate, explicit action.
  // Settings must say so plainly, because a window that will not close is
  // otherwise indistinguishable from a bug.
  mainWindow.on("close", (event) => {
    if (quitting) return;
    event.preventDefault();
    mainWindow.hide();
  });

  if (process.env.QUOTAOPS_CSP_PROBE) {
    mainWindow.webContents.once("did-finish-load", async () => {
      const probe = `(async () => {
        const out = {};
        try { await fetch("https://example.com", { signal: AbortSignal.timeout(2500) }); out.connect = "ALLOWED"; }
        catch (error) { out.connect = "BLOCKED:" + String(error).slice(0, 60); }
        try {
          const el = document.createElement("script");
          el.text = "window.__cspProbe = 1;";
          document.body.appendChild(el);
          out.inlineScript = window.__cspProbe === 1 ? "ALLOWED" : "BLOCKED";
        } catch (error) { out.inlineScript = "THREW:" + String(error).slice(0, 40); }
        out.metaCsp = document.querySelector('meta[http-equiv="Content-Security-Policy"]') ? "present" : "absent";
        return JSON.stringify(out);
      })()`;
      try {
        const result = await mainWindow.webContents.executeJavaScript(probe, true);
        process.stdout.write(`[csp-probe] ${result}
`);
      } catch (error) {
        process.stdout.write(`[csp-probe] failed: ${String(error).slice(0, 120)}
`);
      }
    });
  }

  mainWindow.once("ready-to-show", () => {
    startupMark("window_ready");
    mainWindow.show();
    const t0 = Number(process.env.QUOTAOPS_T0 ?? 0);
    if (t0) process.stdout.write(`[poc] window visible after ${Date.now() - t0} ms\n`);
  });

  trustedSender = {
    webContentsId: mainWindow.webContents.id,
    origin: APP_ORIGIN,
  };

  mainWindow.webContents.on("did-fail-load", () => startupMark("renderer_load_failed"));
  mainWindow.webContents.on("render-process-gone", () => startupMark("renderer_process_gone"));
  void mainWindow.loadURL(`${APP_ORIGIN}/index.html`);
}

/**
 * Control the actual collector process, not Electron's read-only scheduler.
 * These three fixed POST destinations are reachable only from the trusted main
 * process, with the local bearer token. No renderer IPC control surface.
 */
async function collectorControl(action) {
  const url = COLLECTOR_CONTROLS[action];
  if (!url) return false;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let token;
    try { token = await collectorToken(); }
    catch { return false; }
    let response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
        signal: AbortSignal.timeout(3000),
        redirect: "error",
      });
    } catch { return false; }
    if (response.status === 401 && attempt === 0) {
      cachedToken = null;
      continue;
    }
    return response.ok;
  }
  return false;
}

async function runTrayCommand(action) {
  if (trayCommandPending) return;
  trayCommandPending = true;
  trayCommandError = null;
  refreshTray();
  try {
    const ok = await collectorControl(action);
    if (!ok) {
      trayCommandError = "Collector command failed; monitoring state unchanged";
      return;
    }
    if (action === "pause") scheduler?.pause();
    if (action === "resume") scheduler?.resume();
    // Manual provider refresh is asynchronous; a successful 202 only queues
    // it. Do not pretend the next cached snapshot is newly collected.
  } finally {
    trayCommandPending = false;
    refreshTray();
  }
}

/**
 * Supervised local utility process: no separate Node.js installation or
 * command prompt required by the installed app. The collector still binds
 * only 127.0.0.1 and requires its local token. We do not send provider
 * session material or HTTP responses over utility-process IPC.
 */
function startBundledCollector() {
  if (!BUNDLED_COLLECTOR || collectorStarted) return;
  collectorStarted = true;
  if (!existsSync(BUNDLED_COLLECTOR)) {
    startupMark("collector_missing");
    trayCommandError = "Bundled collector missing (installation incomplete)";
    return;
  }
  try {
    ownedCollector = utilityProcess.fork(BUNDLED_COLLECTOR, [], {
      cwd: path.dirname(path.dirname(BUNDLED_COLLECTOR)),
      execArgv: ["--experimental-strip-types"],
      serviceName: "QuotaOps Collector",
      // Only explicit packaged startup smoke captures child output. Never
      // forward it verbatim: provider logs can contain private state.
      stdio: STARTUP_DIAGNOSTICS ? "pipe" : "ignore",
    });
    startupMark("collector_fork_requested");
    if (STARTUP_DIAGNOSTICS) {
      ownedCollector.once("spawn", () => startupMark("collector_spawned"));
      ownedCollector.once("error", () => startupMark("collector_fatal_error"));
      let reportedStderr = false;
      ownedCollector.stderr?.on("data", (chunk) => {
        if (reportedStderr) return;
        reportedStderr = true;
        startupMark(`collector_stderr_${classifyCollectorError(chunk)}`);
      });
      let reportedListening = false;
      let stdoutTail = "";
      ownedCollector.stdout?.on("data", (chunk) => {
        stdoutTail = (stdoutTail + String(chunk)).slice(-1024);
        if (!reportedListening && stdoutTail.includes("QuotaOps collector listening")) {
          reportedListening = true;
          startupMark("collector_listening");
        }
      });
    }
    ownedCollector.once("exit", (code) => {
      startupMark(`collector_exited_${Number.isInteger(code) ? code : "unknown"}`);
      ownedCollector = null;
      if (!quitting) {
        trayCommandError = "Collector stopped; data may be stale";
        refreshTray();
      }
    });
  } catch {
    startupMark("collector_fork_threw");
    ownedCollector = null;
    trayCommandError = "Bundled collector could not start";
  }
}

function formatLastUpdate(status) {
  if (!status || status.lastSuccessAt === null) return "Last snapshot check: never";
  const minutes = Math.floor((status.ageMs ?? 0) / 60_000);
  const when =
    minutes < 1 ? "just now" : minutes === 1 ? "1 minute ago" : `${minutes} minutes ago`;
  // Say "stale" rather than only showing a time: a reader given a timestamp
  // alone treats it as current, which is the thing to avoid.
  // Local scheduler only reads a cached snapshot; this is not the time
  // provider usage was collected. Avoid claiming provider freshness.
  return status.stale ? `Last snapshot check: ${when} (stale)` : `Last snapshot check: ${when}`;
}

function buildTrayMenu() {
  const status = scheduler ? scheduler.status() : null;
  const updateStatus = updateManager?.status() ?? { state: "disabled", version: null };
  const offeredVersion = updateStatus.version ? ` (v${updateStatus.version})` : "";
  const updateRows = [
    { label: updateStatus.state === "disabled"
        ? "Updates unavailable (unsigned test build)" : "Check for updates",
      enabled: updateStatus.state !== "disabled" &&
        !["checking", "downloading", "installing"].includes(updateStatus.state),
      click: () => { void updateManager?.check(); } },
    ...(updateStatus.state === "available" ? [
      { label: `Download update${offeredVersion}`, click: () => {
        void updateManager?.download();
      } },
    ] : []),
    ...(updateStatus.state === "ready" ? [
      { label: `Install update${offeredVersion} and restart...`, click: () => {
        void updateManager?.install();
      } },
    ] : []),
    ...(["checking", "downloading", "installing"].includes(updateStatus.state)
      ? [{ label: `Update: ${updateStatus.state}`, enabled: false }] : []),
    ...(updateStatus.state === "error"
      ? [{ label: "Update check failed (retry from menu)", enabled: false }] : []),
  ];
  const paused = status?.paused ?? false;

  return Menu.buildFromTemplate([
    { label: "Open QuotaOps", click: () => showWindow() },
    { type: "separator" },
    {
      label: trayCommandPending ? "Sending command..." : "Refresh now",
      enabled: !trayCommandPending && !paused,
      click: () => {
        void runTrayCommand("refresh");
      },
    },
    {
      label: paused ? "Resume monitoring" : "Pause monitoring",
      enabled: !trayCommandPending,
      click: () => {
        void runTrayCommand(paused ? "resume" : "pause");
      },
    },
    { type: "separator" },
    { label: formatLastUpdate(status), enabled: false },
    ...(trayCommandError ? [{ label: trayCommandError, enabled: false }] : []),
    {
      label: paused ? "Monitoring paused" : "Monitoring active",
      enabled: false,
    },
    { type: "separator" },
    { label: "Settings", click: () => showWindow() },
    { type: "separator" },
    ...updateRows,
    {
      label: "Quit",
      click: () => {
        quitting = true;
        scheduler?.cancel();
        app.quit();
      },
    },
  ]);
}

function refreshTray() {
  if (!tray) return;
  tray.setContextMenu(buildTrayMenu());
  const status = scheduler ? scheduler.status() : null;
  tray.setToolTip(status?.paused ? "QuotaOps (paused)" : "QuotaOps");
}

function showWindow() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function configureSignedUpdates() {
  const allowed = validateUpdateGate({
    isPackaged: app.isPackaged,
    platform: process.platform,
    resourcesPath: process.resourcesPath,
    policy: UPDATE_POLICY,
  });
  if (!allowed) {
    startupMark("auto_update_disabled_untrusted_build");
    return;
  }
  let updater;
  try {
    // Only the Electron main process loads the pinned runtime dependency.
    // No browser API or collector credential crosses into the updater.
    ({ autoUpdater: updater } = require("electron-updater"));
  } catch {
    startupMark("auto_update_dependency_missing");
    return;
  }
  let lastNotifiedUpdate = null;
  updateManager = createUpdateManager({
    updater,
    onChange: ({ state, version }) => {
      refreshTray();
      if (state === "available" && version &&
          lastNotifiedUpdate !== version && Notification.isSupported()) {
        lastNotifiedUpdate = version;
        try {
          const notice = new Notification({
            title: "QuotaOps update available",
            body: `Version ${version} is ready to download from the QuotaOps tray menu.`,
          });
          notice.show();
        } catch {
          // System notifications are optional; the tray update action stays visible.
          startupMark("update_notification_unavailable");
        }
      }
    },
    askInstall: async (version) => {
      const result = await dialog.showMessageBox({
        type: "question",
        buttons: ["Not now", "Install and restart"],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
        title: "QuotaOps update",
        message: `Install QuotaOps ${version ?? "update"}?`,
        detail: "Monitoring will pause while QuotaOps closes its active browser sessions. Your account configuration and saved sessions are not deleted.",
      });
      return result.response === 1;
    },
    requestQuitForInstall: () => {
      installUpdateOnQuit = true;
      quitting = true;
      scheduler?.cancel();
      app.quit();
    },
  });
  updateManager.start();
  refreshTray();
}

function createTray() {
  // The tray build is cropped to the artwork: at 16x16 the logo's transparent
  // margin costs legibility that the notification area cannot spare.
  tray = new Tray(TRAY_ICON ?? path.join(__dirname, "icon.ico"));
  refreshTray();
  tray.on("click", () => {
    if (mainWindow?.isVisible()) mainWindow.hide();
    else showWindow();
  });

  // The menu shows live state, so it is rebuilt on a slow tick rather than
  // only when something is clicked.
  setInterval(refreshTray, 30_000).unref();
}

const firstInstance = app.requestSingleInstanceLock();
startupMark(firstInstance ? "instance_lock_acquired" : "instance_lock_rejected");
if (!firstInstance) {
  app.quit();
} else {
  app.on("second-instance", () => showWindow());
  app.whenReady().then(() => {
  startupMark("electron_ready");
  registerStaticProtocol();
  hardenSession();
  ipcMain.handle("quotaops:snapshot", async (event) => {
    // Identity comes from Electron, never from a value the renderer sends.
    // Without this, any frame the renderer can create could reach the
    // privileged path.
    if (!isTrustedIpcSender(event, trustedSender)) {
      return { error: "forbidden" };
    }

    // One request at a time. A renderer loop would otherwise open a new
    // collector connection per call.
    if (inFlightSnapshot) return inFlightSnapshot;

    const now = Date.now();
    if (now - lastSnapshotAt < MIN_SNAPSHOT_INTERVAL_MS) {
      return { error: "rate_limited" };
    }
    lastSnapshotAt = now;

    inFlightSnapshot = readSnapshot()
      .then((result) => {
        if (process.env.QUOTAOPS_IPC_TRACE) {
          // Shape only, never contents: a trace must not become a data leak.
          const shape = result && result.error
            ? `error=${result.error}`
            : `version=${result.version} accounts=${Array.isArray(result.accounts) ? result.accounts.length : "?"}`;
          process.stdout.write(`[ipc] snapshot -> ${shape}
`);
        }
        return result;
      })
      .finally(() => {
        inFlightSnapshot = null;
      });

    return inFlightSnapshot;
  });

  scheduler = new RefreshScheduler({
    collect: async () => {
      const result = await readSnapshot();
      // An error payload is a failed collection, not a successful one that
      // happens to contain an error: treating it as success would reset the
      // backoff and mark the data fresh.
      if (result && result.error) throw new Error(result.error);
      return result;
    },
  });

  startBundledCollector();
  createWindow();
  createTray();
  configureSignedUpdates();
  startupMark("ui_initialised");

  // Drive the schedule from one timer; the scheduler decides whether a tick
  // is due, so the interval here is only a resolution, not a policy.
  setInterval(() => {
    if (scheduler?.isDue()) void scheduler.refresh().then(refreshTray);
  }, 15_000).unref();

  // Hiding to tray leaves no window open, which would otherwise quit the app.
  app.on("window-all-closed", () => {
    if (quitting) app.quit();
  });
  });
}

let quitWaitingForCollector = false;
app.on("before-quit", (event) => {
  quitting = true;
  scheduler?.cancel();
  updateManager?.stop();
  if (!ownedCollector) {
    if (installUpdateOnQuit) {
      event.preventDefault();
      installUpdateOnQuit = false;
      try { updateManager?.launchInstaller(); }
      catch { app.quit(); }
    }
    return;
  }
  event.preventDefault();
  if (quitWaitingForCollector) return;
  quitWaitingForCollector = true;
  const child = ownedCollector;
  // Give Playwright time to close the active browser normally. Do not hold
  // Quit indefinitely if a provider has hung.
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    clearTimeout(deadline);
    child.off("exit", finish);
    ownedCollector = null;
    if (installUpdateOnQuit) {
      installUpdateOnQuit = false;
      try { updateManager?.launchInstaller(); }
      catch { app.quit(); }
    } else {
      app.quit();
    }
  };
  const deadline = setTimeout(() => {
    try { child.kill(); } catch { /* already exited */ }
    finish();
  }, 45_000);
  child.once("exit", finish);
  try {
    child.postMessage({ action: "shutdown" });
  } catch {
    try { child.kill(); } catch { /* already exited */ }
    finish();
  }
});
