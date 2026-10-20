/**
 * Serializes the *actual provider collection*, not just Electron's snapshot
 * polling. Pause invalidates an in-flight batch and prevents further profiles
 * from opening. The active Playwright request must finish and close its
 * context; this is a drain, not an immediate network kill.
 *
 * No state or tokens are persisted by this class.
 */
export class MonitoringController<T> {
  private paused = false;
  private stopped = false;
  private generation = 0;
  private inFlight: Promise<void> | null = null;
  private pending = false;
  private lastSuccessAt: string | null = null;

  private readonly collect: (invalidated: () => boolean) => Promise<T>;
  private readonly publish: (value: T, at: string) => void;

  // Node.js 22's strip-only TypeScript loader cannot execute parameter
  // properties. Use ordinary constructor assignments for the collector's
  // runtime code so CLI tests and the installed app share a valid syntax.
  constructor(
    collect: (invalidated: () => boolean) => Promise<T>,
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

    this.inFlight = (async () => {
      try {
        const value = await this.collect(invalidated);
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
        if (this.pending && !this.paused && !this.stopped) {
          this.pending = false;
          this.queueRefresh();
        }
      }
    })();
    return true;
  }
}
