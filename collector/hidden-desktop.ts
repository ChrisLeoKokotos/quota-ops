import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { CollectionCancelledError } from "./browser-session.ts";
import type { CollectorAccountConfig, CollectorAccountResult } from "./types.ts";

/**
 * Windows background collection without disturbing the person (owner P0 and
 * long-term goal: automatic collection that never takes focus).
 *
 * Measured on Windows 11 with the owner's own accounts (Nov 2026):
 * - headless: Claude served its Cloudflare challenge to every account;
 * - an ordinary browser window passed for a profile the person had verified,
 *   but took the foreground;
 * - the same ordinary browser started on a separate, never-shown desktop
 *   passed for that profile with 0 of 123 foreground samples changed.
 *
 * A worker runs the batch on that hidden desktop (hidden-desktop-run.ps1)
 * inside a kill-on-close job, writes its results and exits, so Playwright
 * and the browser never stay resident in the collector between batches.
 * The browser, its identity and security settings are unchanged; nothing is
 * solved or bypassed.
 */
const here = dirname(fileURLToPath(import.meta.url));
const TRAMPOLINE = join(here, "hidden-desktop-run.ps1");
const WORKER = join(here, "hidden-collect-worker.ts");
/** Per account: launch 30 s + navigation 30 s + API wait 10 s + reads. */
const PER_ACCOUNT_BOUND_S = 90;

export function hiddenDesktopSupported(platform: NodeJS.Platform = process.platform): boolean {
  return platform === "win32";
}

function unavailable(account: CollectorAccountConfig, message: string): CollectorAccountResult {
  return {
    id: account.id,
    label: account.label,
    status: "unavailable",
    account: null,
    checkedAt: new Date().toISOString(),
    message,
  };
}

export function parseWorkerResult(
  raw: string,
  nonce: string,
  requested: CollectorAccountConfig[],
): Map<string, CollectorAccountResult> {
  const found = new Map<string, CollectorAccountResult>();
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return found; }
  if (!parsed || typeof parsed !== "object") return found;
  const record = parsed as { version?: unknown; nonce?: unknown; results?: unknown };
  if (record.version !== 1 || record.nonce !== nonce || !Array.isArray(record.results)) return found;
  const ids = new Set(requested.map((account) => account.id));
  const statuses = new Set(["ok", "login_required", "verification_required", "unavailable", "unsupported"]);
  for (const entry of record.results.slice(0, 64)) {
    if (!entry || typeof entry !== "object") continue;
    const result = entry as CollectorAccountResult;
    if (typeof result.id !== "string" || !ids.has(result.id) || !statuses.has(result.status)) continue;
    found.set(result.id, result);
  }
  return found;
}

export interface HiddenRunOptions {
  signal?: AbortSignal | undefined;
  runDir: string;
  /** Test seam: replaces the PowerShell trampoline. */
  spawnTrampoline?: (args: string[], env: NodeJS.ProcessEnv) => ReturnType<typeof spawn>;
}

/**
 * Collect `accounts` (Claude/OpenAI) in one hidden-desktop worker. Always
 * resolves with one result per account; failures become "unavailable".
 */
export async function collectInHiddenDesktop(
  accounts: CollectorAccountConfig[],
  options: HiddenRunOptions,
): Promise<CollectorAccountResult[]> {
  if (accounts.length === 0) return [];
  if (options.signal?.aborted) throw new CollectionCancelledError();
  await mkdir(options.runDir, { recursive: true, mode: 0o700 });
  const nonce = randomBytes(16).toString("hex");
  const requestPath = join(options.runDir, "hidden-request.json");
  const resultPath = join(options.runDir, "hidden-result.json");
  // Fixed file names, overwritten each batch: nothing accumulates.
  await writeFile(requestPath, JSON.stringify({ version: 1, nonce, accountIds: accounts.map((a) => a.id) }) + "\n", { mode: 0o600 });
  await writeFile(resultPath, "{}\n", { mode: 0o600 });

  const quote = (value: string) => `"${value.replace(/"/g, "")}"`;
  const commandLine = [process.execPath, "--experimental-strip-types", "--no-warnings", WORKER, requestPath, resultPath]
    .map((part, index) => (index === 1 || index === 2 ? part : quote(part))).join(" ");
  const timeoutSeconds = 30 + accounts.length * PER_ACCOUNT_BOUND_S;
  const args = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", TRAMPOLINE,
    "-CommandLine", commandLine, "-WorkingDirectory", dirname(here), "-TimeoutSeconds", String(timeoutSeconds)];
  // The packaged collector runs inside QuotaOps.exe; the worker uses the same
  // runtime as plain Node. Windows PowerShell must not see PowerShell 7's modules.
  const env: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
  delete env.PSModulePath;

  const child = options.spawnTrampoline
    ? options.spawnTrampoline(args, env)
    : spawn("powershell.exe", args, { env, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
  let output = "";
  child.stdout?.on("data", (chunk) => { output = (output + String(chunk)).slice(-2_000); });

  let cancelled = false;
  const onAbort = () => {
    cancelled = true;
    // Ending the trampoline closes its job: the worker and its browsers end too.
    try { child.kill(); } catch { /* already exited */ }
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    await new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      child.once("error", () => resolve());
    });
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
  }
  if (cancelled || options.signal?.aborted) throw new CollectionCancelledError();

  const outcome = output.trim().split(/\r?\n/).pop() ?? "";
  let found = new Map<string, CollectorAccountResult>();
  try {
    found = parseWorkerResult(await readFile(resultPath, "utf8"), nonce, accounts);
  } catch {
    found = new Map();
  }
  const why = outcome === "TIMEOUT"
    ? "The hidden background browser did not finish in time."
    : "The hidden background browser could not run on this computer.";
  return accounts.map((account) => found.get(account.id) ?? unavailable(account, why));
}
