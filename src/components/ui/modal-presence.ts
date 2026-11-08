import { useSyncExternalStore } from "react";

/**
 * Whether a modal dialog is open anywhere in this window. `DialogContent` registers while it is mounted, so the count is
 * exact rather than read back from the DOM. Transient notices read it to hold themselves while a modal owns the person's
 * attention and focus, then show once it closes (DESIGN.md, notification hierarchy).
 */
let openModals = 0;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/** Register one open modal; the returned release is idempotent so a double cleanup cannot drive the count negative. */
export function registerOpenModal(): () => void {
  openModals += 1;
  emit();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    openModals -= 1;
    emit();
  };
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useModalOpen(): boolean {
  return useSyncExternalStore(subscribe, () => openModals > 0, () => false);
}
