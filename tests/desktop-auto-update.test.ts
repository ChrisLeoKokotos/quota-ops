import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createUpdateManager, validateUpdateGate } =
  require("../desktop/electron-ipc/update-manager.js") as {
    validateUpdateGate: (data: Record<string, unknown>) => boolean;
    createUpdateManager: (options: Record<string, unknown>) => {
      status(): { state: string; version: string | null };
      start(): void;
      stop(): void;
      check(): Promise<boolean>;
      download(): Promise<boolean>;
      install(): Promise<boolean>;
      launchInstaller(): boolean;
    };
  };

class FakeUpdater extends EventEmitter {
  autoDownload = true;
  autoInstallOnAppQuit = true;
  allowPrerelease = true;
  allowDowngrade = true;
  disableWebInstaller = false;
  checks = 0;
  downloads = 0;
  installs = 0;
  async checkForUpdates() { this.checks += 1; this.emit("checking-for-update"); }
  async downloadUpdate() { this.downloads += 1; this.emit("update-downloaded", { version: "0.2.0" }); }
  quitAndInstall() { this.installs += 1; }
}

const policy = { enabled: true, provider: "github", owner: "ChrisLeoKokotos",
  repo: "quota-ops", expectedPublisherName: "So Homely Software" };

function gate(overrides: Record<string, unknown> = {}) {
  return validateUpdateGate({
    isPackaged: true, platform: "win32", resourcesPath: "C:\\Test\\resources",
    policy,
    fileExists: () => true,
    readText: () => [
      "provider: github",
      "owner: ChrisLeoKokotos",
      "repo: quota-ops",
      "publisherName: So Homely Software",
    ].join("\n"),
    ...overrides,
  });
}

test("unsigned and non-Windows builds categorically refuse update access", () => {
  assert.equal(gate(), true);
  for (const override of [
    { isPackaged: false }, { platform: "linux" }, { policy: { ...policy, enabled: false } },
    { policy: { ...policy, expectedPublisherName: "" } },
    { policy: { ...policy, owner: "untrusted-owner" } },
    { fileExists: () => false },
    { readText: () => "provider: github\nowner: ChrisLeoKokotos\nrepo: quota-ops" },
    { readText: () => "provider: generic\nowner: ChrisLeoKokotos\nrepo: quota-ops\npublisherName: So Homely Software" },
    { readText: () => "provider: github\nowner: ChrisLeoKokotos\nrepo: quota-ops\npublisherName: Wrong Signer" },
    { readText: () => "provider: github\nprovider: github\nowner: ChrisLeoKokotos\nrepo: quota-ops\npublisherName: So Homely Software" },
  ]) assert.equal(gate(override), false);
});

test("real installed unsigned policy is disabled in Git-tracked configuration", async () => {
  const config = JSON.parse(await readFile(new URL(
    "../desktop/electron-ipc/update-policy.json", import.meta.url), "utf8"));
  assert.equal(config.enabled, false);
  assert.equal(config.expectedPublisherName, "");
  const builder = JSON.parse(await readFile(new URL(
    "../desktop/electron-builder.json", import.meta.url), "utf8"));
  assert.equal(builder.publish, null);
  assert.ok(builder.files.includes("update-manager.js"));
  assert.ok(builder.files.includes("update-policy.json"));
  const release = JSON.parse(await readFile(new URL(
    "../desktop/electron-builder.release.json", import.meta.url), "utf8"));
  assert.deepEqual(release.publish, {
    provider: "github", owner: "ChrisLeoKokotos", repo: "quota-ops", releaseType: "release",
  });
  assert.equal(release.win.verifyUpdateCodeSignature, true);
});

test("checks are periodic but downloading and installation require human consent", async () => {
  const backend = new FakeUpdater();
  let confirm = false;
  let shutdownRequested = 0;
  let tick: (() => void) | null = null;
  const manager = createUpdateManager({
    updater: backend,
    askInstall: async () => confirm,
    requestQuitForInstall: () => { shutdownRequested += 1; },
    setIntervalFn: (fn: () => void) => { tick = fn; return { unref() {} }; },
    clearIntervalFn: () => { tick = null; },
  });
  manager.start();
  assert.equal(backend.autoDownload, false);
  assert.equal(backend.autoInstallOnAppQuit, false);
  assert.equal(backend.allowPrerelease, false);
  assert.equal(backend.allowDowngrade, false);
  assert.equal(backend.disableWebInstaller, true);
  assert.equal(backend.downloads, 0);
  backend.emit("update-available", { version: "0.2.0" });
  assert.deepEqual(manager.status(), { state: "available", version: "0.2.0" });
  assert.equal(await manager.download(), true);
  assert.equal(backend.downloads, 1);
  assert.equal(manager.status().state, "ready");
  assert.equal(await manager.install(), false, "dialog rejection must not install");
  assert.equal(backend.installs, 0);
  confirm = true;
  assert.equal(await manager.install(), true);
  assert.equal(shutdownRequested, 1);
  assert.equal(backend.installs, 0, "must drain collector before invoking installer");
  assert.equal(manager.launchInstaller(), true);
  assert.equal(backend.installs, 1);
  manager.stop();
  assert.equal(tick, null);
});

test("disabled manager refuses duplicate downloads and unauthorised installs", async () => {
  const backend = new FakeUpdater();
  const manager = createUpdateManager({ updater: backend });
  assert.equal(await manager.download(), false);
  assert.equal(await manager.install(), false);
  assert.equal(manager.launchInstaller(), false);
  backend.emit("update-available", { version: "0.2.0" });
  assert.equal(manager.status().state, "available");
  await manager.download();
  assert.equal(await manager.download(), false);
  assert.equal(await manager.install(), false);
  manager.stop();
  assert.equal(await manager.check(), false);
});

test("renderer IPC surface is unchanged; only main owns updater", async () => {
  const preload = await readFile(
    new URL("../desktop/electron-ipc/preload.js", import.meta.url), "utf8");
  const main = await readFile(
    new URL("../desktop/electron-ipc/main.js", import.meta.url), "utf8");
  assert.doesNotMatch(preload, /update|install|download/i);
  assert.match(main, /validateUpdateGate/);
  assert.match(main, /requestQuitForInstall/);
  assert.match(main, /app\.quit\(\)/);
  assert.match(main, /updateManager\?\.launchInstaller\(\)/);
  assert.doesNotMatch(main, /ipcMain\.handle\(["'].*update/i);
});
