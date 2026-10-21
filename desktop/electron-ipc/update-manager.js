"use strict";

// Only the trusted Electron main process owns the updater. No renderer IPC,
// no provider token, no arbitrary URL and no webview controls are added here.
const { existsSync, readFileSync } = require("node:fs");
const { join } = require("node:path");

const POLL_MS = 12 * 60 * 60 * 1000;
const EXPECTED_OWNER = "ChrisLeoKokotos";
const EXPECTED_REPO = "quota-ops";
const VALID_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/**
 * This fail-closed gate cannot be enabled by an environment variable, UI,
 * unsigned test config, or remote release metadata. A subsequent *signed*
 * release must deliberately set an exact publisher in the version-controlled
 * policy and get an independent approval.
 *
 * electron-updater 6.x checks Windows Authenticode publisher when the trusted
 * app-update.yml has publisherName. SHA-512 alone is not a trust anchor.
 */
function validateUpdateGate({ isPackaged, platform, resourcesPath, policy,
  fileExists = existsSync, readText = (p) => readFileSync(p, "utf8") }) {
  if (!isPackaged || platform !== "win32" || !policy ||
      policy.enabled !== true ||
      policy.provider !== "github" || policy.owner !== EXPECTED_OWNER ||
      policy.repo !== EXPECTED_REPO ||
      typeof policy.expectedPublisherName !== "string" ||
      policy.expectedPublisherName.length < 3 ||
      !/^[A-Za-z0-9][A-Za-z0-9 &.,()_-]{2,127}$/.test(policy.expectedPublisherName) ||
      !resourcesPath) return false;

  const configPath = join(resourcesPath, "app-update.yml");
  if (!fileExists(configPath)) return false;
  let config;
  try { config = readText(configPath); } catch { return false; }
  if (typeof config !== "string" || config.length > 16_384) return false;
  // The normal electron-builder GitHub provider config is flat YAML.
  // Refuse unknown/ambiguous formats rather than assuming signing is active.
  const lines = config.split(/\r?\n/);
  const unique = (key) => {
    const matches = lines.map((line) => {
      const m = line.match(new RegExp(`^${key}:\\s*(.*)$`));
      if (!m) return null;
      return m[1].trim().replace(/^["']|["']$/g, "");
    }).filter((v) => v !== null);
    return matches.length === 1 ? matches[0] : null;
  };
  return unique("provider") === "github" &&
    unique("owner") === EXPECTED_OWNER &&
    unique("repo") === EXPECTED_REPO &&
    unique("publisherName") === policy.expectedPublisherName;
}

function createUpdateManager({ updater, onChange = () => {}, askInstall,
  requestQuitForInstall, setIntervalFn = setInterval, clearIntervalFn = clearInterval }) {
  if (!updater || typeof updater.on !== "function" ||
      typeof updater.checkForUpdates !== "function" ||
      typeof updater.downloadUpdate !== "function" ||
      typeof updater.quitAndInstall !== "function") {
    throw new Error("Invalid desktop update backend");
  }

  let state = "idle";
  let version = null;
  let stopped = false;
  let timer = null;
  let checking = false;
  let downloading = false;
  let installing = false;
  const emit = () => onChange({ state, version });

  // No installs on close, no prereleases, no downgrades, no implicit downloads.
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  updater.allowPrerelease = false;
  updater.allowDowngrade = false;
  updater.disableWebInstaller = true;

  const transition = (next, info = null) => {
    if (stopped || installing) return;
    if (info) {
      if (typeof info.version !== "string" || info.version.length > 64 ||
          !VALID_VERSION.test(info.version)) {
        state = "error";
        version = null;
        emit();
        return;
      }
      version = info.version;
    }
    state = next;
    emit();
  };

  updater.on("checking-for-update", () => transition("checking"));
  updater.on("update-available", (info) => transition("available", info));
  updater.on("update-not-available", () => transition("idle"));
  updater.on("download-progress", () => transition("downloading"));
  updater.on("update-downloaded", (info) => transition("ready", info));
  updater.on("update-cancelled", () => transition("available"));
  // Do not expose raw exception messages: release URLs/headers may be private.
  updater.on("error", () => transition("error"));

  async function check() {
    if (stopped || installing || checking || downloading ||
        state === "ready") return false;
    checking = true;
    try {
      await updater.checkForUpdates();
      return true;
    } catch {
      transition("error");
      return false;
    } finally {
      checking = false;
    }
  }

  async function download() {
    if (stopped || installing || downloading || state !== "available") return false;
    downloading = true;
    transition("downloading");
    try {
      await updater.downloadUpdate();
      return true;
    } catch {
      transition("error");
      return false;
    } finally {
      downloading = false;
    }
  }

  async function install() {
    if (stopped || installing || state !== "ready") return false;
    if (typeof askInstall !== "function" || typeof requestQuitForInstall !== "function") return false;
    let confirmed = false;
    try { confirmed = await askInstall(version); } catch { return false; }
    if (!confirmed || stopped || state !== "ready" || installing) return false;
    installing = true;
    state = "installing";
    emit();
    try {
      requestQuitForInstall();
      return true;
    } catch {
      installing = false;
      transition("error");
      return false;
    }
  }

  function launchInstaller() {
    if (!installing) return false;
    // Invoked only AFTER the normal collector shutdown path is complete.
    updater.quitAndInstall(false, true);
    return true;
  }

  function start() {
    if (stopped || timer !== null) return;
    timer = setIntervalFn(() => { void check(); }, POLL_MS);
    if (typeof timer?.unref === "function") timer.unref();
    void check();
  }

  function stop() {
    stopped = true;
    if (timer !== null) clearIntervalFn(timer);
    timer = null;
  }

  return {
    start, stop, check, download, install, launchInstaller,
    status: () => ({ state, version }),
  };
}

module.exports = { POLL_MS, createUpdateManager, validateUpdateGate };
