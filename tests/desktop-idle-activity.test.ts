import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// 2-hour idle run (Nov 2026, window hidden to tray): renderer +8 MB and main
// +11 MB. Both did periodic work nobody could see.
test("the tray menu is rebuilt only when what it shows has changed", async () => {
  const main = await readFile(new URL("../desktop/electron-ipc/main.js", import.meta.url), "utf8");
  const body = main.slice(main.indexOf("function refreshTray()"), main.indexOf("function showWindow()"));
  assert.match(body, /if \(key !== lastTrayMenuKey\) \{\s*tray\.setContextMenu\(Menu\.buildFromTemplate\(template\)\);/);
  assert.equal((main.match(/Menu\.buildFromTemplate\(/g) ?? []).length, 1, "one place builds native menus");
  // Per-account items carry the account id, so two accounts with the same
  // label cannot share a cached handler.
  assert.match(main, /id: `verify-\$\{entry\.id\}`/);
});

test("the hidden dashboard does not poll the collector; showing it refreshes at once", async () => {
  const dashboard = await readFile(new URL("../components/quota-dashboard.tsx", import.meta.url), "utf8");
  assert.match(dashboard, /if \(document\.visibilityState !== "hidden"\) void sync\(\);/);
  assert.match(dashboard, /document\.addEventListener\("visibilitychange", onVisibility\);/);
  assert.match(dashboard, /document\.removeEventListener\("visibilitychange", onVisibility\);/);
  // Reset notifications keep their own clock while hidden.
  assert.match(dashboard, /window\.setInterval\(\(\) => setNowMs\(Date\.now\(\)\), 30_000\)/);
});
