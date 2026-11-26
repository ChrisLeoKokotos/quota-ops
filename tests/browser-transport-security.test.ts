import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Claude collector must not expose unauthenticated Chrome DevTools TCP ports", async () => {
  const source = await readFile(new URL("../collector/browser.ts", import.meta.url), "utf8");
  assert.equal(source.includes("connectOverCDP"), false);
  assert.equal(source.includes("--remote-debugging-port"), false);
  assert.equal(source.includes("--remote-debugging-address"), false);
  assert.equal(source.includes("launchPersistentContext"), true);
});

test("provider collectors must not send session secrets in normalized snapshots", async () => {
  const files = ["../collector/browser.ts", "../collector/openai.ts"];
  for (const file of files) {
    const source = await readFile(new URL(file, import.meta.url), "utf8");
    assert.equal(source.includes("storageState("), false);
    assert.equal(source.includes("Authorization: `Bearer ${accessToken}`") && file.endsWith("browser.ts"), false);
  }
});
