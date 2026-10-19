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

const { Menu, Tray, app, BrowserWindow, ipcMain, net, protocol, session, shell } = require("electron");
const { readFile } = require("node:fs/promises");
const { createReadStream } = require("node:fs");
const { homedir } = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const STATIC_ROOT = path.join(__dirname, "..", "static-dist");
const COLLECTOR_SNAPSHOT = "http://127.0.0.1:4317/snapshot";
const MAX_RESPONSE_BYTES = 262_144;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const APP_ORIGIN = "app://quotaops";

let mainWindow = null;
let tray = null;
let cachedToken = null;
let quitting = false;

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
 * Returns the collector's snapshot payload, or a shaped error. The token
 * stays in the main process; the renderer sees metrics and nothing else, and
 * no collector error text is reflected back to it.
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

  const body = await response.text();
  if (Buffer.byteLength(body, "utf8") > MAX_RESPONSE_BYTES) {
    return { error: "collector_response_too_large" };
  }

  try {
    return JSON.parse(body);
  } catch {
    return { error: "collector_invalid_response" };
  }
}

/** Serves the exported bundle, refusing anything outside it. */
function registerStaticProtocol() {
  protocol.handle("app", async (request) => {
    const url = new URL(request.url);
    if (url.host !== "quotaops") return new Response("not found", { status: 404 });

    const relative = decodeURIComponent(url.pathname).replace(/^\/+/, "");
    const candidate = path.resolve(STATIC_ROOT, relative === "" ? "index.html" : relative);

    // Path traversal guard: a request may not escape the bundle.
    if (!candidate.startsWith(path.resolve(STATIC_ROOT))) {
      return new Response("forbidden", { status: 403 });
    }

    try {
      return await net.fetch(pathToFileURL(candidate).toString());
    } catch {
      // Client-side routing: unknown paths fall back to the entry document.
      try {
        return await net.fetch(pathToFileURL(path.join(STATIC_ROOT, "index.html")).toString());
      } catch {
        return new Response("not found", { status: 404 });
      }
    }
  });
}

function hardenSession() {
  const target = session.defaultSession;

  // The exported bundle loads only its own assets and talks to nothing over
  // the network: the collector hop happens in the main process.
  target.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [
          "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
            "img-src 'self' data: blob:; font-src 'self'; connect-src 'none'; media-src 'self' blob:; " +
            "object-src 'none'; base-uri 'self'; form-action 'none'; frame-ancestors 'none'",
        ],
        "X-Content-Type-Options": ["nosniff"],
      },
    });
  });

  target.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  target.setPermissionCheckHandler(() => false);
}

function createWindow() {
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

  mainWindow.webContents.on("will-navigate", (event, target) => {
    if (!target.startsWith(APP_ORIGIN)) {
      event.preventDefault();
      void shell.openExternal(target);
    }
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
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

  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
    const t0 = Number(process.env.QUOTAOPS_T0 ?? 0);
    if (t0) process.stdout.write(`[poc] window visible after ${Date.now() - t0} ms\n`);
  });

  void mainWindow.loadURL(`${APP_ORIGIN}/index.html`);
}

function createTray() {
  tray = new Tray(path.join(__dirname, "icon.ico"));
  tray.setToolTip("QuotaOps");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Open QuotaOps", click: () => mainWindow?.show() },
      { type: "separator" },
      {
        label: "Quit",
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]),
  );
  tray.on("click", () => {
    if (mainWindow?.isVisible()) mainWindow.hide();
    else mainWindow?.show();
  });
}

app.whenReady().then(() => {
  registerStaticProtocol();
  hardenSession();
  ipcMain.handle("quotaops:snapshot", async () => {
    const result = await readSnapshot();
    if (process.env.QUOTAOPS_IPC_TRACE) {
      // Shape only, never contents: a trace must not become a data leak.
      const shape = result && result.error
        ? `error=${result.error}`
        : `version=${result.version} accounts=${Array.isArray(result.accounts) ? result.accounts.length : "?"}`;
      process.stdout.write(`[ipc] snapshot -> ${shape}
`);
    }
    return result;
  });
  createWindow();
  createTray();

  // Hiding to tray leaves no window open, which would otherwise quit the app.
  app.on("window-all-closed", () => {
    if (quitting) app.quit();
  });
});

app.on("before-quit", () => {
  quitting = true;
});
