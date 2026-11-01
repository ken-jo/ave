/** Review requests persist until consumed: one package opens its sheet, several open Installed, and already-applied or
 * pause-blocked updates open the Updates card. */
import type { PackageKeyView, PackageUpdateView } from "../../../../shared/git-marketplace.js";

export type UpdateReviewRequest = { kind: "package"; key: PackageKeyView } | { kind: "installed" } | { kind: "updates" } | { kind: "install-direct" };

let pending: UpdateReviewRequest | null = null;
const listeners = new Set<() => void>();

export function requestUpdateReview(updates: ReadonlyArray<Pick<PackageUpdateView, "key"> & Partial<Pick<PackageUpdateView, "state">>>): void {
  const applied = updates.some((update) => update.state === "applied-not-running" || update.state === "approval-pending" || update.state === "waiting");
  pending = applied ? { kind: "updates" } : updates.length === 1 ? { kind: "package", key: updates[0]!.key } : { kind: "installed" };
  for (const listener of listeners) listener();
}

/** Opens the reviewed "Install from Git URL or folder" dialog, the install path every build offers. */
export function requestDirectInstall(): void {
  pending = { kind: "install-direct" };
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
