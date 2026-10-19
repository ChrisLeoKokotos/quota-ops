/**
 * How the dashboard reaches the collector.
 *
 * Two transports, selected at runtime:
 *
 * - **Desktop (IPC).** The Electron preload exposes `window.quotaops`. The
 *   renderer asks the main process for a snapshot and never sees the
 *   collector's bearer token, never issues an HTTP request, and has no
 *   network origin to attack. There is no dashboard HTTP listener at all in
 *   this mode, so the QO-SEC-01 loopback boundary and its Risk C relay
 *   exposure simply do not exist for the UI.
 *
 * - **Web (loopback HTTP).** The existing trusted-server path, kept so the
 *   browser dashboard and `npm run dev` continue to work unchanged.
 *
 * The renderer gets a read-only surface either way: it can request a snapshot
 * and nothing else.
 */

export interface SnapshotTransport {
  readonly kind: "ipc" | "http";
  fetchSnapshotPayload(signal?: AbortSignal): Promise<unknown>;
}

/** The narrow surface the Electron preload is allowed to expose. */
export interface QuotaOpsBridge {
  readonly version: 1;
  getSnapshot(): Promise<unknown>;
}

declare global {
  interface Window {
    quotaops?: QuotaOpsBridge;
  }
}

export function getDesktopBridge(): QuotaOpsBridge | null {
  if (typeof window === "undefined") return null;
  const bridge = window.quotaops;
  if (!bridge || bridge.version !== 1) return null;
  if (typeof bridge.getSnapshot !== "function") return null;
  return bridge;
}

export function isDesktopRuntime(): boolean {
  return getDesktopBridge() !== null;
}
