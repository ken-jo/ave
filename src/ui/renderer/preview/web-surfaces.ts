/** Reparenting or remounting a webview reloads its guest, so tabs move slots while guests stay in the window layer. Hiding
 * a slot preserves its guest; removing the live tab destroys it. */
export interface WebSurface {
  tabId: string;
  /** The url the guest was last pointed at by the host (not its live url). */
  url: string;
  /**
   * The agent request a host-opened tab was made for (`browser_tab_new`): the
   * layer binds the guest to its tab with it, which is what lets main accept
   * an empty bootstrap guest. Kept once set; a later slot without one (the tab
   * moved to a pane) does not clear it.
   */
  bindRequestId?: string;
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

/** Point the tab's guest at `url`, creating the entry on first use. The same url is a no-op; a different one navigates the
 * existing guest. */
export function setWebSurfaceUrl(tabId: string, url: string, bindRequestId?: string): void {
  const existing = surfaces.find((surface) => surface.tabId === tabId);
  const requestId = bindRequestId ?? existing?.bindRequestId;
  if (existing?.url === url && existing.bindRequestId === requestId) return;
  const next: WebSurface = requestId === undefined ? { tabId, url } : { tabId, url, bindRequestId: requestId };
  surfaces = existing
    ? surfaces.map((surface) => (surface.tabId === tabId ? next : surface))
    : [...surfaces, next];
  emit();
  scheduleReconcile();
}

// Where each guest's page actually is — a link, redirect or in-page route moves it without the host setting a url. What a
// saved layout records.
const locations = new Map<string, string>();
const favicons = new Map<string, string>();
const locationListeners = new Set<() => void>();

/** The guest's latest site icon, retained while its tab is alive. */
export function webSurfaceFavicon(tabId: string): string | null {
  return favicons.get(tabId) ?? null;
}

export function noteWebSurfaceFavicon(tabId: string, favicon: string | null): void {
  if ((favicons.get(tabId) ?? null) === favicon) return;
  if (favicon === null) favicons.delete(tabId);
  else favicons.set(tabId, favicon);
  emit();
}

/** The layer saw the tab's main frame navigate to `url`. */
export function noteWebSurfaceLocation(tabId: string, url: string): void {
  if (locations.get(tabId) === url) return;
  locations.set(tabId, url);
  for (const listener of [...locationListeners]) listener();
}

/** The guest attached again (a new page process): what it committed before is not this page's address any more. */
export function forgetWebSurfaceLocation(tabId: string): void {
  noteWebSurfaceFavicon(tabId, null);
  if (!locations.delete(tabId)) return;
  for (const listener of [...locationListeners]) listener();
}

/** The address the tab's main frame committed, or null before its first navigation. */
export function committedWebSurfaceLocation(tabId: string): string | null {
  return locations.get(tabId) ?? null;
}

/** The tab's last main-frame address, else the url the host set, else null. */
export function webSurfaceLocation(tabId: string): string | null {
  return locations.get(tabId) ?? surfaces.find((surface) => surface.tabId === tabId)?.url ?? null;
}

export function subscribeWebSurfaceLocations(listener: () => void): () => void {
  locationListeners.add(listener);
  return () => {
    locationListeners.delete(listener);
  };
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

/** A tab store says which of its tabs are live browser tabs. `source` is the store's own identity; publishing replaces its
 * previous set. */
export function publishLiveWebTabs(source: symbol, tabIds: ReadonlySet<string>): void {
  liveSources.set(source, tabIds);
  scheduleReconcile();
}

export function withdrawLiveWebTabs(source: symbol): void {
  if (!liveSources.delete(source)) return;
  scheduleReconcile();
}

let reconcileQueued = false;

/** Drop the guests no store lists any more. Deferred to a microtask so a move — one store releasing a tab and another
 * adopting it in the same commit — is seen whole rather than as a close followed by an open. */
function scheduleReconcile(): void {
  if (reconcileQueued) return;
  reconcileQueued = true;
  queueMicrotask(() => {
    reconcileQueued = false;
    const live = new Set<string>();
    for (const ids of liveSources.values()) for (const id of ids) live.add(id);
    const next = surfaces.filter((surface) => live.has(surface.tabId));
    if (next.length === surfaces.length) return;
    for (const surface of surfaces) if (!live.has(surface.tabId)) {
      locations.delete(surface.tabId);
      favicons.delete(surface.tabId);
    }
    surfaces = next;
    emit();
  });
}

/** Elements that must draw over a web surface but cannot be portaled above it (a pane's approval and question cards). The
 * layer cuts their boxes out of every guest they overlap, so the card stays visible and clickable. */
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
