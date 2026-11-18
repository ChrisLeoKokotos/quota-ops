import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { collectionLaunchMode } from "../collector/claude-launch-mode.ts";

// Owner P0 (Nov 2026): background collection must never take the foreground
// or receive keyboard input. Headed "minimized/off-screen" did both.
test("background collection is headless on every platform", () => {
  const mode = collectionLaunchMode("background");
  assert.equal(mode.headless, true);
  assert.deepEqual(mode.args, ["--disable-extensions"]);
});

test("visible collection is an ordinary headed window, nothing hidden", () => {
  const mode = collectionLaunchMode("visible");
  assert.equal(mode.headless, false);
  assert.deepEqual(mode.args, ["--disable-extensions"]);
});

test("no launch mode opens a DevTools TCP port, changes the user agent or weakens security", () => {
  for (const presentation of ["background", "visible"] as const) {
    const joined = collectionLaunchMode(presentation).args.join(" ");
    assert.doesNotMatch(joined, /remote-debugging-(port|address)/);
    assert.doesNotMatch(joined, /user-agent|no-sandbox|disable-web-security|ignore-certificate-errors|disable-blink-features/);
  }
});

test("no collector source hides a headed window off-screen or starts it minimized", async () => {
  for (const file of ["browser.ts", "openai.ts", "claude-launch-mode.ts", "provider.ts", "service.ts"]) {
    const source = await readFile(new URL(`../collector/${file}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /--start-minimized|--window-position=-32000|"headless: false"/, file);
  }
  for (const file of ["browser.ts", "openai.ts"]) {
    const source = await readFile(new URL(`../collector/${file}`, import.meta.url), "utf8");
    assert.match(source, /collectionLaunchMode\(/, `${file} must use the shared launch mode`);
  }
});
