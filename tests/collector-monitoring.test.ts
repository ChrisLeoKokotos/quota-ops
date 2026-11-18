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

// Issue #47 regressions. Before the fix waitUntilIdle() had no bound and the
// collect callback received no signal, so a provider page that never settled
// held collector shutdown (and Quit) open indefinitely.
test("waitUntilIdle is bounded when an in-flight collection never settles", async () => {
  const controller = new MonitoringController<number>(
    () => new Promise<number>(() => {}),
    () => undefined,
  );
  controller.queueRefresh();
  assert.equal(controller.status().collecting, true);
  controller.pause();
  const started = Date.now();
  const drained = await controller.waitUntilIdle(80);
  const elapsed = Date.now() - started;
  assert.equal(drained, false, "a stuck collection must be reported, not awaited forever");
  assert.ok(elapsed < 1_000, `bounded wait took ${elapsed} ms`);
});

test("stop aborts the in-flight collection's signal so its browser can close", async () => {
  let seen: AbortSignal | null = null;
  const controller = new MonitoringController<string>(
    (_invalidated, signal) => {
      seen = signal;
      return new Promise<string>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
      });
    },
    () => undefined,
  );
  controller.queueRefresh();
  await until(() => seen !== null);
  assert.equal(seen!.aborted, false);
  controller.stop();
  assert.equal(seen!.aborted, true);
  assert.equal(await controller.waitUntilIdle(1_000), true);
  assert.equal(controller.status().collecting, false);
});

test("pause keeps draining semantics: the active collection is not aborted", async () => {
  const gate = deferred<void>();
  let seen: AbortSignal | null = null;
  const controller = new MonitoringController<number>(async (_invalidated, signal) => {
    seen = signal;
    await gate.promise;
    return 1;
  }, () => undefined);
  controller.queueRefresh();
  await until(() => seen !== null);
  controller.pause();
  assert.equal(seen!.aborted, false, "Pause must not change from drain to cancel");
  gate.resolve();
  assert.equal(await controller.waitUntilIdle(1_000), true);
});

test("waitUntilIdle reports idle immediately when nothing is collecting", async () => {
  const controller = new MonitoringController(async () => 1, () => undefined);
  assert.equal(await controller.waitUntilIdle(0), true);
});

test("a paused controller cannot be refreshed by a scheduled tick", async () => {
  let calls = 0;
  const controller = new MonitoringController(async () => ++calls, () => undefined);
  controller.pause();
  assert.equal(controller.queueRefresh(), false);
  assert.equal(calls, 0);
});
