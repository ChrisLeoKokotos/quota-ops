import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// Measured on the packaged app (Nov 2026): idle private memory 319 MB with
// GPU acceleration, 242 MB without. Windows defaults to software rendering;
// QUOTAOPS_HARDWARE_ACCELERATION=1 is the diagnostic opt-out.
test("Windows disables hardware acceleration before the app is ready", async () => {
  const main = await readFile(new URL("../desktop/electron-ipc/main.js", import.meta.url), "utf8");
  assert.match(main, /process\.platform === "win32" && process\.env\.QUOTAOPS_HARDWARE_ACCELERATION !== "1"\) \{\s*app\.disableHardwareAcceleration\(\);/);
  assert.ok(
    main.indexOf("app.disableHardwareAcceleration()") < main.indexOf("app.whenReady()"),
    "must run before the ready event",
  );
});
