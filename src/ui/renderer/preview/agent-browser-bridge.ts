/**
 * The renderer's half of the agent browser tools' tab operations.
 *
 * Main sends one `ave:browser:tab-op` stream per window, but a window can
 * hold several chat views, each with its own workspace-tab store. This
 * module subscribes ONCE and routes each operation to exactly one store:
 *   · select / close → the store that holds the tab;
 *   · new            → the store of the chat the tab is opened for
 *                      (`sessionId`), else the first store registered that
 *                      opens agent tabs (the main area's web panels do
 *                      not: an agent's new tab goes beside its chat).
 * It also mirrors main's agent-control state for the "Agent is controlling
 * this tab" badge. Main resolves the agent's request only when it observes
 * the result (a bind, the guest gone, the tab shown), so a dropped or
 * unroutable operation simply times out there.
 */
import { useSyncExternalStore } from "react";
import type { BrowserTabOpRequest } from "../../../shared/browser-surface.js";
import type { AveApi } from "../types.js";

export interface BrowserTabHost {
  /** The conversation this host's chat view shows, or null. */
  sessionId: () => string | null;
  hasTab: (tabId: string) => boolean;
  /** Absent for a host that holds tabs but does not open the agent's new ones. */
  openAgentTab?: (url: string, requestId: string) => void;
  selectTab: (tabId: string) => void;
  closeTab: (tabId: string) => void;
}

const hosts: BrowserTabHost[] = [];
let unsubscribe: (() => void) | null = null;
let controlled: ReadonlySet<string> = new Set();
const controlListeners = new Set<() => void>();

/** Main revokes ownership before any user navigation, including while the badge mirror is empty. */
export async function navigateBrowserTabAsUser(api: AveApi, tabId: string, navigate: () => void): Promise<void> {
  let stopped;
  try {
    stopped = await api.browserTabs?.stop(tabId);
  } catch {
    // An unconfirmed takeover must not navigate under the agent's authority.
    return;
  }
  if (stopped?.ok) navigate();
}

function isWebview(element: Element): boolean {
  return element.tagName === "WEBVIEW";
}

/**
 * Where keyboard focus was in the app before a browser page took it, so the
 * agent holds page focus only while it acts. Remembers the last focused
 * element that is not a page (<webview>); `restore` gives focus back to it,
 * but only while a page still holds focus: if the user has moved on, their
 * focus stays where they put it.
 */
export class HostFocusMemory {
  /** Most recent last. Several, because the latest (an approval card's button) is often gone by the time focus comes back. */
  private recent: HTMLElement[] = [];

  constructor(private readonly doc: Document) {}

  readonly onFocusIn = (event: FocusEvent): void => {
    const target = event.target;
    if (!(target instanceof HTMLElement) || isWebview(target)) return;
    this.recent = [...this.recent.filter((element) => element !== target), target].slice(-HOST_FOCUS_HISTORY);
  };

  attach(): () => void {
    this.doc.addEventListener("focusin", this.onFocusIn, true);
    return () => this.doc.removeEventListener("focusin", this.onFocusIn, true);
  }

  restore(): void {
    const active = this.doc.activeElement;
    if (!(active instanceof HTMLElement) || !isWebview(active)) return;
    const back = [...this.recent].reverse().find((element) => element.isConnected && element.closest("[inert]") === null);
    if (back) back.focus();
    else active.blur();
  }
}

const HOST_FOCUS_HISTORY = 8;

let hostFocus: HostFocusMemory | null = null;

/** Route one operation to the single host that should carry it out. */
export function routeBrowserTabOp(request: BrowserTabOpRequest, candidates: readonly BrowserTabHost[] = hosts): void {
  if (request.op === "restore-focus") {
    hostFocus?.restore();
    return;
  }
  if (request.op === "new") {
    const openers = candidates.filter((candidate) => candidate.openAgentTab !== undefined);
    const host = openers.find((candidate) => request.sessionId !== undefined && candidate.sessionId() === request.sessionId)
      ?? openers[0];
    host?.openAgentTab?.(request.url, request.requestId);
    return;
  }
  const host = candidates.find((candidate) => candidate.hasTab(request.tabId));
  if (!host) return;
  if (request.op === "select") host.selectTab(request.tabId);
  else host.closeTab(request.tabId);
}

function setControlled(ids: readonly string[]): void {
  controlled = new Set(ids);
  for (const listener of controlListeners) listener();
}

/**
 * Register a chat view's tab store. The first registration subscribes to
 * main; the last unregistration unsubscribes. Returns the unregister function.
 */
export function registerBrowserTabHost(api: AveApi, host: BrowserTabHost): () => void {
  hosts.push(host);
  if (!unsubscribe && api.browserTabs) {
    const offOp = api.browserTabs.onTabOp((request) => routeBrowserTabOp(request));
    const offControl = api.browserTabs.onControl((state) => setControlled(state.agentControlledTabIds));
    hostFocus = new HostFocusMemory(document);
    const offFocus = hostFocus.attach();
    unsubscribe = () => {
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
      setControlled([]);
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

/**
 * Bind the guest of `webview` to `tabId` in main (`ave:browser:bind-tab`) on
 * every attach, and now if it is already attached, so the agent browser tools
 * can reach the tab's page. `requestId` marks a tab opened for the agent.
 * Returns the cleanup. The page's did-attach can reach the renderer before
 * main has seen the guest attach (main's did-attach-webview); main answers
 * guest-not-live until then, so the bind is retried shortly. And at
 * did-attach the element cannot name its guest yet (measured: Electron's
 * `getWebContentsId()` throws until the guest's first dom-ready), so the
 * first dom-ready of each guest binds it too.
 */
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
  /** The guest last sent to main; a dom-ready of the same guest does not bind again. */
  let sentFor: number | undefined;
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
    sentFor = webContentsId;
    void browserTabs.bindTab({
      tabId,
      webContentsId,
      ...(requestId === undefined ? {} : { requestId }),
    }).then((result) => {
      if (!result.ok && result.error === "guest-not-live" && attempt < BIND_RETRY_LIMIT && !cancelled) {
        retry = setTimeout(() => onAttach(attempt + 1), BIND_RETRY_MS);
      }
    });
  };
  const onAttachEvent = () => onAttach();
  const onReady = () => {
    const webContentsId = guestId();
    if (webContentsId !== undefined && webContentsId !== sentFor) onAttach();
  };
  webview.addEventListener("did-attach", onAttachEvent);
  webview.addEventListener("dom-ready", onReady);
  // Already attached (the tab id or request changed on a live guest).
  onAttach();
  return () => {
    cancelled = true;
    if (retry !== undefined) clearTimeout(retry);
    webview.removeEventListener("did-attach", onAttachEvent);
    webview.removeEventListener("dom-ready", onReady);
  };
}

/** The window's tab ids the agent controls (badge + stop button). */
export function useAgentControlledTabIds(): ReadonlySet<string> {
  return useSyncExternalStore(subscribeControl, () => controlled, () => controlled);
}

/** Test-only. */
export function __resetBrowserTabBridgeForTest(): void {
  hosts.length = 0;
  unsubscribe?.();
  unsubscribe = null;
  controlled = new Set();
  controlListeners.clear();
}
