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

interface HoldRecord {
  result: CollectorAccountResult;
  /** When automation last met this obstacle (ms since epoch). */
  heldAt: number;
}

export class AttentionHolds {
  private readonly held = new Map<string, HoldRecord>();
  private readonly interactive = new Set<string>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /** A result to report instead of collecting, or null to collect. */
  skip(account: { id: string; label: string }, trigger: RefreshTrigger): CollectorAccountResult | null {
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
    if (record && trigger === "scheduled" && this.now() - record.heldAt < BACKGROUND_RETRY_MS) {
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

  record(result: CollectorAccountResult): void {
    if (needsPerson(result.status)) this.held.set(result.id, { result, heldAt: this.now() });
    else this.held.delete(result.id);
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
    }));
    return JSON.stringify({ version: 1, holds }) + "\n";
  }

  restore(json: string, labels: Map<string, string>): void {
    let parsed: unknown;
    try { parsed = JSON.parse(json); } catch { return; }
    if (!parsed || typeof parsed !== "object" || (parsed as { version?: unknown }).version !== 1) return;
    const holds = (parsed as { holds?: unknown }).holds;
    if (!Array.isArray(holds)) return;
    for (const entry of holds.slice(0, 64)) {
      if (!entry || typeof entry !== "object") continue;
      const { id, status, checkedAt, heldAt } = entry as Record<string, unknown>;
      if (typeof id !== "string" || !labels.has(id)) continue;
      if (status !== "verification_required" && status !== "login_required") continue;
      if (typeof checkedAt !== "string" || Number.isNaN(Date.parse(checkedAt))) continue;
      if (typeof heldAt !== "number" || !Number.isFinite(heldAt) || heldAt > this.now()) continue;
      this.held.set(id, {
        heldAt,
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
