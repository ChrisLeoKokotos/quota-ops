// Background refresh scheduling for the desktop shell.
//
// Separated from Electron so the policy can be driven with a fake clock in
// tests. The hard parts here are not the timer; they are the states a naive
// scheduler gets wrong:
//
//   * collecting twice at once because a slow run overlapped the next tick
//   * hammering a failing provider instead of backing off
//   * a pause that only stops the next tick and lets the current one finish
//     writing results
//   * forgetting that stale data is still useful, and that "stale" must be
//     visible rather than silently presented as current
//
// Nothing here opens a browser or touches the network. It decides *when*.

"use strict";

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
const MIN_INTERVAL_MS = 30 * 1000;
const MAX_BACKOFF_MS = 30 * 60 * 1000;
/** A snapshot older than this is reported stale rather than current. */
const STALE_AFTER_MS = 15 * 60 * 1000;

class RefreshScheduler {
  /**
   * @param {object} options
   * @param {() => Promise<unknown>} options.collect  performs one refresh
   * @param {number} [options.intervalMs]             base interval
   * @param {() => number} [options.now]              injectable clock
   */
  constructor(options) {
    if (typeof options?.collect !== "function") {
      throw new TypeError("a collect function is required");
    }

    this.collect = options.collect;
    this.now = options.now ?? Date.now;
    this.intervalMs = Math.max(MIN_INTERVAL_MS, options.intervalMs ?? DEFAULT_INTERVAL_MS);

    this.paused = false;
    this.running = false;
    this.cancelled = false;
    this.lastSuccessAt = null;
    this.lastAttemptAt = null;
    this.lastError = null;
    this.consecutiveFailures = 0;
    this.lastResult = null;
    /** Set while a run is in flight so callers can await the same one. */
    this.inFlight = null;
  }

  /**
   * Exponential backoff after failures, capped.
   *
   * A provider that is down stays down for a while; retrying at the normal
   * interval wastes a browser launch each time and can look like abuse.
   */
  nextDelayMs() {
    if (this.consecutiveFailures === 0) return this.intervalMs;
    const factor = Math.min(2 ** this.consecutiveFailures, MAX_BACKOFF_MS / this.intervalMs);
    return Math.min(this.intervalMs * factor, MAX_BACKOFF_MS);
  }

  /** Milliseconds until the next refresh is due, or null while paused. */
  msUntilDue() {
    if (this.paused || this.cancelled) return null;
    if (this.lastAttemptAt === null) return 0;
    const due = this.lastAttemptAt + this.nextDelayMs();
    return Math.max(0, due - this.now());
  }

  isDue() {
    const remaining = this.msUntilDue();
    return remaining !== null && remaining === 0;
  }

  /**
   * Runs one refresh, or joins the one already running.
   *
   * `force` is for an explicit "Refresh now": it ignores the schedule but
   * still refuses to start a second concurrent collection, because two
   * browsers against one profile is the failure this guards.
   */
  async refresh({ force = false } = {}) {
    if (this.cancelled) return { ok: false, reason: "cancelled" };
    if (this.inFlight) return this.inFlight;
    if (!force && (this.paused || !this.isDue())) {
      return { ok: false, reason: this.paused ? "paused" : "not_due" };
    }

    this.lastAttemptAt = this.now();
    this.running = true;

    this.inFlight = (async () => {
      try {
        const value = await this.collect();

        // A pause or quit during the run must not publish its result: the
        // user asked for collection to stop, and a late write would look
        // like it carried on.
        if (this.cancelled) return { ok: false, reason: "cancelled" };

        this.lastResult = value;
        this.lastSuccessAt = this.now();
        this.lastError = null;
        this.consecutiveFailures = 0;
        return { ok: true, value };
      } catch (error) {
        this.consecutiveFailures += 1;
        // The message is kept for the UI's status line; the caller decides
        // whether it is safe to show.
        this.lastError = error instanceof Error ? error.message : String(error);
        return { ok: false, reason: "failed", error: this.lastError };
      } finally {
        this.running = false;
        this.inFlight = null;
      }
    })();

    return this.inFlight;
  }

  pause() {
    this.paused = true;
  }

  resume() {
    this.paused = false;
    this.consecutiveFailures = 0;
  }

  /** Stops scheduling permanently; an in-flight run will not publish. */
  cancel() {
    this.cancelled = true;
    this.paused = true;
  }

  /**
   * The status the tray and the dashboard show.
   *
   * `stale` is deliberately separate from `lastSuccessAt`: a reader who only
   * sees a timestamp will treat it as current, and the whole point is that
   * old data stays visible while being labelled old.
   */
  status() {
    const now = this.now();
    const age = this.lastSuccessAt === null ? null : now - this.lastSuccessAt;

    return {
      paused: this.paused,
      running: this.running,
      cancelled: this.cancelled,
      lastSuccessAt: this.lastSuccessAt,
      lastAttemptAt: this.lastAttemptAt,
      ageMs: age,
      stale: age === null ? true : age > STALE_AFTER_MS,
      consecutiveFailures: this.consecutiveFailures,
      lastError: this.lastError,
      msUntilDue: this.msUntilDue(),
      intervalMs: this.intervalMs,
    };
  }
}

module.exports = {
  DEFAULT_INTERVAL_MS,
  MAX_BACKOFF_MS,
  MIN_INTERVAL_MS,
  RefreshScheduler,
  STALE_AFTER_MS,
};
