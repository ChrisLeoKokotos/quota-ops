import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("packaged startup smoke and Electron entrypoint parse on Node 22", () => {
  for (const file of [
    "../scripts/windows-packaged-startup-smoke.mjs",
    "../desktop/electron-ipc/main.js",
  ]) {
    const filename = fileURLToPath(new URL(file, import.meta.url));
    const result = spawnSync(process.execPath, ["--check", filename], {
      encoding: "utf8",
      timeout: 15_000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
  }
});

test("packaged startup smoke isolates provider state and refuses an occupied collector", async () => {
  const script = await readFile(
    new URL("../scripts/windows-packaged-startup-smoke.mjs", import.meta.url), "utf8",
  );
  assert.match(script, /if \(await isPortListening\(\)\) \{/);
  assert.match(script, /accounts: \[\]/);
  assert.match(script, /tokenAnalyticsEnabled: false/);
  assert.match(script, /USERPROFILE: userHome/);
  assert.match(script, /APPDATA: appData/);
  assert.match(script, /LOCALAPPDATA: localAppData/);
  assert.match(script, /delete env\.ELECTRON_RUN_AS_NODE/);
  assert.match(script, /Windows USERPROFILE isolation preflight failed/);
  assert.match(script, /homeProbe\.stdout\.trim\(\)/);
  assert.match(script, /taskkill\.exe/);
  assert.doesNotMatch(script, /rotateCollectorToken|browser-profiles.*rm\(/);
});

test("packaged diagnostics are opt-in and never print raw collector stderr", async () => {
  const main = await readFile(
    new URL("../desktop/electron-ipc/main.js", import.meta.url), "utf8",
  );
  assert.match(main, /process\.env\.QUOTAOPS_STARTUP_DIAGNOSTICS === "1"/);
  assert.match(main, /stdio: STARTUP_DIAGNOSTICS \? "pipe" : "ignore"/);
  assert.match(main, /collector_stderr_\$\{classifyCollectorError\(chunk\)\}/);
  assert.doesNotMatch(main, /console\.log\(chunk\)|process\.stdout\.write\(String\(chunk\)\)/);
  assert.match(main, /firstInstance \? "instance_lock_acquired" : "instance_lock_rejected"/);
});
