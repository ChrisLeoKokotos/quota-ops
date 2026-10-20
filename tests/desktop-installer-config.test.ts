import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

type FileSet = { from: string; to: string; filter?: string[] };
type Builder = {
  appId: string;
  asar: boolean;
  directories: { app: string };
  files: string[];
  extraResources: FileSet[];
  win: { target: Array<{ target: string; arch: string[] }> };
  nsis: { artifactName: string };
  publish: unknown;
};

test("unsigned test installer includes only app code and isolated collector assets", async () => {
  const config = JSON.parse(
    await readFile(new URL("../desktop/electron-builder.json", import.meta.url), "utf8"),
  ) as Builder;
  assert.equal(config.appId, "gr.sohomely.quotaops");
  assert.equal(config.asar, true);
  assert.equal(config.directories.app, "desktop/electron-ipc");
  assert.equal(config.publish, null, "an unsigned test build must not auto-publish");
  assert.deepEqual(config.win.target, [{ target: "nsis", arch: ["x64"] }]);
  assert.match(config.nsis.artifactName, /^QuotaOps-Setup-/);
  assert.deepEqual(config.files.sort(), [
    "icon.ico", "main.js", "package.json", "preload.js", "scheduler.js", "security.js",
  ].sort());
  const resources = new Map(config.extraResources.map((set) => [set.to, set.from]));
  assert.equal(resources.get("static-dist"), "desktop/static-dist");
  assert.equal(resources.get("collector-runtime/collector"), "collector");
  assert.equal(resources.get("collector-runtime/lib"), "lib");
  assert.equal(resources.get("collector-runtime/node_modules/playwright-core"),
    "node_modules/playwright-core");
  assert.equal(resources.get("collector-runtime/package.json"),
    "desktop/collector-runtime-package.json");
  for (const resource of config.extraResources) {
    assert.doesNotMatch(resource.from, /\.quotaops|browser-profiles|collector\.token|\.env|users\\/i);
    assert.doesNotMatch(resource.to, /\.quotaops|browser-profiles|collector\.token|\.env/i);
  }
});

test("installer uses protected Electron utility process and closes it on quit", async () => {
  const main = await readFile(
    new URL("../desktop/electron-ipc/main.js", import.meta.url), "utf8",
  );
  const backend = await readFile(
    new URL("../collector/service.ts", import.meta.url), "utf8",
  );
  assert.match(main, /utilityProcess\.fork\(BUNDLED_COLLECTOR/);
  assert.match(main, /execArgv:\s*\["--experimental-strip-types"\]/);
  assert.match(main, /app\.requestSingleInstanceLock\(\)/);
  assert.match(main, /child\.postMessage\(\{ action: "shutdown" \}\)/);
  assert.match(main, /collector-runtime/);
  assert.match(backend, /monitoring\.waitUntilIdle\(\)/);
  assert.match(backend, /utilityParent\?\.on\("message"/);
  assert.doesNotMatch(main, /remote-debugging-port|webSecurity:\s*false/);
});

test("installer build stays opt-in, pinned and does not publish", async () => {
  const script = await readFile(
    new URL("../desktop/build-installer.mjs", import.meta.url), "utf8",
  );
  assert.match(script, /electron-builder@26\.4\.0/);
  assert.match(script, /"--publish", "never"/);
  assert.match(script, /process\.platform !== "win32"/);
});
