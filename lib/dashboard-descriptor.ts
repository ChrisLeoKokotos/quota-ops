import { randomBytes } from "node:crypto";
import { readFileSync, unlinkSync } from "node:fs";
import { chmod, mkdir, rename, rm, writeFile, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

/**
 * Runtime descriptor for the dynamically allocated dashboard port (Risk C,
 * option C2).
 *
 * The dashboard no longer listens on a fixed 3000, so the launcher and the
 * future desktop shell need a way to find it. This file is that way.
 *
 * It is **not** a credential. It holds no HMAC secret and no bearer token, and
 * the port it names is not an authentication secret — a dynamic port raises
 * the cost of a preconfigured relay, it does not replace the loopback peer
 * check or the capability. A reader must therefore never treat the file's
 * contents as proof that the listener on that port is QuotaOps: it confirms
 * identity by asking the listener for its instance id and comparing.
 */

export const DESCRIPTOR_VERSION = 1;
export const INSTANCE_PATH = "/__quotaops/instance";

export interface DashboardDescriptor {
  version: number;
  port: number;
  pid: number;
  /** Random per-launch id, echoed by the running server to prove identity. */
  instanceId: string;
  startedAt: string;
}

/**
 * Overridable so tests do not write over a running instance's descriptor.
 * The descriptor holds no secret and discovery verifies the listener's
 * identity regardless of where the file came from, so relocating it cannot
 * grant access — it only changes where discovery looks.
 */
export function getDescriptorPath(): string {
  const override = process.env.QUOTAOPS_DESCRIPTOR_PATH?.trim();
  if (override) return override;
  return join(homedir(), ".quotaops", "dashboard-runtime.json");
}

export function createInstanceId(): string {
  return randomBytes(16).toString("hex");
}

export function isDescriptor(value: unknown): value is DashboardDescriptor {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<DashboardDescriptor>;

  return (
    candidate.version === DESCRIPTOR_VERSION &&
    typeof candidate.port === "number" &&
    Number.isInteger(candidate.port) &&
    candidate.port > 0 &&
    candidate.port <= 65_535 &&
    typeof candidate.pid === "number" &&
    Number.isInteger(candidate.pid) &&
    candidate.pid > 0 &&
    typeof candidate.instanceId === "string" &&
    /^[0-9a-f]{32}$/.test(candidate.instanceId) &&
    typeof candidate.startedAt === "string"
  );
}

export async function readDescriptor(): Promise<DashboardDescriptor | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(getDescriptorPath(), "utf8"));
    return isDescriptor(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Atomic write: a reader racing a restart sees either the old descriptor or
 * the new one, never a half-written file.
 */
export async function writeDescriptor(
  descriptor: DashboardDescriptor,
): Promise<void> {
  const path = getDescriptorPath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });

  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(descriptor, null, 2) + "\n", {
    encoding: "utf8",
    mode: 0o600,
  });
  if (process.platform !== "win32") await chmod(temporary, 0o600);
  await rename(temporary, path);
}

/**
 * Removes the descriptor only when it is still ours. A restarted instance
 * must never delete the record of a different live one.
 */
export async function removeOwnDescriptor(instanceId: string): Promise<void> {
  const current = await readDescriptor();
  if (!current || current.instanceId !== instanceId) return;
  await rm(getDescriptorPath(), { force: true });
}

/**
 * Synchronous variant for a `process.on("exit")` handler, where no promise
 * can settle. Windows delivers nothing for `taskkill` without `/F`, so the
 * async signal handlers alone would leave a descriptor behind on some exits.
 * A leftover descriptor is safe — discovery reports it stale — but removing
 * it keeps the common case clean.
 */
export function removeOwnDescriptorSync(instanceId: string): void {
  try {
    const parsed: unknown = JSON.parse(readFileSync(getDescriptorPath(), "utf8"));
    if (!isDescriptor(parsed) || parsed.instanceId !== instanceId) return;
    unlinkSync(getDescriptorPath());
  } catch {
    // Nothing to clean up, or the file is already gone.
  }
}

export type LivenessResult =
  | { state: "live"; descriptor: DashboardDescriptor }
  | { state: "stale"; reason: string }
  | { state: "absent" };

/**
 * Confirms a descriptor by asking the listener to identify itself.
 *
 * A PID can be reused and a file can be left behind by a crash, so neither is
 * trusted on its own: the port must answer, and it must answer with the
 * instance id the descriptor claims. Anything else is stale or an unrelated
 * process, and both are treated as "not QuotaOps".
 */
export async function probeDescriptor(
  descriptor: DashboardDescriptor | null,
  timeoutMs = 2_000,
): Promise<LivenessResult> {
  if (!descriptor) return { state: "absent" };

  let response: Response;
  try {
    response = await fetch(
      `http://127.0.0.1:${descriptor.port}${INSTANCE_PATH}`,
      { signal: AbortSignal.timeout(timeoutMs) },
    );
  } catch {
    return { state: "stale", reason: "no listener answered on the recorded port" };
  }

  if (!response.ok) {
    return { state: "stale", reason: `instance endpoint returned HTTP ${response.status}` };
  }

  let payload: { instanceId?: unknown; pid?: unknown };
  try {
    payload = (await response.json()) as { instanceId?: unknown; pid?: unknown };
  } catch {
    return { state: "stale", reason: "instance endpoint returned a malformed body" };
  }

  if (payload.instanceId !== descriptor.instanceId) {
    // Something else owns this port now, or the file outlived its process.
    return { state: "stale", reason: "the listener is not the recorded instance" };
  }

  return { state: "live", descriptor };
}

/** Convenience for callers that only need the address of a verified instance. */
export async function findLiveDashboard(): Promise<LivenessResult> {
  return probeDescriptor(await readDescriptor());
}
