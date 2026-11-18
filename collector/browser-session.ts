/**
 * Bounded, cancellable lifetime for one isolated provider browser session.
 *
 * Before this module a collection could only end when Playwright's own timers
 * expired: `launchPersistentContext` used Playwright's 180-second default and
 * fell back to a second channel with the same default, and `page.evaluate`
 * has no timeout at all. Shutdown waited for that, so Quit depended on how a
 * provider page behaved (issue #47).
 *
 * Cancelling closes the context, which rejects every pending navigation and
 * evaluation in it. Launch itself cannot be aborted, so cancellation stops
 * waiting for it and closes whatever the launch produces later.
 *
 * Nothing here reads, logs or returns page content, cookies or profile data.
 */

/** Upper bound for starting one isolated profile, per browser channel. */
export const BROWSER_LAUNCH_TIMEOUT_MS = 30_000;
/** Upper bound for one bounded in-page read (panel text, challenge signals). */
export const PAGE_EVALUATE_TIMEOUT_MS = 5_000;

export class CollectionCancelledError extends Error {
  constructor() {
    super("collection_cancelled");
    this.name = "CollectionCancelledError";
  }
}

interface Closable {
  close(): Promise<unknown>;
}

function closeQuietly(context: Closable): Promise<void> {
  return context.close().then(() => undefined, () => undefined);
}

/** Resolves with `promise`, or rejects as cancelled as soon as `signal` aborts. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new CollectionCancelledError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new CollectionCancelledError());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/**
 * Launch a context, run `work` against it and always close it.
 *
 * When `signal` aborts the context is closed immediately (not after `work`
 * finishes) and the call rejects with CollectionCancelledError.
 */
export async function withCancellableContext<C extends Closable, T>(
  launch: () => Promise<C>,
  work: (context: C) => Promise<T>,
  signal?: AbortSignal | undefined,
): Promise<T> {
  if (signal?.aborted) throw new CollectionCancelledError();

  const launching = launch();
  let context: C;
  try {
    context = await untilAborted(launching, signal);
  } catch (error) {
    // A launch that completes after cancellation must not leave a browser
    // holding the profile lock.
    launching.then(closeQuietly, () => undefined);
    throw error;
  }

  let closing: Promise<void> | null = null;
  const close = () => (closing ??= closeQuietly(context));
  const onAbort = () => { void close(); };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const value = await untilAborted(work(context), signal);
    if (signal?.aborted) throw new CollectionCancelledError();
    return value;
  } catch (error) {
    if (signal?.aborted) throw new CollectionCancelledError();
    throw error;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    await close();
  }
}

/**
 * Resolve `promise`, or `fallback` after `ms`. For in-page reads that have no
 * Playwright timeout; the caller treats the fallback as "not observed", never
 * as a usage value.
 */
export async function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
