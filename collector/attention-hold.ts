import { readFile, rename, unlink, writeFile } from "node:fs/promises";

import type { CollectionTrigger } from "./monitoring.ts";
import type { CollectorAccountResult } from "./types.ts";

/**
 * Accounts that need a person, not another automated attempt (issue #49).
 *
 * A provider human-verification challenge or a signed-out profile cannot be
 * resolved by QuotaOps and must not be bypassed. Re-opening the profile under
 * automation every poll interval only re-hits the challenge. So:
 *
 * - After `verification_required` or `login_required`, scheduled (background)
 *   cycles report the held result with its original checkedAt, launch no
 *   browser, and retry the account at most once per BACKGROUND_RETRY_MS.
 * - A refresh the person asks for ("Refresh now", or the consented visible
 *   refresh) tries it again; an ok result clears the hold.
 * - While the person has the profile open for manual verification,
 *   automation never touches it (the profile directory is in use).
 * - Holds survive collector restarts (a small state file), so restarting the
 *   app does not re-hit a challenge for every account.
 */
export type RefreshTrigger = CollectionTrigger;

export const BACKGROUND_RETRY_MS = 24 * 60 * 60 * 1000;

const NEEDS_PERSON = new Set<CollectorAccountResult["status"]>([
  "verification_required",
  "login_required",
]);

export function needsPerson(status: CollectorAccountResult["status"]): boolean {
  return NEEDS_PERSON.has(status);
}

/**
 * How the browser ran when the obstacle was met. A hold is evidence about
 * that presentation only: Claude challenged every headless session while the
 * same verified profile passed in an ordinary browser, so a hold recorded
 * headless must not stop a hidden-desktop attempt.
 */
export type HoldPresentation = "hidden" | "headless" | "visible";
const PRESENTATIONS = new Set<HoldPresentation>(["hidden", "headless", "visible"]);

interface HoldRecord {
  result: CollectorAccountResult;
  /** When automation last met this obstacle (ms since epoch). */
  heldAt: number;
  presentation: HoldPresentation;
}

export class AttentionHolds {
  private readonly held = new Map<string, HoldRecord>();
  /** Last time each account returned usage (ISO), kept across restarts. */
  private readonly successes = new Map<string, string>();
  private readonly interactive = new Set<string>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /** A result to report instead of collecting, or null to collect. */
  skip(
    account: { id: string; label: string },
    trigger: RefreshTrigger,
    presentation: HoldPresentation = "headless",
  ): CollectorAccountResult | null {
    const record = this.held.get(account.id);
    if (this.interactive.has(account.id)) {
      return {
        id: account.id,
        label: account.label,
        status: record?.result.status ?? "verification_required",
        account: null,
        checkedAt: record?.result.checkedAt ?? new Date(this.now()).toISOString(),
        message:
          "This profile is open for manual verification. QuotaOps checks it again after that browser window is closed.",
      };
    }
    if (record && trigger === "scheduled" && record.presentation === presentation &&
        this.now() - record.heldAt < BACKGROUND_RETRY_MS) {
      return {
        ...record.result,
        label: account.label,
        message:
          `${record.result.message ?? ""} Background checks are paused for this account; ` +
          "use Manual verification required in the QuotaOps tray menu, then Refresh now " +
          "or Refresh with visible browser.",
      };
    }
    return null;
  }

  record(result: CollectorAccountResult, presentation: HoldPresentation = "headless"): void {
    if (needsPerson(result.status)) this.held.set(result.id, { result, heldAt: this.now(), presentation });
    else this.held.delete(result.id);
    if (result.status === "ok" && result.account !== null) this.successes.set(result.id, result.checkedAt);
  }

  lastSuccessAt(id: string): string | null {
    return this.successes.get(id) ?? null;
  }

  /**
   * Every held account, regardless of the background retry window: what the
   * tray and dashboard show at start-up, also when background collection is
   * off and no batch will run.
   */
  heldResults(accounts: Array<{ id: string; label: string }>): CollectorAccountResult[] {
    const shown: CollectorAccountResult[] = [];
    for (const account of accounts) {
      const record = this.held.get(account.id);
      if (record) shown.push({ ...record.result, label: account.label });
    }
    return shown;
  }

  isHeld(id: string): boolean {
    return this.held.has(id);
  }

  beginInteractive(id: string): boolean {
    if (this.interactive.has(id)) return false;
    this.interactive.add(id);
    return true;
  }

  endInteractive(id: string): void {
    this.interactive.delete(id);
  }

  isInteractive(id: string): boolean {
    return this.interactive.has(id);
  }

  /** Statuses and timestamps only: no usage values, no page content. */
  serialize(): string {
    const holds = [...this.held.entries()].map(([id, record]) => ({
      id,
      status: record.result.status,
      checkedAt: record.result.checkedAt,
      heldAt: record.heldAt,
      presentation: record.presentation,
    }));
    const lastSuccess = Object.fromEntries(this.successes);
    return JSON.stringify({ version: 1, holds, lastSuccess }) + "\n";
  }

  restore(json: string, labels: Map<string, string>): void {
    let parsed: unknown;
    try { parsed = JSON.parse(json); } catch { return; }
    if (!parsed || typeof parsed !== "object" || (parsed as { version?: unknown }).version !== 1) return;
    const successes = (parsed as { lastSuccess?: unknown }).lastSuccess;
    if (successes && typeof successes === "object" && !Array.isArray(successes)) {
      for (const [id, at] of Object.entries(successes as Record<string, unknown>).slice(0, 64)) {
        if (labels.has(id) && typeof at === "string" && !Number.isNaN(Date.parse(at)) && Date.parse(at) <= this.now()) {
          this.successes.set(id, at);
        }
      }
    }
    const holds = (parsed as { holds?: unknown }).holds;
    if (!Array.isArray(holds)) return;
    for (const entry of holds.slice(0, 64)) {
      if (!entry || typeof entry !== "object") continue;
      const { id, status, checkedAt, heldAt, presentation } = entry as Record<string, unknown>;
      if (typeof id !== "string" || !labels.has(id)) continue;
      if (status !== "verification_required" && status !== "login_required") continue;
      if (typeof checkedAt !== "string" || Number.isNaN(Date.parse(checkedAt))) continue;
      if (typeof heldAt !== "number" || !Number.isFinite(heldAt) || heldAt > this.now()) continue;
      this.held.set(id, {
        heldAt,
        // Holds written before presentations existed came from headless runs.
        presentation: PRESENTATIONS.has(presentation as HoldPresentation)
          ? presentation as HoldPresentation : "headless",
        result: {
          id,
          label: labels.get(id) ?? id,
          status,
          account: null,
          checkedAt,
          message: status === "login_required"
            ? "Sign-in is required for this local profile."
            : "The provider requires manual human verification in this local profile. QuotaOps will not bypass it.",
        },
      });
    }
  }
}

/** Write atomically next to the collector config; never fatal. */
export async function persistHolds(holds: AttentionHolds, path: string): Promise<void> {
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, holds.serialize(), { mode: 0o600 });
    await rename(temporary, path);
  } catch {
    // State is an optimisation against re-hitting challenges, not a source of
    // truth; never leave the temporary file behind (e.g. rename EPERM).
    await unlink(temporary).catch(() => undefined);
  }
}

export async function loadHolds(holds: AttentionHolds, path: string, labels: Map<string, string>): Promise<void> {
  try {
    holds.restore(await readFile(path, "utf8"), labels);
  } catch {
    // Missing or unreadable: start without holds.
  }
}
