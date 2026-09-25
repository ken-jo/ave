/**
 * A request from outside the marketplace tab to review updates (the toolbar's
 * update pill). An update installs only through its review (design §15.6), so
 * the pill opens the tab instead of installing: one package opens its sheet in
 * update mode, several open the Installed view, where each shows its update.
 *
 * Held until the tab takes it, like a deep link: the tab may mount after the
 * request, or be open already and hear it.
 */
import type { PackageKeyView, PackageUpdateView } from "../../../../shared/git-marketplace.js";

export type UpdateReviewRequest = { kind: "package"; key: PackageKeyView } | { kind: "installed" };

let pending: UpdateReviewRequest | null = null;
const listeners = new Set<() => void>();

export function requestUpdateReview(updates: readonly PackageUpdateView[]): void {
  pending = updates.length === 1 ? { kind: "package", key: updates[0]!.key } : { kind: "installed" };
  for (const listener of listeners) listener();
}

/** The request waiting to be opened, cleared by this read. */
export function takeUpdateReview(): UpdateReviewRequest | null {
  const request = pending;
  pending = null;
  return request;
}

/** A request arrived: read it with `takeUpdateReview`. */
export function onUpdateReview(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
