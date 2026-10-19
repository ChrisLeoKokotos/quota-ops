// QuotaOps Electron proof of concept.
//
// Deliberately minimal, but structurally identical to the production shape so
// the measurements mean something: it supervises the real trusted dashboard
// server as a child process, waits for the runtime descriptor, and loads the
// allocated loopback URL in a hardened window. It does not reimplement the
// dashboard.
//
// Not production code. No tray, no settings, no updater — those belong to the
// MVP once an architecture is chosen.

const { app, BrowserWindow, shell } = require("electron");
const { spawn } = require("node:child_process");
const { readFile } = require("node:fs/promises");
const { homedir } = require("node:os");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const DESCRIPTOR = path.join(homedir(), ".quotaops", "dashboard-runtime.json");
const INSTANCE_PATH = "/__quotaops/instance";

let serverProcess = null;
let mainWindow = null;

function startDashboardServer() {
  // The same entry point `npm start` uses, so the PoC measures the real
  // runtime rather than a stripped-down stand-in.
  serverProcess = spawn(
    process.execPath,
    ["--experimental-strip-types", path.join(REPO_ROOT, "server", "dashboard-server.ts"), "--production"],
    {
      cwd: REPO_ROOT,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );

  serverProcess.stdout.on("data", (chunk) => process.stdout.write(`[server] ${chunk}`));
  serverProcess.stderr.on("data", (chunk) => process.stderr.write(`[server] ${chunk}`));
}

/**
 * Resolves the dashboard the same way the launcher does: read the descriptor,
 * then require the listener to echo the recorded instance id. A port alone is
 * never treated as proof that QuotaOps owns it.
 */
async function waitForDashboard(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const descriptor = JSON.parse(await readFile(DESCRIPTOR, "utf8"));
      const response = await fetch(
        `http://127.0.0.1:${descriptor.port}${INSTANCE_PATH}`,
        { signal: AbortSignal.timeout(1_500) },
      );
      if (response.ok) {
        const payload = await response.json();
        if (payload.instanceId === descriptor.instanceId) {
          return `http://127.0.0.1:${descriptor.port}/`;
        }
      }
    } catch {
      // Not up yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error("dashboard did not become ready");
}

function createWindow(url) {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    show: false,
    backgroundColor: "#111317",
    title: "QuotaOps",
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

  // The renderer may not navigate away from the local dashboard, and may not
  // open windows at all. Anything external goes to the system browser.
  mainWindow.webContents.on("will-navigate", (event, target) => {
    if (!target.startsWith(new URL(url).origin)) {
      event.preventDefault();
      void shell.openExternal(target);
    }
  });
  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    void shell.openExternal(target);
    return { action: "deny" };
  });
  mainWindow.webContents.session.setPermissionRequestHandler((_wc, _perm, callback) => {
    callback(false);
  });

  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
    const elapsed = Date.now() - Number(process.env.QUOTAOPS_T0 ?? Date.now());
    process.stdout.write(`[poc] window visible after ${elapsed} ms\n`);
  });

  void mainWindow.loadURL(url);
}

app.whenReady().then(async () => {
  startDashboardServer();
  try {
    createWindow(await waitForDashboard());
  } catch (error) {
    process.stderr.write(`[poc] ${String(error)}\n`);
    app.quit();
  }
});

app.on("window-all-closed", () => app.quit());
app.on("quit", () => {
  if (serverProcess && !serverProcess.killed) serverProcess.kill();
});
