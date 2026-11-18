import type { CollectorAccountResult } from "./types.ts";

/**
 * Accounts that need a person, not another automated attempt (issue #49).
 *
 * A provider human-verification challenge or a signed-out profile cannot be
 * resolved by QuotaOps and must not be bypassed. Re-opening the profile under
 * automation every poll interval only re-hits the challenge. So:
 *
 * - After `verification_required` or `login_required`, scheduled cycles skip
 *   the account and report the held result (with its original checkedAt, so
 *   nothing looks freshly collected). No browser is launched for it.
 * - A refresh the user asks for (tray "Refresh now") tries it again once.
 * - While the user has the profile open for manual verification, automation
 *   never touches it (the profile directory is in use), whatever the trigger.
 *
 * Holds live in memory only; a collector restart tries each account once.
 */
export type RefreshTrigger = "scheduled" | "manual";

const NEEDS_PERSON = new Set<CollectorAccountResult["status"]>([
  "verification_required",
  "login_required",
]);

export function needsPerson(status: CollectorAccountResult["status"]): boolean {
  return NEEDS_PERSON.has(status);
}

export class AttentionHolds {
  private readonly held = new Map<string, CollectorAccountResult>();
  private readonly interactive = new Set<string>();

  /** A result to report instead of collecting, or null to collect. */
  skip(account: { id: string; label: string }, trigger: RefreshTrigger): CollectorAccountResult | null {
    const held = this.held.get(account.id);
    if (this.interactive.has(account.id)) {
      return {
        id: account.id,
        label: account.label,
        status: held?.status ?? "verification_required",
        account: null,
        checkedAt: held?.checkedAt ?? new Date().toISOString(),
        message:
          "This profile is open for manual verification. QuotaOps checks it again after that browser window is closed.",
      };
    }
    if (held && trigger === "scheduled") {
      return {
        ...held,
        message:
          `${held.message ?? ""} Automatic checks are paused for this account; ` +
          "use Verify account in the QuotaOps tray menu, or Refresh now after you have verified.",
      };
    }
    return null;
  }

  record(result: CollectorAccountResult): void {
    if (needsPerson(result.status)) this.held.set(result.id, result);
    else this.held.delete(result.id);
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
}
