import assert from "node:assert/strict";
import test from "node:test";

import { MonitoringController } from "../collector/monitoring.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
async function until(condition: () => boolean, attempts = 40) {
  for (let i = 0; i < attempts; i++) {
    if (condition()) return;
    await new Promise((r) => setTimeout(r, 0));
  }
  assert.fail("condition did not become true");
}

test("pause stops new provider profiles and drops the old batch", async () => {
  const gate = deferred<void>();
  const starts: string[] = [];
  const published: string[][] = [];
  const controller = new MonitoringController(async (invalidated) => {
    const results: string[] = [];
    for (const name of ["dev-1", "dev-2", "dev-3"]) {
      if (invalidated()) return null;
      starts.push(name);
      if (name === "dev-1") await gate.promise;
      results.push(name);
    }
    return results;
  }, (result) => { if (result) published.push(result); });

  assert.equal(controller.queueRefresh(), true);
  await until(() => starts.length === 1);
  controller.pause();
  assert.equal(controller.status().paused, true);
  assert.equal(controller.queueRefresh(), false);
  gate.resolve();
  await until(() => !controller.status().collecting);
  assert.deepEqual(starts, ["dev-1"]);
  assert.deepEqual(published, []);
  assert.equal(controller.status().lastSuccessAt, null);
});

test("resume during an active batch does not publish the invalidated result or overlap profiles", async () => {
  const gate = deferred<void>();
  let active = 0;
  let peak = 0;
  let starts = 0;
  const published: number[] = [];
  const controller = new MonitoringController(async () => {
    active++;
    peak = Math.max(peak, active);
    starts++;
    if (starts === 1) await gate.promise;
    active--;
    return starts;
  }, (result) => published.push(result));

  controller.queueRefresh();
  await until(() => starts === 1);
  controller.pause();
  controller.resume();
  assert.equal(controller.queueRefresh(), true);
  gate.resolve();
  await until(() => starts === 2 && !controller.status().collecting);
  assert.equal(peak, 1, "browser sessions overlapped");
  assert.deepEqual(published, [2]);
  assert.ok(controller.status().lastSuccessAt);
});

test("stopping rejects all future refreshes, even after resume", async () => {
  const results: number[] = [];
  const controller = new MonitoringController(async () => 1, (value) => results.push(value));
  controller.stop();
  controller.resume();
  assert.equal(controller.queueRefresh(), false);
  assert.deepEqual(results, []);
});

test("a paused controller cannot be refreshed by a scheduled tick", async () => {
  let calls = 0;
  const controller = new MonitoringController(async () => ++calls, () => undefined);
  controller.pause();
  assert.equal(controller.queueRefresh(), false);
  assert.equal(calls, 0);
});
