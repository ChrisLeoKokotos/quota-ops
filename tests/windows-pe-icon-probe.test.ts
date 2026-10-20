import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";

const hook = new URL("../desktop/branding/probe-pe-icon.cjs", import.meta.url);

test("experimental PE icon hooks parse under the owner Node runtime", () => {
  for (const relative of [
    "../desktop/branding/probe-pe-icon.cjs",
    "../desktop/branding/after-extract-pe.cjs",
    "../desktop/branding/after-pack-pe.cjs",
  ]) {
    const file = fileURLToPath(new URL(relative, import.meta.url));
    const result = spawnSync(process.execPath, ["--check", file], {
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.equal(result.status, 0, result.stderr);
  }
});

test("PE icon experiment is disabled by default and only affects test hooks", async () => {
  const code = await readFile(hook, "utf8");
  const base = JSON.parse(await readFile(new URL(
    "../desktop/electron-builder.json", import.meta.url), "utf8"));
  const experimental = JSON.parse(await readFile(new URL(
    "../desktop/electron-builder.unsigned-test.json", import.meta.url), "utf8"));
  assert.equal(Object.hasOwn(base, "afterExtract"), false);
  assert.equal(Object.hasOwn(base, "afterPack"), false);
  assert.equal(Object.hasOwn(base.win, "signAndEditExecutable"), false);
  assert.equal(experimental.win.signAndEditExecutable, false);
  assert.match(code, /process\.env\.QUOTAOPS_BRANDED_PE_PROBE === "1"/);
  assert.match(code, /if \(!ENABLED\) return/);
  assert.equal(experimental.publish, null);
});

test("pre-ASAR PE edit refuses an already embedded integrity resource", async () => {
  const code = await readFile(hook, "utf8");
  assert.match(code, /ASAR integrity already embedded/);
  assert.match(code, /resources\.outputResource\(executable\)/);
  assert.match(code, /IconGroupEntry\.replaceIconsForResource/);
  assert.match(code, /await rename\(stage, target\)/);
  assert.match(code, /app-builder-lib\/package\.json/);
  assert.match(code, /No ElectronAsar INTEGRITY resource/);
  assert.match(code, /largeIcon/);
});

test("CJS hook wrappers point to their own builder phases", () => {
  const require = createRequire(import.meta.url);
  const early = require("../desktop/branding/after-extract-pe.cjs") as
    { default: (ctx: unknown) => Promise<void> };
  const late = require("../desktop/branding/after-pack-pe.cjs") as
    { default: (ctx: unknown) => Promise<void> };
  assert.equal(typeof early.default, "function");
  assert.equal(typeof late.default, "function");
});
