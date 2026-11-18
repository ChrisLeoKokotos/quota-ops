/**
 * Serializes the *actual provider collection*, not just Electron's snapshot
 * polling. Pause invalidates an in-flight batch and prevents further profiles
 * from opening; the active profile finishes and closes normally.
 *
 * Stop (collector shutdown) additionally aborts the in-flight collection's
 * signal, which closes its browser profile at once. Shutdown must not depend
 * on provider page timing (issue #47).
 *
 * No state or tokens are persisted by this class.
 */
export type CollectFn<T> = (
  invalidated: () => boolean,
  signal: AbortSignal,
) => Promise<T>;

export class MonitoringController<T> {
  private paused = false;
  private stopped = false;
  private generation = 0;
  private inFlight: Promise<void> | null = null;
  private inFlightAbort: AbortController | null = null;
  private pending = false;
  private lastSuccessAt: string | null = null;

  private readonly collect: CollectFn<T>;
  private readonly publish: (value: T, at: string) => void;

  // Node.js 22's strip-only TypeScript loader cannot execute parameter
  // properties. Use ordinary constructor assignments for the collector's
  // runtime code so CLI tests and the installed app share a valid syntax.
  constructor(
    collect: CollectFn<T>,
    publish: (value: T, at: string) => void,
  ) {
    this.collect = collect;
    this.publish = publish;
  }

  status(): { paused: boolean; collecting: boolean; lastSuccessAt: string | null } {
    return {
      paused: this.paused,
      collecting: this.inFlight !== null,
      lastSuccessAt: this.lastSuccessAt,
    };
  }

  pause(): void {
    this.paused = true;
    this.pending = false;
    this.generation++;
  }

  resume(): void {
    if (this.stopped) return;
    this.paused = false;
    this.generation++;
    this.queueRefresh();
  }

  stop(): void {
    this.stopped = true;
    this.pause();
    this.inFlightAbort?.abort();
  }

  /**
   * Wait for the in-flight collection to settle, for at most `timeoutMs`.
   * Resolves true when idle, false when the bound expired first. Unbounded
   * waiting here is what let Quit hang on a stuck provider page.
   */
  async waitUntilIdle(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (this.inFlight) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const expired = await Promise.race([
        this.inFlight.then(() => false),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(true), remaining);
        }),
      ]);
      if (timer !== undefined) clearTimeout(timer);
      if (expired) return false;
    }
    return true;
  }

  /** Schedule an immediate refresh. No parallel browser profile launches. */
  queueRefresh(): boolean {
    if (this.paused || this.stopped) return false;
    if (this.inFlight) {
      this.pending = true;
      return true;
    }
    const generation = this.generation;
    const invalidated = () =>
      this.paused || this.stopped || this.generation !== generation;

    const abort = new AbortController();
    this.inFlightAbort = abort;
    this.inFlight = (async () => {
      try {
        const value = await this.collect(invalidated, abort.signal);
        if (!invalidated()) {
          const now = new Date().toISOString();
          this.publish(value, now);
          this.lastSuccessAt = now;
        }
      } catch {
        // Provider errors are represented in individual collector statuses.
        // Do not expose raw Playwright errors or secrets to the HTTP boundary.
      } finally {
        this.inFlight = null;
        if (this.inFlightAbort === abort) this.inFlightAbort = null;
        if (this.pending && !this.paused && !this.stopped) {
          this.pending = false;
          this.queueRefresh();
        }
      }
    })();
    return true;
  }
}
