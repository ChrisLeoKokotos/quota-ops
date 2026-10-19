import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
interface SchedulerStatus {
  paused: boolean;
  running: boolean;
  cancelled: boolean;
  lastSuccessAt: number | null;
  lastAttemptAt: number | null;
  ageMs: number | null;
  stale: boolean;
  consecutiveFailures: number;
  lastError: string | null;
  msUntilDue: number | null;
  intervalMs: number;
}

interface Scheduler {
  intervalMs: number;
  consecutiveFailures: number;
  lastError: string | null;
  lastResult: unknown;
  lastSuccessAt: number | null;
  nextDelayMs(): number;
  msUntilDue(): number | null;
  isDue(): boolean;
  refresh(options?: { force?: boolean }): Promise<Record<string, unknown>>;
  pause(): void;
  resume(): void;
  cancel(): void;
  status(): SchedulerStatus;
}

const scheduling = require("../desktop/electron-ipc/scheduler.js") as {
  RefreshScheduler: new (options: {
    collect: () => Promise<unknown>;
    intervalMs?: number;
    now?: () => number;
  }) => Scheduler;
  MAX_BACKOFF_MS: number;
  STALE_AFTER_MS: number;
};
const { RefreshScheduler, MAX_BACKOFF_MS, STALE_AFTER_MS } = scheduling;

/** A clock the test moves by hand, so nothing waits on real time. */
function clock(start = 1_760_000_000_000) {
  let value = start;
  return {
    now: () => value,
    advance: (ms: number) => {
      value += ms;
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("the first refresh is due immediately, the next one after the interval", async () => {
  const time = clock();
  const scheduler = new RefreshScheduler({
    collect: async () => "snapshot",
    intervalMs: 60_000,
    now: time.now,
  });

  assert.equal(scheduler.isDue(), true);
  assert.deepEqual(await scheduler.refresh(), { ok: true, value: "snapshot" });

  assert.equal(scheduler.isDue(), false);
  assert.equal(scheduler.msUntilDue(), 60_000);

  time.advance(59_999);
  assert.equal(scheduler.isDue(), false);
  time.advance(1);
  assert.equal(scheduler.isDue(), true);
});

test("a second refresh joins the one already running instead of starting another", async () => {
  const time = clock();
  const gate = deferred<string>();
  let started = 0;

  const scheduler = new RefreshScheduler({
    collect: () => {
      started += 1;
      return gate.promise;
    },
    intervalMs: 60_000,
    now: time.now,
  });

  const first = scheduler.refresh();
  const second = scheduler.refresh({ force: true });

  gate.resolve("snapshot");
  const [a, b] = await Promise.all([first, second]);

  // Two browsers against one profile is the failure this guards.
  assert.equal(started, 1, "collect ran more than once concurrently");
  assert.deepEqual(a, { ok: true, value: "snapshot" });
  assert.deepEqual(b, a);
});

test("a paused scheduler refuses scheduled work but honours an explicit refresh", async () => {
  const time = clock();
  const scheduler = new RefreshScheduler({
    collect: async () => "snapshot",
    intervalMs: 60_000,
    now: time.now,
  });

  scheduler.pause();

  assert.equal(scheduler.msUntilDue(), null);
  assert.deepEqual(await scheduler.refresh(), { ok: false, reason: "paused" });

  // "Refresh now" is a user action and should still work while paused.
  assert.deepEqual(await scheduler.refresh({ force: true }), {
    ok: true,
    value: "snapshot",
  });
});

test("resuming clears the backoff so a recovered provider is retried promptly", async () => {
  const time = clock();
  let failing = true;

  const scheduler = new RefreshScheduler({
    collect: async () => {
      if (failing) throw new Error("provider unavailable");
      return "snapshot";
    },
    intervalMs: 60_000,
    now: time.now,
  });

  for (let attempt = 0; attempt < 3; attempt += 1) {
    await scheduler.refresh({ force: true });
  }
  assert.equal(scheduler.consecutiveFailures, 3);
  assert.equal(scheduler.nextDelayMs() > 60_000, true);

  failing = false;
  scheduler.pause();
  scheduler.resume();

  assert.equal(scheduler.consecutiveFailures, 0);
  assert.equal(scheduler.nextDelayMs(), 60_000);
});

test("failures back off exponentially and stop at the cap", async () => {
  const time = clock();
  const scheduler = new RefreshScheduler({
    collect: async () => {
      throw new Error("provider unavailable");
    },
    intervalMs: 60_000,
    now: time.now,
  });

  const delays: number[] = [];
  for (let attempt = 0; attempt < 12; attempt += 1) {
    await scheduler.refresh({ force: true });
    delays.push(scheduler.nextDelayMs());
  }

  // Strictly increasing until the cap, then flat. Retrying a down provider
  // at the normal interval wastes a browser launch every time.
  assert.equal((delays[0] ?? 0) > 60_000, true);
  assert.equal((delays[1] ?? 0) > (delays[0] ?? 0), true);
  assert.equal(Math.max(...delays) <= MAX_BACKOFF_MS, true);
  assert.equal(delays.at(-1), MAX_BACKOFF_MS);
});

test("a success after failures restores the normal interval", async () => {
  const time = clock();
  let failing = true;

  const scheduler = new RefreshScheduler({
    collect: async () => {
      if (failing) throw new Error("down");
      return "snapshot";
    },
    intervalMs: 60_000,
    now: time.now,
  });

  await scheduler.refresh({ force: true });
  await scheduler.refresh({ force: true });
  assert.equal(scheduler.nextDelayMs() > 60_000, true);

  failing = false;
  await scheduler.refresh({ force: true });

  assert.equal(scheduler.consecutiveFailures, 0);
  assert.equal(scheduler.nextDelayMs(), 60_000);
  assert.equal(scheduler.lastError, null);
});

test("cancelling mid-run discards the result rather than publishing it late", async () => {
  const time = clock();
  const gate = deferred<string>();

  const scheduler = new RefreshScheduler({
    collect: () => gate.promise,
    intervalMs: 60_000,
    now: time.now,
  });

  const run = scheduler.refresh();
  scheduler.cancel();
  gate.resolve("snapshot");

  // The user asked collection to stop; a late write would look like it
  // carried on regardless.
  assert.deepEqual(await run, { ok: false, reason: "cancelled" });
  assert.equal(scheduler.lastResult, null);
  assert.equal(scheduler.lastSuccessAt, null);
});

test("a cancelled scheduler refuses further work, forced or not", async () => {
  const scheduler = new RefreshScheduler({ collect: async () => "snapshot" });
  scheduler.cancel();

  assert.deepEqual(await scheduler.refresh(), { ok: false, reason: "cancelled" });
  assert.deepEqual(await scheduler.refresh({ force: true }), {
    ok: false,
    reason: "cancelled",
  });
  assert.equal(scheduler.msUntilDue(), null);
});

test("data is reported stale before it is reported missing", async () => {
  const time = clock();
  const scheduler = new RefreshScheduler({
    collect: async () => "snapshot",
    intervalMs: 60_000,
    now: time.now,
  });

  // Nothing collected yet: stale is true, because there is no fresh data.
  assert.equal(scheduler.status().stale, true);
  assert.equal(scheduler.status().lastSuccessAt, null);

  await scheduler.refresh();
  assert.equal(scheduler.status().stale, false);

  time.advance(STALE_AFTER_MS);
  assert.equal(scheduler.status().stale, false, "exactly at the threshold is not yet stale");

  time.advance(1);
  const status = scheduler.status();
  assert.equal(status.stale, true);
  // The data is still there. It is labelled old, not thrown away.
  assert.equal(scheduler.lastResult, "snapshot");
  assert.equal(status.ageMs, STALE_AFTER_MS + 1);
});

test("the interval is floored so a setting cannot cause a polling loop", () => {
  const scheduler = new RefreshScheduler({ collect: async () => null, intervalMs: 1 });
  assert.equal(scheduler.intervalMs, 30_000);
});

test("status reports a failure without inventing a successful collection", async () => {
  const time = clock();
  const scheduler = new RefreshScheduler({
    collect: async () => {
      throw new Error("provider unavailable");
    },
    intervalMs: 60_000,
    now: time.now,
  });

  await scheduler.refresh();
  const status = scheduler.status();

  assert.equal(status.lastSuccessAt, null);
  assert.equal(status.stale, true);
  assert.equal(status.consecutiveFailures, 1);
  assert.equal(status.lastError, "provider unavailable");
  assert.notEqual(status.lastAttemptAt, null);
});

test("a scheduler without a collect function is rejected at construction", () => {
  assert.throws(() => new RefreshScheduler({} as never), TypeError);
});
