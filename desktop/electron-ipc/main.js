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
const { readFileSync } = require("node:fs");
const { createReadStream } = require("node:fs");
const { homedir } = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const {
  buildContentSecurityPolicy,
  isAllowedExternalUrl,
  isTrustedIpcSender,
  readBoundedBody,
  resolveStaticAsset,
} = require("./security.js");

const STATIC_ROOT = path.join(__dirname, "..", "static-dist");
const COLLECTOR_SNAPSHOT = "http://127.0.0.1:4317/snapshot";
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
/** One snapshot request at a time; the rest observe the result. */
let inFlightSnapshot = null;
let lastSnapshotAt = 0;

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

  // The renderer is handed a shape it can rely on, not whatever arrived.
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { error: "collector_invalid_response" };
  }
  if (parsed.version !== 1 || !Array.isArray(parsed.accounts)) {
    return { error: "collector_invalid_response" };
  }

  return parsed;
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
    if (isAllowedExternalUrl(target)) void shell.openExternal(target);
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

  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
    const t0 = Number(process.env.QUOTAOPS_T0 ?? 0);
    if (t0) process.stdout.write(`[poc] window visible after ${Date.now() - t0} ms\n`);
  });

  trustedSender = {
    webContentsId: mainWindow.webContents.id,
    origin: APP_ORIGIN,
  };

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
