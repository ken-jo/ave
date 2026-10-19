import { useEffect } from "react";
import type { AveApi } from "../types.js";

/**
 * The window's ACTIVE SURFACE — the terminal or web page the user last
 * brought into view — which is what an unbound conversation's tools act on
 * when a call names no tab. A pane's own chat is bound to its pane instead
 * (`BoundSurfaceChip`, main's bound conversation).
 *
 * The target follows focus: focusing a pane that shows a terminal or a
 * page, or bringing one to the front of a side panel, makes it the target.
 * Switching to a chat does not change it — the chat is how the user talks
 * ABOUT what they were just looking at. Closing the target clears it.
 *
 * One value per window, because main tracks one per window: this store is
 * the single place the window's choice is made, and the one a main-side
 * listener subscribes to.
 */
type ActiveSurfaceKind = "terminal" | "browser";

export interface ActiveSurface {
  kind: ActiveSurfaceKind;
  tabId: string;
  /** "Terminal 2", "Browser 1" — what the tab is called where it sits. */
  label: string;
  /** A terminal's working directory, when its shell has reported one. */
  cwd?: string | null;
}

let active: ActiveSurface | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of [...listeners]) listener();
}

function same(a: ActiveSurface | null, b: ActiveSurface | null): boolean {
  if (a === null || b === null) return a === b;
  return a.kind === b.kind && a.tabId === b.tabId && a.label === b.label && (a.cwd ?? null) === (b.cwd ?? null);
}

/** A terminal or page was brought into view; it becomes the target. */
export function showActiveSurface(surface: ActiveSurface): void {
  if (same(active, surface)) return;
  active = surface;
  emit();
}

/**
 * The target's facts changed without anything new being shown (a renamed
 * tab, a reported directory). Only the current target is updated.
 */
export function updateActiveSurface(surface: ActiveSurface): void {
  if (active?.tabId !== surface.tabId || same(active, surface)) return;
  active = surface;
  emit();
}

/** The user dropped the target. */
export function clearActiveSurface(): void {
  if (active === null) return;
  active = null;
  emit();
}

/** A surface was closed; when it was the target, there is none. */
export function forgetActiveSurface(tabId: string): void {
  if (active?.tabId === tabId) clearActiveSurface();
}

export function getActiveSurface(): ActiveSurface | null {
  return active;
}

export function subscribeActiveSurface(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Report the window's active surface to main, where it is the tab the agent
 * tools default to when none is named (`ave:surface:set-active`). Mounted
 * once per window: this store is the window's one choice, whichever side
 * panel or pane it was made in. Cleared when the window's view goes away.
 */
export function useReportActiveSurface(api: AveApi): void {
  useEffect(() => {
    const setActive = api.setActiveSurface;
    if (!setActive) return undefined;
    let last: string | null | undefined;
    const report = () => {
      const surface = getActiveSurface();
      const key = surface ? `${surface.kind}\n${surface.tabId}` : null;
      if (key === last) return;
      last = key;
      void setActive(surface ? { kind: surface.kind, tabId: surface.tabId } : null);
    };
    report();
    const unsubscribe = subscribeActiveSurface(report);
    return () => {
      unsubscribe();
      void setActive(null);
    };
  }, [api]);
}
