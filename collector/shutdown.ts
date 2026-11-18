/**
 * Bounded collector shutdown (issue #47).
 *
 * The previous handler waited for the in-flight provider collection with no
 * bound, then for `server.close()`, which itself waits for keep-alive sockets.
 * A provider page that never settled therefore kept the utility process, its
 * browser and the authenticated loopback listener alive; only the Electron
 * parent's kill timer could end it.
 *
 * Order now: stop scheduling, cancel the in-flight collection (closes its
 * browser profile), wait at most `drainMs`, close the listener including
 * idle keep-alive sockets, exit. An independent `hardExitMs` timer exits even
 * if one of those steps stalls. Results of a cancelled batch are discarded.
 */

export const SHUTDOWN_DRAIN_MS = 8_000;
export const SHUTDOWN_HARD_EXIT_MS = 12_000;

/** Exit codes: diagnostics only; the parent treats any exit as complete. */
export const EXIT_DRAINED = 0;
export const EXIT_DRAIN_TIMEOUT = 3;
export const EXIT_HARD_DEADLINE = 4;

export interface ShutdownDeps {
  monitoring: {
    stop(): void;
    waitUntilIdle(timeoutMs: number): Promise<boolean>;
  };
  server: {
    close(callback?: (error?: Error) => void): unknown;
    closeAllConnections(): void;
  };
  /** Stop timers that would queue new collections. */
  stopScheduling(): void;
  exit(code: number): void;
  drainMs?: number;
  hardExitMs?: number;
}

export function createCollectorShutdown(deps: ShutdownDeps): () => void {
  const drainMs = deps.drainMs ?? SHUTDOWN_DRAIN_MS;
  const hardExitMs = deps.hardExitMs ?? SHUTDOWN_HARD_EXIT_MS;
  let started = false;
  let exited = false;
  const exitOnce = (code: number) => {
    if (exited) return;
    exited = true;
    deps.exit(code);
  };

  return () => {
    if (started) return;
    started = true;

    // Armed first, so no later step can make shutdown indefinite. unref():
    // it must not by itself keep an otherwise finished process alive.
    const hardExit = setTimeout(() => exitOnce(EXIT_HARD_DEADLINE), hardExitMs);
    hardExit.unref?.();

    deps.stopScheduling();
    deps.monitoring.stop();

    void deps.monitoring
      .waitUntilIdle(drainMs)
      .catch(() => false)
      .then((drained) => {
        try {
          deps.server.close(() => {
            clearTimeout(hardExit);
            exitOnce(drained ? EXIT_DRAINED : EXIT_DRAIN_TIMEOUT);
          });
          // close() alone waits for idle keep-alive sockets (up to the
          // server's keepAliveTimeout) before its callback runs.
          deps.server.closeAllConnections();
        } catch {
          clearTimeout(hardExit);
          exitOnce(EXIT_DRAIN_TIMEOUT);
        }
      });
  };
}
