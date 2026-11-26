import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// Lifecycle requirements: startup with port 4317 already taken, and recovery
// after the collector process is terminated unexpectedly (packaged E2E
// scenarios port-foreign and crash-recovery exercise the real app).
test("a taken port is reported with a distinct exit code instead of a crash", async () => {
  const service = await readFile(new URL("../collector/service.ts", import.meta.url), "utf8");
  assert.match(service, /server\.on\("error"/);
  assert.match(service, /process\.exit\(error\.code === "EADDRINUSE" \? 5 : 6\)/);
  assert.ok(service.indexOf('server.on("error"') < service.indexOf("server.listen(config.port"));
});

test("the desktop app restarts a crashed collector with backoff and a limit", async () => {
  const main = await readFile(new URL("../desktop/electron-ipc/main.js", import.meta.url), "utf8");
  assert.match(main, /const COLLECTOR_EXIT_PORT_IN_USE = 5;/);
  assert.match(main, /const COLLECTOR_RESTART_DELAYS_MS = \[2_000, 10_000, 30_000\];/);
  assert.match(main, /collectorRestartTimes\.length >= COLLECTOR_RESTART_DELAYS_MS\.length/);
  assert.match(main, /if \(!quitting\) onCollectorStoppedUnexpectedly\(code\);/);
  // A restart never fires after Quit started.
  const restart = main.slice(main.indexOf("setTimeout(() => {\n    if (quitting) return;"));
  assert.ok(restart.length > 0 || /setTimeout\(\(\) => \{\s*if \(quitting\) return;/.test(main));
  assert.match(main, /"Port 4317 is used by another program; QuotaOps cannot collect usage"/);
  assert.match(main, /"Using the QuotaOps collector already running on this PC"/);
});
