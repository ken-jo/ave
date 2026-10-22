import { useEffect, useRef, useState, useSyncExternalStore } from "react";

/**
 * Single-mount registry for workspace surfaces that own a live resource keyed
 * by tab id (a PTY today; a web guest once tabs move between the side panel
 * and the main area).
 *
 * Two live views of one terminal tab corrupt each other: main replays the
 * scrollback to every listener and both views send resizes. The registry
 * therefore grants each tab id to exactly one mounted view and records WHERE
 * it is mounted ("side-panel", "pane:<id>"). A second view of the same id
 * renders a placeholder until the owner unmounts, then takes the mount over —
 * which is also what makes a move work regardless of React's effect order.
 *
 * Tab ids are window-unique (see `workspace-tabs.ts`), so one registry per
 * renderer covers every group in the window.
 */

interface MountOwner {
  token: symbol;
  location: string;
}

const owners = new Map<string, MountOwner>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Where the view that owns this tab id is mounted, or null when none is. */
export function surfaceMountLocation(tabId: string): string | null {
  return owners.get(tabId)?.location ?? null;
}

export interface SurfaceMountState {
  /** True when this view holds the mount and may attach to the resource. */
  owned: boolean;
  /** Location of the current owner (this view's own location when owned). */
  ownerLocation: string | null;
}

/**
 * Claim the single mount of `tabId` for a view at `location`. Released on
 * unmount or when `tabId` changes; a waiting view claims it as soon as it is
 * free.
 */
export function useSurfaceMount(tabId: string, location: string): SurfaceMountState {
  const [token] = useState(() => Symbol("surface-mount"));
  const owner = useSyncExternalStore(subscribe, () => owners.get(tabId));

  const locationRef = useRef(location);
  locationRef.current = location;

  useEffect(() => {
    const claim = (): void => {
      if (owners.has(tabId)) return;
      owners.set(tabId, { token, location: locationRef.current });
      emit();
    };
    claim();
    const unsubscribe = subscribe(claim);
    return () => {
      unsubscribe();
      if (owners.get(tabId)?.token === token) {
        owners.delete(tabId);
        emit();
      }
    };
  }, [tabId, token]);

  // A location change (the owner re-homed without unmounting) updates the
  // record in place; releasing and re-claiming would let a waiting view in.
  useEffect(() => {
    const current = owners.get(tabId);
    if (current?.token === token && current.location !== location) {
      owners.set(tabId, { token, location });
      emit();
    }
  }, [tabId, token, location]);

  return { owned: owner?.token === token, ownerLocation: owner?.location ?? null };
}
