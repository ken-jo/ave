/** Subscribe once per window and route tab operations to one store: existing-tab owner, or the requesting chat for new
 * tabs. */
import { useSyncExternalStore } from "react";
import type { BrowserTabControlState, BrowserTabOpRequest } from "../../../shared/browser-surface.js";
import type { AveApi } from "../types.js";
import { getWebSurfaceElement, getWebSurfaceSlot, noteWebSurfaceFavicon, requestWebSurfaceLayout, setWebSurfaceAwake } from "./web-surfaces.js";
import { guestFaviconSource } from "./favicon-source.js";
import { isElementShown } from "./browser-observation-preview.js";

export interface BrowserTabHost {
  /** The conversation this host's chat view shows, or null. */
  sessionId: () => string | null;
  hasTab: (tabId: string) => boolean;
  /** Absent for a host that holds tabs but does not open the agent's new ones. `owner` is the conversation the op names: the
   * tab belongs to that chat, never to whichever chat this host shows. */
  openAgentTab?: (url: string, requestId: string, active: boolean, owner: string) => void;
  /** Load an agent page into this host's existing empty browser tab; false when the tab is not an empty browser page. */
  loadAgentTab?: (tabId: string, url: string, requestId: string) => boolean;
  selectTab: (tabId: string) => void;
  closeTab: (tabId: string) => void;
}

const hosts: BrowserTabHost[] = [];

/** Close from trusted window chrome through the same host that handles tab operations. */
export function closeBrowserTab(tabId: string): void {
  const host = hosts.find((candidate) => candidate.hasTab(tabId));
  if (!host) return;
  host.closeTab(tabId);
}
let unsubscribe: (() => void) | null = null;
let controlled: ReadonlySet<string> = new Set();
const EMPTY_CONTROL_STATE: BrowserTabControlState = { revision: -1, tabs: [] };
let controlState = EMPTY_CONTROL_STATE;
let controlFailure = false;
const controlListeners = new Set<() => void>();

/** Main revokes ownership before any user navigation, including while the badge mirror is empty. */
export async function navigateBrowserTabAsUser(api: AveApi, tabId: string, navigate: () => void): Promise<void> {
  let stopped;
  try {
    stopped = await api.browserTabs?.stop(tabId);
  } catch {
    // An unconfirmed takeover must not navigate under the agent's authority.
    setControlFailure(true);
    return;
  }
  if (stopped?.ok) navigate();
  else setControlFailure(true);
}

function isWebview(element: Element): boolean {
  return element.tagName === "WEBVIEW";
}

/**
 * Where keyboard focus was in the app before a browser page took it, so the
 * agent holds page focus only while it acts. Remembers the last focused
 * element for pointer actions; visible native focus borrowing uses a scoped receipt. `restore` gives focus back to it,
 * but only while a page still holds focus: if the user has moved on, their
 * focus stays where they put it.
 */
export class HostFocusMemory {
  /** Most recent last. Several, because the latest (an approval card's button) is often gone by the time focus comes back. */
  private recent: HTMLElement[] = [];
  private readonly receipts = new Map<string, { guest: HTMLElement; previous: HTMLElement; previousGuestId?: number; moved: boolean; borrowed: boolean }>();

  private visible(element: HTMLElement): boolean {
    const bounds = element.getBoundingClientRect();
    const style = this.doc.defaultView?.getComputedStyle(element);
    return element.isConnected && element.closest("[inert], [hidden]") === null && bounds.width > 0 && bounds.height > 0
      && style?.display !== "none" && style?.visibility !== "hidden" && this.doc.visibilityState === "visible";
  }

  capture(receiptId: string, guest: HTMLElement): boolean {
    const previous = this.doc.activeElement;
    if (this.receipts.size > 0 || !guest.isConnected || !(previous instanceof HTMLElement) || previous === guest || !this.visible(previous)) return false;
    let previousGuestId: number | undefined;
    if (isWebview(previous)) {
      try { previousGuestId = (previous as HTMLElement & { getWebContentsId(): number }).getWebContentsId(); } catch { return false; }
      if (!Number.isSafeInteger(previousGuestId) || previousGuestId <= 0) return false;
    }
    this.receipts.set(receiptId, { guest, previous, previousGuestId, moved: false, borrowed: false });
    return true;
  }

  restoreReceipt(receiptId: string, guest: HTMLElement | null, preserveFocus = false): boolean {
    const receipt = this.receipts.get(receiptId);
    if (!receipt) return false;
    if (guest !== receipt.guest && (guest !== null || receipt.guest.isConnected)) {
      if (!receipt.guest.isConnected) this.receipts.delete(receiptId);
      return false;
    }
    this.receipts.delete(receiptId);
    if (receipt.moved || preserveFocus) return true;
    const active = this.doc.activeElement;
    if (active === receipt.previous) return true;
    if (active !== receipt.guest && active !== this.doc.body) return true;
    if (!this.visible(receipt.previous)) {
      if (receipt.previousGuestId !== undefined) return false;
      this.restore();
      return this.doc.activeElement !== receipt.guest;
    }
    if (receipt.previousGuestId !== undefined) {
      try { if ((receipt.previous as HTMLElement & { getWebContentsId(): number }).getWebContentsId() !== receipt.previousGuestId) return false; } catch { return false; }
    }
    receipt.previous.focus();
    if (this.doc.activeElement === receipt.previous) return true;
    if (receipt.previousGuestId !== undefined) return false;
    this.restore();
    return this.doc.activeElement !== receipt.guest;
  }

  constructor(private readonly doc: Document) {}

  readonly onFocusIn = (event: FocusEvent): void => {
    const target = event.target;
    for (const receipt of this.receipts.values()) {
      if (target === receipt.guest && !receipt.borrowed) receipt.borrowed = true;
      else if (target !== receipt.guest && (target !== receipt.previous || receipt.borrowed)) receipt.moved = true;
    }
    if (!(target instanceof HTMLElement) || isWebview(target)) return;
    this.recent = [...this.recent.filter((element) => element !== target), target].slice(-HOST_FOCUS_HISTORY);
  };

  attach(): () => void {
    this.doc.addEventListener("focusin", this.onFocusIn, true);
    return () => this.doc.removeEventListener("focusin", this.onFocusIn, true);
  }

  restore(parkedGuest?: HTMLElement | null): void {
    const active = this.doc.activeElement;
    if (parkedGuest !== undefined && active instanceof HTMLElement && active !== parkedGuest && active !== this.doc.body) {
      // Reassert the current surface even when the embedder's active element did not change.
      if (isWebview(active)) {
        const frame = active.shadowRoot?.querySelector("iframe");
        frame?.blur();
        frame?.focus({ preventScroll: true });
      } else if (this.visible(active)) {
        active.blur();
        active.focus({ preventScroll: true });
      }
      return;
    }
    if (!(active instanceof HTMLElement) || !isWebview(active) && active !== this.doc.body) return;
    for (const back of [...this.recent].reverse()) {
      if (!this.visible(back)) continue;
      back.focus();
      if (this.doc.activeElement !== active) return;
    }
    active.blur();
  }
}

const HOST_FOCUS_HISTORY = 8;

let hostFocus: HostFocusMemory | null = null;

/** Route one operation to the single host that should carry it out. Returns "refused" for a `new` op naming a page
 * (`inTabId`) that no host can load into, so the caller tells main at once instead of letting the agent wait out the
 * timeout. */
export function routeBrowserTabOp(request: BrowserTabOpRequest, candidates: readonly BrowserTabHost[] = hosts): "refused" | undefined {
  if (request.op === "wake" || request.op === "sleep") {
    setWebSurfaceAwake(request.tabId, request.op === "wake");
    return;
  }
  if (request.op === "capture-focus") {
    const guest = getWebSurfaceElement(request.tabId);
    return guest && hostFocus?.capture(request.requestId, guest) ? undefined : "refused";
  }
  if (request.op === "focus") {
    const guest = getWebSurfaceElement(request.tabId);
    if (!guest?.isConnected || document.visibilityState !== "visible" || guest.closest("[inert]")) return;
    const bounds = guest.getBoundingClientRect();
    const style = getComputedStyle(guest);
    if (bounds.width > 0 && bounds.height > 0 && style.visibility !== "hidden" && style.display !== "none") guest.focus();
    return;
  }
  if (request.op === "restore-focus") {
    if (request.receiptId !== undefined) {
      return hostFocus?.restoreReceipt(request.receiptId, getWebSurfaceElement(request.tabId), request.preserveFocus) ? undefined : "refused";
    }
    const guest = getWebSurfaceElement(request.tabId);
    const slot = getWebSurfaceSlot(request.tabId);
    // Parking keeps the old frame painted until acknowledgement; the slot owns display intent.
    if (guest === document.activeElement && slot && isElementShown(slot)) return;
    if (!hostFocus) return "refused";
    hostFocus.restore(guest);
    return;
  }
  if (request.op === "new" && request.inTabId !== undefined) {
    const inTabId = request.inTabId;
    const host = candidates.find((candidate) => candidate.loadAgentTab !== undefined && candidate.hasTab(inTabId));
    // The pane's page closed, or already shows a page, between main's check and this op.
    if (host?.loadAgentTab?.(inTabId, request.url, request.requestId) !== true) return "refused";
    return;
  }
  if (request.op === "new") {
    // Main names the conversation on every agent tab it opens; one that names none has no owner to give the tab.
    const owner = request.ownerSessionId;
    if (owner === undefined) throw new Error(`browser-tab-op-unowned: new tab ${request.requestId} names no conversation`);
    const host = candidates.find((candidate) => candidate.openAgentTab !== undefined && candidate.sessionId() === request.sessionId);
    host?.openAgentTab?.(request.url, request.requestId, request.active, owner);
    return;
  }
  const host = candidates.find((candidate) => candidate.hasTab(request.tabId));
  if (!host) return;
  if (request.op === "select") host.selectTab(request.tabId);
  else host.closeTab(request.tabId);
}

function notifyControl(): void {
  for (const listener of controlListeners) listener();
}

function setControlFailure(failed: boolean): void {
  if (controlFailure === failed) return;
  controlFailure = failed;
  notifyControl();
}

function setControlState(state: BrowserTabControlState): void {
  if (state.revision <= controlState.revision) return;
  controlState = state;
  controlled = new Set(state.tabs.filter((tab) => tab.mode === "agent-active" && tab.rendererTabId !== null)
    .map((tab) => tab.rendererTabId!));
  controlFailure = false;
  notifyControl();
}

/** Register a chat view's tab store. The first registration subscribes to main; the last unregistration unsubscribes.
 * Returns the unregister function. */
export function registerBrowserTabHost(api: AveApi, host: BrowserTabHost): () => void {
  hosts.push(host);
  if (!unsubscribe && api.browserTabs) {
    let current = true;
    const tabs = api.browserTabs;
    const offOp = tabs.onTabOp((request) => {
      const result = routeBrowserTabOp(request);
      if (request.op === "capture-focus" || request.op === "restore-focus") {
        void tabs.completeFocus(request.requestId, result !== "refused");
      } else if (result === "refused") void tabs.refuseTabOp(request.requestId);
    });
    const offControl = api.browserTabs.onControl((state) => setControlState(state));
    void api.browserTabs.getState().then((state) => {
      if (current) setControlState(state);
    }, () => {
      if (current) setControlFailure(true);
    });
    hostFocus = new HostFocusMemory(document);
    const offFocus = hostFocus.attach();
    unsubscribe = () => {
      current = false;
      offOp();
      offControl();
      offFocus();
      hostFocus = null;
    };
  }
  return () => {
    const index = hosts.indexOf(host);
    if (index >= 0) hosts.splice(index, 1);
    if (hosts.length === 0 && unsubscribe) {
      unsubscribe();
      unsubscribe = null;
      controlState = EMPTY_CONTROL_STATE;
      controlled = new Set();
      controlFailure = false;
      notifyControl();
    }
  };
}

function subscribeControl(listener: () => void): () => void {
  controlListeners.add(listener);
  return () => controlListeners.delete(listener);
}

/** Bind retries while main has not yet seen the guest attach. */
const BIND_RETRY_LIMIT = 20;
const BIND_RETRY_MS = 100;
const acceptedBindings = new WeakMap<HTMLElement, number>();

/** A live guest stays visible until main has blocked parked input and returned native focus. */
export async function reportGuestParking(api: AveApi, webview: HTMLElement, tabId: string, parked: boolean): Promise<boolean> {
  try {
    const guest = webview as HTMLElement & { getWebContentsId?: () => number };
    const id = guest.getWebContentsId?.();
    if (id === undefined) return true;
    if (acceptedBindings.get(webview) !== id || !api.browserTabs) return false;
    const result = await api.browserTabs.bindTab({ tabId, webContentsId: id, parked });
    return result.ok && acceptedBindings.get(webview) === id && guest.getWebContentsId?.() === id;
  } catch { return false; }
}

/** Bind on attach and first dom-ready; retry guest-not-live because renderer attach can precede main's guest registration. */
export function bindGuestToTab(
  api: AveApi,
  webview: HTMLElement,
  tabId: string,
  requestId: string | undefined,
): () => void {
  const browserTabs = api.browserTabs;
  if (!browserTabs) return () => undefined;
  let cancelled = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  /** The latest requested guest, pending or accepted; rejection allows another dom-ready attempt. */
  let sentFor: number | undefined;
  let bindSequence = 0;
  const guestId = (): number | undefined => {
    try {
      const id = (webview as HTMLElement & { getWebContentsId?: () => number }).getWebContentsId?.();
      return typeof id === "number" ? id : undefined;
    } catch {
      // Not attached, or not yet ready to name its guest: a later event binds it.
      return undefined;
    }
  };
  const onAttach = (attempt = 0) => {
    if (cancelled) return;
    const webContentsId = guestId();
    if (webContentsId === undefined) return;
    if (retry !== undefined) {
      clearTimeout(retry);
      retry = undefined;
    }
    const sequence = ++bindSequence;
    sentFor = webContentsId;
    void browserTabs.bindTab({
      tabId,
      webContentsId,
      parked: !isElementShown(webview),
      ...(requestId === undefined ? {} : { requestId }),
    }).then((result) => {
      if (cancelled || sequence !== bindSequence) return;
      if (result.ok) {
        acceptedBindings.set(webview, webContentsId);
        requestWebSurfaceLayout();
        return;
      }
      sentFor = undefined;
      if (result.error === "guest-not-live" && attempt < BIND_RETRY_LIMIT) {
        retry = setTimeout(() => onAttach(attempt + 1), BIND_RETRY_MS);
      }
    }, () => {
      if (!cancelled && sequence === bindSequence) sentFor = undefined;
    });
  };
  const clearFavicon = () => noteWebSurfaceFavicon(tabId, null);
  const onAttachEvent = () => { clearFavicon(); onAttach(); };
  const onNavigate = (event: Event) => {
    if ((event as Event & { isMainFrame?: boolean }).isMainFrame !== false) clearFavicon();
  };
  const onFavicon = (event: Event) => {
    const icons = (event as Event & { favicons?: unknown }).favicons;
    const favicon = Array.isArray(icons) ? icons.find((icon) => guestFaviconSource(icon) !== null) : undefined;
    noteWebSurfaceFavicon(tabId, guestFaviconSource(favicon));
  };
  const onReady = () => {
    const webContentsId = guestId();
    if (webContentsId !== undefined && webContentsId !== sentFor) onAttach();
  };
  webview.addEventListener("did-attach", onAttachEvent);
  webview.addEventListener("dom-ready", onReady);
  webview.addEventListener("did-navigate", onNavigate);
  webview.addEventListener("page-favicon-updated", onFavicon);
  // Already attached (the tab id or request changed on a live guest).
  onAttach();
  return () => {
    acceptedBindings.delete(webview);
    cancelled = true;
    if (retry !== undefined) clearTimeout(retry);
    webview.removeEventListener("did-attach", onAttachEvent);
    webview.removeEventListener("dom-ready", onReady);
    webview.removeEventListener("did-navigate", onNavigate);
    webview.removeEventListener("page-favicon-updated", onFavicon);
  };
}

/** The window's tab ids the agent controls (badge + stop button). */
export function useAgentControlledTabIds(): ReadonlySet<string> {
  return useSyncExternalStore(subscribeControl, () => controlled, () => controlled);
}

/** The same host state for active and paused control, independent of pane placement. */
export function useBrowserControlState(): BrowserTabControlState {
  return useSyncExternalStore(subscribeControl, () => controlState, () => controlState);
}

/** Main's `agentDrivesTab` rule on the broadcast state: leased or owned by the session (or its direct child), and not paused.
 * `agent-active` alone is only the span of one leased action; an owned tab reads `human` between actions. */
export function agentDrivesBrowserTab(tab: BrowserTabControlState["tabs"][number], sessionId: string): boolean {
  if (tab.mode === "human-paused") return false;
  return tab.lease?.actor.sessionId === sessionId || tab.owner?.sessionId === sessionId
    || tab.owner?.directParentSessionId === sessionId;
}

export function useBrowserControlUnavailable(): boolean {
  return useSyncExternalStore(subscribeControl, () => controlFailure, () => controlFailure);
}

/** Test-only. */
export function __resetBrowserTabBridgeForTest(): void {
  hosts.length = 0;
  unsubscribe?.();
  unsubscribe = null;
  controlled = new Set();
  controlState = EMPTY_CONTROL_STATE;
  controlFailure = false;
  controlListeners.clear();
}
