import assert from "node:assert/strict";
import test from "node:test";

import {
  BROWSER_CLOSE_TIMEOUT_MS,
  BROWSER_LAUNCH_TIMEOUT_MS,
  CollectionCancelledError,
  PAGE_EVALUATE_TIMEOUT_MS,
  withCancellableContext,
  withTimeout,
} from "../collector/browser-session.ts";
import { readFile } from "node:fs/promises";

// Issue #47: shutdown must close an isolated provider browser promptly,
// whatever the provider page is doing. A fake context stands in for
// Playwright; close() is what rejects pending navigations in the real one.
function fakeContext() {
  let closes = 0;
  let onClose: (() => void) | null = null;
  return {
    get closes() { return closes; },
    closed: new Promise<void>((resolve) => { onClose = resolve; }),
    async close() {
      closes++;
      onClose?.();
    },
  };
}

test("aborting during work closes the context at once and reports cancellation", async () => {
  const context = fakeContext();
  const abort = new AbortController();
  const started = Date.now();
  const running = withCancellableContext(
    async () => context,
    // A provider page parked on a challenge: never settles by itself.
    () => new Promise<string>(() => {}),
    abort.signal,
  );
  setTimeout(() => abort.abort(), 20);
  await assert.rejects(running, CollectionCancelledError);
  assert.ok(Date.now() - started < 1_000);
  assert.equal(context.closes, 1);
});

test("aborting during launch returns promptly and closes the late context", async () => {
  const context = fakeContext();
  let finishLaunch!: () => void;
  const abort = new AbortController();
  let workRan = false;
  const running = withCancellableContext(
    () => new Promise<typeof context>((resolve) => { finishLaunch = () => resolve(context); }),
    async () => { workRan = true; return 1; },
    abort.signal,
  );
  abort.abort();
  await assert.rejects(running, CollectionCancelledError);
  assert.equal(context.closes, 0);
  finishLaunch();
  await context.closed;
  assert.equal(context.closes, 1, "a browser launched after cancellation must not keep the profile");
  assert.equal(workRan, false);
});

test("an already-cancelled collection never launches a browser", async () => {
  const abort = new AbortController();
  abort.abort();
  let launched = false;
  await assert.rejects(
    withCancellableContext(async () => { launched = true; return fakeContext(); }, async () => 1, abort.signal),
    CollectionCancelledError,
  );
  assert.equal(launched, false);
});

test("normal completion and provider errors both close the context exactly once", async () => {
  const ok = fakeContext();
  assert.equal(await withCancellableContext(async () => ok, async () => "value"), "value");
  assert.equal(ok.closes, 1);

  const failing = fakeContext();
  await assert.rejects(
    withCancellableContext(async () => failing, async () => { throw new Error("provider"); }),
    /provider/,
  );
  assert.equal(failing.closes, 1);
});

test("a close() that never settles cannot stall the collection queue", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const context = { close: () => new Promise<void>(() => {}) };
  let settled = false;
  const running = withCancellableContext(async () => context, async () => 1)
    .then((value) => { settled = true; return value; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  t.mock.timers.tick(BROWSER_CLOSE_TIMEOUT_MS);
  assert.equal(await running, 1);
});

test("a close() failure does not mask the collection result", async () => {
  const context = { close: async () => { throw new Error("already closed"); } };
  assert.equal(await withCancellableContext(async () => context, async () => 7), 7);
});

test("withTimeout yields the not-observed fallback for an unresponsive page read", async () => {
  const started = Date.now();
  assert.equal(await withTimeout(new Promise<string>(() => {}), 30, "fallback"), "fallback");
  assert.ok(Date.now() - started < 1_000);
  assert.equal(await withTimeout(Promise.resolve("value"), 1_000, "fallback"), "value");
});

test("launch and in-page reads have explicit bounds well below Playwright defaults", async () => {
  // Playwright's launch default is 180 s per channel, with a second channel
  // as fallback; page.evaluate has no default bound at all.
  assert.ok(BROWSER_LAUNCH_TIMEOUT_MS <= 30_000);
  assert.ok(PAGE_EVALUATE_TIMEOUT_MS <= 10_000);
  for (const file of ["../collector/browser.ts", "../collector/openai.ts"]) {
    const source = await readFile(new URL(file, import.meta.url), "utf8");
    assert.match(source, /timeout: BROWSER_LAUNCH_TIMEOUT_MS/, `${file} launch must be bounded`);
    assert.match(source, /withCancellableContext\(/, `${file} collection must be cancellable`);
    assert.doesNotMatch(source, /await page\.evaluate\(/, `${file} has an unbounded page.evaluate`);
  }
});
