/** Portal guests to body so transforms cannot capture fixed positioning; clip slots around occluders and stay below
 * popovers. Measure moving slots during layout changes. */
import { createElement, useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { AVE_SIDE_BROWSER_PARTITION } from "../../../shared/side-browser.js";
import { useTranslation } from "../../../i18n/react.js";
import { useSurfaceMount } from "../preview/surface-mounts.js";
import { bindGuestToTab } from "../preview/agent-browser-bridge.js";
import type { AveApi } from "../types.js";
import {
  getWebSurfaceOccluders,
  getWebSurfaceSlot,
  getWebSurfaces,
  isSurfaceDragActive,
  resetSurfaceDrag,
  beginSurfaceDrag,
  endSurfaceDrag,
  setWebSurfaceElement,
  forgetWebSurfaceLocation,
  noteWebSurfaceLocation,
  setWebSurfaceSlot,
  clearWebSurfaceSlot,
  setWebSurfaceUrl,
  subscribeWebSurfaceLayout,
  subscribeWebSurfaces,
  requestWebSurfaceLayout,
  type WebSurface,
} from "../preview/web-surfaces.js";

/** Above app content, below the `z-50` portal layer (popovers, menus, dialogs). */
const WEB_SURFACE_LAYER_Z = 40;
/** Frames the loop keeps measuring after the last trigger, to follow transitions. */
const SETTLE_FRAMES = 24;
/** Low-rate safety pass while a guest is visible: catches moves nothing reported. */
const IDLE_CHECK_MS = 1000;

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

function intersect(a: Box, b: Box): Box {
  return {
    left: Math.max(a.left, b.left),
    top: Math.max(a.top, b.top),
    right: Math.min(a.right, b.right),
    bottom: Math.min(a.bottom, b.bottom),
  };
}

function isEmpty(box: Box): boolean {
  return box.right - box.left < 1 || box.bottom - box.top < 1;
}

/** The rounded corners a clipping ancestor gives the visible box where the two share a corner — the side panel is a rounded
 * card, and a page laid over its last pixels must round off with it rather than poke out of its corners. */
function sharedCorners(visible: Box, clip: Box, style: CSSStyleDeclaration, current: string[]): string[] {
  const near = (a: number, b: number) => Math.abs(a - b) <= 1;
  const corners: Array<[boolean, string]> = [
    [near(visible.left, clip.left) && near(visible.top, clip.top), style.borderTopLeftRadius],
    [near(visible.right, clip.right) && near(visible.top, clip.top), style.borderTopRightRadius],
    [near(visible.right, clip.right) && near(visible.bottom, clip.bottom), style.borderBottomRightRadius],
    [near(visible.left, clip.left) && near(visible.bottom, clip.bottom), style.borderBottomLeftRadius],
  ];
  return corners.map(([shared, radius], index) => (current[index] === "0px" && shared && radius ? radius : current[index]!));
}

/** The slot's box cut down to what every clipping ancestor leaves visible. */
function visibleBox(slot: HTMLElement): { slot: Box; visible: Box; radius: string } | null {
  // No client rects: the slot or an ancestor is `display: none`. `visibility` inherits, so the slot's own computed value
  // covers its ancestors too.
  if (!slot.isConnected || slot.getClientRects().length === 0) return null;
  if (getComputedStyle(slot).visibility !== "visible") return null;
  const rect = slot.getBoundingClientRect();
  const slotBox: Box = { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
  let visible: Box = intersect(slotBox, {
    left: 0,
    top: 0,
    right: document.documentElement.clientWidth,
    bottom: document.documentElement.clientHeight,
  });
  const clips: Array<{ box: Box; style: CSSStyleDeclaration }> = [];
  for (let node = slot.parentElement; node && node !== document.body; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (style.overflowX === "visible" && style.overflowY === "visible") continue;
    const rect = node.getBoundingClientRect();
    const box = { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
    clips.push({ box, style });
    visible = intersect(visible, box);
    if (isEmpty(visible)) return null;
  }
  if (isEmpty(visible)) return null;
  let corners = ["0px", "0px", "0px", "0px"];
  for (const clip of clips) corners = sharedCorners(visible, clip.box, clip.style, corners);
  return { slot: slotBox, visible, radius: corners.join(" ") };
}

/** An occluder's boxes; a `display: contents` wrapper contributes its children's. */
function occluderBoxes(element: HTMLElement, out: Box[]): void {
  if (!element.isConnected) return;
  if (getComputedStyle(element).display === "contents") {
    for (const child of element.children) occluderBoxes(child as HTMLElement, out);
    return;
  }
  for (const rect of element.getClientRects()) {
    if (rect.width >= 1 && rect.height >= 1) {
      out.push({ left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom });
    }
  }
}

/** `clip-path` that keeps the frame and cuts out every hole (frame-local px). */
function clipPathFor(frame: Box, holes: Box[]): string {
  if (holes.length === 0) return "";
  const w = frame.right - frame.left;
  const h = frame.bottom - frame.top;
  let path = `M0 0H${w}V${h}H0Z`;
  for (const hole of holes) {
    const x0 = hole.left - frame.left;
    const y0 = hole.top - frame.top;
    const x1 = hole.right - frame.left;
    const y1 = hole.bottom - frame.top;
    path += `M${x0} ${y0}H${x1}V${y1}H${x0}Z`;
  }
  return `path(evenodd, "${path}")`;
}

interface Placed {
  frame: HTMLElement;
  guest: HTMLElement;
  key: string;
}

const placed = new Map<string, Placed>();

/** Measure every guest's slot and write the frames that moved. Exported for the budget probe. */
let dragApplied = false;

export function placeWebSurfaces(): { visible: number; moved: number } {
  const drag = isSurfaceDragActive();
  dragApplied = drag;
  let moved = 0;
  const occluderList: Box[] = [];
  for (const element of getWebSurfaceOccluders()) occluderBoxes(element, occluderList);
  let visibleCount = 0;
  for (const [tabId, entry] of placed) {
    const slot = getWebSurfaceSlot(tabId);
    const boxes = slot ? visibleBox(slot) : null;
    let key: string;
    if (!boxes) {
      key = "hidden";
    } else {
      visibleCount += 1;
      const { slot: s, visible: v } = boxes;
      const holes = occluderList
        .map((box) => intersect(box, v))
        .filter((box) => !isEmpty(box));
      key = [v.left, v.top, v.right, v.bottom, s.left, s.top, s.right, s.bottom, drag ? 1 : 0, boxes.radius, clipPathFor(v, holes)].join(",");
      if (key !== entry.key) {
        const frameStyle = entry.frame.style;
        frameStyle.visibility = "visible";
        frameStyle.left = `${v.left}px`;
        frameStyle.top = `${v.top}px`;
        frameStyle.width = `${v.right - v.left}px`;
        frameStyle.height = `${v.bottom - v.top}px`;
        frameStyle.clipPath = clipPathFor(v, holes);
        frameStyle.borderRadius = boxes.radius;
        frameStyle.pointerEvents = drag ? "none" : "auto";
        const guestStyle = entry.guest.style;
        guestStyle.left = `${s.left - v.left}px`;
        guestStyle.top = `${s.top - v.top}px`;
        guestStyle.width = `${s.right - s.left}px`;
        guestStyle.height = `${s.bottom - s.top}px`;
      }
    }
    if (key !== entry.key) moved += 1;
    if (key === "hidden" && entry.key !== "hidden") {
      // Hidden, not unmounted: the guest keeps its page. Its last size is kept too, so showing it again does not make the page
      // relayout twice.
      entry.frame.style.visibility = "hidden";
      entry.frame.style.pointerEvents = "none";
    }
    entry.key = key;
  }
  return { visible: visibleCount, moved };
}

let loopFrames = 0;
let rafId = 0;

function tick(): void {
  rafId = 0;
  const { moved } = placeWebSurfaces();
  // A slot still moving keeps the loop alive: the side panel slides in with a script-driven transform, which no resize or
  // transition event reports.
  if (moved > 0 || isSurfaceDragActive()) loopFrames = SETTLE_FRAMES;
  if (loopFrames > 0) {
    loopFrames -= 1;
    rafId = requestAnimationFrame(tick);
  }
}

function kick(): void {
  // A drag that just started must free the pointer before its first move reaches a guest — not a frame later.
  if (isSurfaceDragActive() !== dragApplied) placeWebSurfaces();
  loopFrames = SETTLE_FRAMES;
  if (rafId === 0) rafId = requestAnimationFrame(tick);
}

function GuestFrame({ api, surface }: { api: AveApi; surface: WebSurface }) {
  const frameRef = useRef<HTMLDivElement | null>(null);
  const guestRef = useRef<HTMLElement | null>(null);

  const attach = useCallback((guest: HTMLElement | null) => {
    guestRef.current = guest;
    setWebSurfaceElement(surface.tabId, guest);
  }, [surface.tabId]);

  // Where the page went on its own (links, redirects, in-page routes), for the saved layout's "last address" and the tab's
  // address row. Only the main frame moves the page; a new guest process starts with no address.
  useEffect(() => {
    const guest = guestRef.current;
    if (!guest) return undefined;
    const onNavigate = (event: Event) => {
      const { url, isMainFrame } = event as Event & { url?: string; isMainFrame?: boolean };
      if (isMainFrame === false || (event.type === "did-navigate-in-page" && isMainFrame !== true)) return;
      if (typeof url === "string") {
        noteWebSurfaceLocation(surface.tabId, url);
      }
    };
    const onAttach = () => forgetWebSurfaceLocation(surface.tabId);
    guest.addEventListener("did-attach", onAttach);
    guest.addEventListener("did-navigate", onNavigate);
    guest.addEventListener("did-navigate-in-page", onNavigate);
    return () => {
      guest.removeEventListener("did-attach", onAttach);
      guest.removeEventListener("did-navigate", onNavigate);
      guest.removeEventListener("did-navigate-in-page", onNavigate);
    };
  }, [surface.tabId]);

  // The guest is the tab's page wherever the tab is shown, so the layer binds it to the tab in main for the agent browser
  // tools.
  useEffect(() => {
    const guest = guestRef.current;
    if (!guest) return undefined;
    return bindGuestToTab(api, guest, surface.tabId, surface.bindRequestId);
  }, [api, surface.tabId, surface.bindRequestId]);

  useEffect(() => {
    const frame = frameRef.current;
    const guest = guestRef.current;
    if (!frame || !guest) return undefined;
    placed.set(surface.tabId, { frame, guest, key: "" });
    requestWebSurfaceLayout();
    return () => {
      placed.delete(surface.tabId);
    };
  }, [surface.tabId]);

  return (
    <div
      ref={frameRef}
      data-testid="web-surface-frame"
      data-tab-id={surface.tabId}
      style={{ position: "fixed", overflow: "hidden", visibility: "hidden", pointerEvents: "none", left: 0, top: 0, width: 0, height: 0 }}
    >
      {createElement("webview", {
        ref: attach,
        "data-testid": "chat-side-panel-browser-webview",
        "data-tab-id": surface.tabId,
        src: surface.url,
        partition: AVE_SIDE_BROWSER_PARTITION,
        webpreferences: "contextIsolation=yes, sandbox=yes, nodeIntegration=no, javascript=yes",
        // Popups (target=_blank, OAuth sign-in windows) reach main's side-browser window-open handler, which allows http(s) only
        // and hardens every child window (`side-browser-webview.ts`).
        allowpopups: "true",
        style: {
          position: "absolute",
          display: "flex",
          border: 0,
          background: "transparent",
        },
      })}
    </div>
  );
}

export function WebSurfaceLayer({ api }: { api: AveApi }) {
  const surfaces = useSyncExternalStore(subscribeWebSurfaces, getWebSurfaces);

  useEffect(() => {
    const unsubscribe = subscribeWebSurfaceLayout(kick);
    const observer = new ResizeObserver(kick);
    let observed = new Set<HTMLElement>();
    // Slots and occluders come and go; observe exactly the current ones.
    const observeAll = () => {
      const current = new Set<HTMLElement>(getWebSurfaceOccluders());
      current.add(document.documentElement);
      for (const { tabId } of getWebSurfaces()) {
        const slot = getWebSurfaceSlot(tabId);
        if (slot) current.add(slot);
      }
      for (const element of observed) if (!current.has(element)) observer.unobserve(element);
      for (const element of current) if (!observed.has(element)) observer.observe(element);
      observed = current;
    };
    const unsubscribeObserve = subscribeWebSurfaceLayout(observeAll);
    observeAll();
    window.addEventListener("resize", kick);
    document.addEventListener("transitionend", kick, true);
    document.addEventListener("animationend", kick, true);
    // Native drag and drop: the guest must not swallow `dragover` either.
    const onDragStart = () => beginSurfaceDrag();
    const onDragEnd = () => endSurfaceDrag();
    // A drag whose source left the DOM reports no end; the next real pointer movement proves no drag is running.
    const onPointerMove = (event: PointerEvent) => {
      if (event.buttons === 0 && isSurfaceDragActive()) resetSurfaceDrag();
    };
    window.addEventListener("dragstart", onDragStart, true);
    window.addEventListener("dragend", onDragEnd, true);
    window.addEventListener("drop", onDragEnd, true);
    window.addEventListener("pointermove", onPointerMove, true);
    const idle = window.setInterval(() => {
      if (placed.size > 0) placeWebSurfaces();
    }, IDLE_CHECK_MS);
    return () => {
      unsubscribe();
      unsubscribeObserve();
      observer.disconnect();
      window.removeEventListener("resize", kick);
      document.removeEventListener("transitionend", kick, true);
      document.removeEventListener("animationend", kick, true);
      window.removeEventListener("dragstart", onDragStart, true);
      window.removeEventListener("dragend", onDragEnd, true);
      window.removeEventListener("drop", onDragEnd, true);
      window.removeEventListener("pointermove", onPointerMove, true);
      window.clearInterval(idle);
      if (rafId !== 0) cancelAnimationFrame(rafId);
      rafId = 0;
    };
  }, []);

  return createPortal(
    <div
      data-testid="web-surface-layer"
      style={{ position: "fixed", inset: 0, pointerEvents: "none", zIndex: WEB_SURFACE_LAYER_Z }}
    >
      {surfaces.map((surface) => <GuestFrame key={surface.tabId} api={api} surface={surface} />)}
    </div>,
    document.body,
  );
}

/**
 * Where a browser tab's page appears: a placeholder the layer lays the tab's
 * guest over. Rendering a slot never creates or reloads a page — the guest
 * lives in the layer — so a slot may mount, unmount and move freely.
 *
 * One tab, one slot: a second slot for the same tab (`useSurfaceMount`) shows
 * a notice until the first one goes, then takes the page over.
 */
export function WebSurfaceSlot({
  tabId,
  url,
  location,
  bindRequestId,
}: {
  tabId: string;
  /** The url the host wants this tab on; navigates the guest when it changes. */
  url: string;
  /** Where the slot is mounted: "side-panel" or "pane:<id>". */
  location: string;
  /** The agent request the tab was opened for, bound with its guest (see `WebSurface`). */
  bindRequestId?: string;
}) {
  const { t } = useTranslation();
  const mount = useSurfaceMount(tabId, location);
  const [element, setElement] = useState<HTMLDivElement | null>(null);

  useEffect(() => {
    if (mount.owned) setWebSurfaceUrl(tabId, url, bindRequestId);
  }, [mount.owned, tabId, url, bindRequestId]);

  useEffect(() => {
    if (!mount.owned || !element) return undefined;
    setWebSurfaceSlot(tabId, element);
    return () => clearWebSurfaceSlot(tabId, element);
  }, [mount.owned, element, tabId]);

  return (
    <div
      ref={setElement}
      className="relative h-full min-h-0 w-full min-w-0 flex-1 bg-background"
      data-testid="web-surface-slot"
      data-tab-id={tabId}
      data-owned={mount.owned ? "true" : "false"}
    >
      {mount.owned ? null : (
        <div
          className="flex h-full items-center justify-center p-4 text-center text-sm text-muted-foreground"
          data-testid="web-surface-mounted-elsewhere"
          data-owner-location={mount.ownerLocation ?? ""}
        >
          {t("webSurface.mountedElsewhere")}
        </div>
      )}
    </div>
  );
}
