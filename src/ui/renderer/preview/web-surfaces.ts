/**
 * Web surfaces — the window's browser guests, kept alive independently of
 * where (or whether) they are shown.
 *
 * Moving or remounting a `<webview>` destroys its guest and reloads the page
 * (measured 2026-10-15: an `appendChild` or `moveBefore` re-parent gives the
 * guest a new webContents id and loses scroll, form input and the SPA route).
 * So a browser tab's `<webview>` is NOT rendered where the tab is shown. Each
 * live browser tab owns one entry here; `WebSurfaceLayer`, mounted once at the
 * window root, renders one `<webview>` per entry and places it over the tab's
 * SLOT — a plain placeholder element the side panel or a main pane renders
 * where the page should appear. Moving a tab is moving its slot; the guest
 * never leaves the layer, so it never reloads.
 *
 * Lifetime: an entry lives while some tab store lists its tab id as a live
 * browser tab (`publishLiveWebTabs`). A slot that goes away — tab switched,
 * panel closed, pane routed elsewhere — only hides the guest. Closing the tab
 * removes it from its store, and the next reconcile destroys the guest.
 */
export interface WebSurface {
  tabId: string;
  /** The url the guest was last pointed at by the host (not its live url). */
  url: string;
}

let surfaces: readonly WebSurface[] = [];
const slots = new Map<string, HTMLElement>();
const webviews = new Map<string, HTMLElement>();
const liveSources = new Map<symbol, ReadonlySet<string>>();
const occluders = new Set<HTMLElement>();
let dragActive = false;

/** React-facing listeners: the entry list and the element map changed. */
const listeners = new Set<() => void>();
/** Layout-facing listeners: something a placement depends on changed. */
const layoutListeners = new Set<() => void>();

function emit(): void {
  for (const listener of [...listeners]) listener();
}

/** Ask the layer to re-place its guests (slot, occluder or drag change). */
export function requestWebSurfaceLayout(): void {
  for (const listener of [...layoutListeners]) listener();
}

export function subscribeWebSurfaces(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function subscribeWebSurfaceLayout(listener: () => void): () => void {
  layoutListeners.add(listener);
  return () => {
    layoutListeners.delete(listener);
  };
}

export function getWebSurfaces(): readonly WebSurface[] {
  return surfaces;
}

/**
 * Point the tab's guest at `url`, creating the entry on first use. The same
 * url is a no-op; a different one navigates the existing guest.
 */
export function setWebSurfaceUrl(tabId: string, url: string): void {
  const existing = surfaces.find((surface) => surface.tabId === tabId);
  if (existing?.url === url) return;
  surfaces = existing
    ? surfaces.map((surface) => (surface.tabId === tabId ? { tabId, url } : surface))
    : [...surfaces, { tabId, url }];
  emit();
  scheduleReconcile();
}

export function hasWebSurface(tabId: string): boolean {
  return surfaces.some((surface) => surface.tabId === tabId);
}

/** The slot element the tab's guest is placed over, if one is mounted. */
export function getWebSurfaceSlot(tabId: string): HTMLElement | null {
  return slots.get(tabId) ?? null;
}

export function setWebSurfaceSlot(tabId: string, element: HTMLElement): void {
  slots.set(tabId, element);
  requestWebSurfaceLayout();
}

/** Remove `element` as the tab's slot — a no-op when another slot has taken over. */
export function clearWebSurfaceSlot(tabId: string, element: HTMLElement): void {
  if (slots.get(tabId) !== element) return;
  slots.delete(tabId);
  requestWebSurfaceLayout();
}

/** Registered by the layer for each guest it renders. */
export function setWebSurfaceElement(tabId: string, element: HTMLElement | null): void {
  if (element) {
    if (webviews.get(tabId) === element) return;
    webviews.set(tabId, element);
  } else {
    if (!webviews.has(tabId)) return;
    webviews.delete(tabId);
  }
  emit();
}

/** The live `<webview>` element of a tab, for its chrome (title, history). */
export function getWebSurfaceElement(tabId: string): HTMLElement | null {
  return webviews.get(tabId) ?? null;
}

/**
 * A tab store says which of its tabs are live browser tabs. `source` is the
 * store's own identity; publishing replaces its previous set.
 */
export function publishLiveWebTabs(source: symbol, tabIds: ReadonlySet<string>): void {
  liveSources.set(source, tabIds);
  scheduleReconcile();
}

export function withdrawLiveWebTabs(source: symbol): void {
  if (!liveSources.delete(source)) return;
  scheduleReconcile();
}

let reconcileQueued = false;

/**
 * Drop the guests no store lists any more. Deferred to a microtask so a move —
 * one store releasing a tab and another adopting it in the same commit — is
 * seen whole rather than as a close followed by an open.
 */
function scheduleReconcile(): void {
  if (reconcileQueued) return;
  reconcileQueued = true;
  queueMicrotask(() => {
    reconcileQueued = false;
    const live = new Set<string>();
    for (const ids of liveSources.values()) for (const id of ids) live.add(id);
    const next = surfaces.filter((surface) => live.has(surface.tabId));
    if (next.length === surfaces.length) return;
    surfaces = next;
    emit();
  });
}

/**
 * Elements that must draw over a web surface but cannot be portaled above it
 * (a pane's approval and question cards). The layer cuts their boxes out of
 * every guest they overlap, so the card stays visible and clickable.
 */
export function registerWebSurfaceOccluder(element: HTMLElement): () => void {
  occluders.add(element);
  requestWebSurfaceLayout();
  return () => {
    occluders.delete(element);
    requestWebSurfaceLayout();
  };
}

export function getWebSurfaceOccluders(): ReadonlySet<HTMLElement> {
  return occluders;
}

/**
 * A guest swallows every pointer event over its box, so a resize or drag that
 * crosses it loses its moves and its release (measured: a bar dragged across a
 * guest saw 0 moves and no pointerup). While a drag runs, the layer stops
 * taking the pointer.
 */
let dragDepth = 0;

export function beginSurfaceDrag(): void {
  dragDepth += 1;
  if (dragActive) return;
  dragActive = true;
  requestWebSurfaceLayout();
}

export function endSurfaceDrag(): void {
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth > 0 || !dragActive) return;
  dragActive = false;
  requestWebSurfaceLayout();
}

/** Clear every open drag at once — a native drag whose source left the DOM never reports its end. */
export function resetSurfaceDrag(): void {
  dragDepth = 0;
  if (!dragActive) return;
  dragActive = false;
  requestWebSurfaceLayout();
}

export function isSurfaceDragActive(): boolean {
  return dragActive;
}
