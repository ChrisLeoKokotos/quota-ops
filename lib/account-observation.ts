import type { QuotaAccount } from "./quota.ts";

/** Metadata edits never replace observed quota values or timestamps, including
 * when the initiating UI render had an older collector snapshot. */
export function applyAccountEdit(current: QuotaAccount, edited: QuotaAccount): QuotaAccount {
  if (current.id !== edited.id) return current;
  if (current.source !== "collector") return edited;
  const { email: _email, ...observed } = current;
  return { ...observed, label: edited.label, ...(edited.email ? { email: edited.email } : {}) };
}
