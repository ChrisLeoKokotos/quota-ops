/**
 * Token analytics runs on its own clock, independent of provider quota
 * collection. A challenged, held, paused or failing Claude/OpenAI check must
 * never hide or freeze locally observed token totals.
 *
 * - With no consent: state "disabled", no snapshot, no file is opened.
 * - After consent (or at start with consent): state "scanning" until the
 *   first pass returns; passes repeat back-to-back (short pause) while files
 *   are still pending, then every few minutes to pick up new activity.
 * - A failed pass: state "unavailable" (the last good snapshot is kept but
 *   marked by the state), retried later.
 */
import type { TokenAnalyticsSnapshot, TokenScanStatus } from "../lib/token-analytics.ts";

export type { TokenScanState, TokenScanStatus } from "../lib/token-analytics.ts";

export interface TokenRunnerDeps {
  /** Null when no token source is consented. */
  scan: (signal: AbortSignal) => Promise<{ snapshot: TokenAnalyticsSnapshot; pending: boolean } | null>;
  /** Called only after an invalidated scan has settled, before its replacement. */
  clearCache?: () => void;
  now?: () => number;
  setTimer?: (run: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /** Pause between passes while files are pending. */
  pendingDelayMs?: number;
  /** Refresh interval once complete, and retry interval after a failure. */
  refreshMs?: number;
}

export class TokenRunner {
  private snapshotValue: TokenAnalyticsSnapshot | null = null;
  private statusValue: TokenScanStatus = { state: "disabled", scannedAt: null, pending: false };
  private running: Promise<void> | null = null;
  private again = false;
  private timer: unknown = null;
  private stopped = false;
  private generation = 0;
  private active: AbortController | null = null;
  private clearPending = false;
  private readonly deps: Required<TokenRunnerDeps>;

  constructor(deps: TokenRunnerDeps) {
    this.deps = {
      clearCache: () => undefined,
      now: () => Date.now(),
      setTimer: (run, ms) => {
        const handle = setTimeout(run, ms);
        handle.unref?.();
        return handle;
      },
      clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      pendingDelayMs: 1_000,
      refreshMs: 5 * 60_000,
      ...deps,
    };
  }

  get snapshot(): TokenAnalyticsSnapshot | null {
    return this.statusValue.state === "disabled" ? null : this.snapshotValue;
  }

  get status(): TokenScanStatus {
    return { ...this.statusValue };
  }

  /** Run a pass now (start, consent change). Concurrent calls coalesce. */
  trigger(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.running) {
      this.again = true;
      return this.running;
    }
    if (this.timer !== null) {
      this.deps.clearTimer(this.timer);
      this.timer = null;
    }
    if (this.clearPending) {
      this.deps.clearCache();
      this.clearPending = false;
    }
    const active = new AbortController();
    const generation = this.generation;
    this.active = active;
    this.running = this.pass(active.signal, generation).finally(() => {
      this.active = null;
      this.running = null;
      if (this.again && !this.stopped) {
        this.again = false;
        void this.trigger();
      }
    });
    return this.running;
  }

  /** Consent changed: hide old aggregates now, discard every old-generation result,
   * cooperatively stop reads and only clear caches after the old pass settles. */
  invalidate(): void {
    if (this.stopped) return;
    this.generation++;
    this.snapshotValue = null;
    this.statusValue = { state: "scanning", scannedAt: null, pending: false };
    this.clearPending = true;
    this.active?.abort();
    void this.trigger();
  }

  stop(): void {
    this.stopped = true;
    this.generation++;
    this.active?.abort();
    this.snapshotValue = null;
    this.statusValue = { state: "disabled", scannedAt: null, pending: false };
    if (this.timer !== null) this.deps.clearTimer(this.timer);
    this.timer = null;
  }

  private schedule(ms: number): void {
    if (this.stopped) return;
    if (this.timer !== null) this.deps.clearTimer(this.timer);
    this.timer = this.deps.setTimer(() => {
      this.timer = null;
      void this.trigger();
    }, ms);
  }

  private async pass(signal: AbortSignal, generation: number): Promise<void> {
    const obsolete = () => this.stopped || signal.aborted || generation !== this.generation;
    if (this.statusValue.state === "disabled" || this.statusValue.state === "unavailable") {
      // Say "scanning" at once; a previous good snapshot stays available.
      this.statusValue = { ...this.statusValue, state: "scanning" };
    }
    let result: Awaited<ReturnType<TokenRunnerDeps["scan"]>>;
    try {
      result = await this.deps.scan(signal);
    } catch {
      if (obsolete()) return;
      this.statusValue = { ...this.statusValue, state: "unavailable", pending: false };
      this.schedule(this.deps.refreshMs);
      return;
    }
    if (obsolete()) return;
    if (result === null) {
      this.snapshotValue = null;
      this.statusValue = { state: "disabled", scannedAt: null, pending: false };
      return;
    }
    this.snapshotValue = result.snapshot;
    this.statusValue = {
      state: "ready",
      scannedAt: new Date(this.deps.now()).toISOString(),
      pending: result.pending,
    };
    this.schedule(result.pending ? this.deps.pendingDelayMs : this.deps.refreshMs);
  }
}
