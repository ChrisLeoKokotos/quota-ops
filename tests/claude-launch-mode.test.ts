import assert from "node:assert/strict";
import test from "node:test";

import { claudeLaunchMode } from "../collector/claude-launch-mode.ts";

test("normal Windows Claude collection uses headed browser minimized/offscreen", () => {
  const mode = claudeLaunchMode("win32", false);
  assert.equal(mode.headless, false);
  assert.ok(mode.args.includes("--start-minimized"));
  assert.ok(mode.args.includes("--window-position=-32000,-32000"));
  assert.ok(mode.args.includes("--window-size=1280,900"));
  assert.ok(mode.args.includes("--disable-extensions"));
});

test("explicit Windows --visible opens headed browser with no offscreen flags", () => {
  const mode = claudeLaunchMode("win32", true);
  assert.equal(mode.headless, false);
  assert.deepEqual(mode.args, ["--disable-extensions"]);
});

test("non-Windows default stays headless; explicit diagnostic is headed", () => {
  for (const platform of ["linux", "darwin"] as const) {
    assert.equal(claudeLaunchMode(platform, false).headless, true);
    assert.equal(claudeLaunchMode(platform, true).headless, false);
  }
});

test("no launch mode opens a remote DevTools TCP port or overrides browser security", () => {
  for (const platform of ["win32", "linux", "darwin"] as const) {
    for (const visible of [false, true]) {
      const joined = claudeLaunchMode(platform, visible).args.join(" ");
      assert.doesNotMatch(joined, /remote-debugging-(port|address)/);
      assert.doesNotMatch(joined, /no-sandbox|disable-web-security|ignore-certificate-errors/);
    }
  }
});
