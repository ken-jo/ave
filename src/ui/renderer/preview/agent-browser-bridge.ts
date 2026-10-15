/**
 * The renderer's half of the agent browser tools' tab operations.
 *
 * Main sends one `ave:browser:tab-op` stream per window, but a window can
 * hold several chat views, each with its own workspace-tab store. This
 * module subscribes ONCE and routes each operation to exactly one store:
 *   · select / close → the store that holds the tab;
 *   · new            → the store of the chat the tab is opened for
 *                      (`sessionId`), else the first store registered.
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
  openAgentTab: (url: string, requestId: string) => void;
  selectTab: (tabId: string) => void;
  closeTab: (tabId: string) => void;
}

const hosts: BrowserTabHost[] = [];
let unsubscribe: (() => void) | null = null;
let controlled: ReadonlySet<string> = new Set();
const controlListeners = new Set<() => void>();

/** Route one operation to the single host that should carry it out. */
export function routeBrowserTabOp(request: BrowserTabOpRequest, candidates: readonly BrowserTabHost[] = hosts): void {
  if (request.op === "new") {
    const host = candidates.find((candidate) => request.sessionId !== undefined && candidate.sessionId() === request.sessionId)
      ?? candidates[0];
    host?.openAgentTab(request.url, request.requestId);
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
    unsubscribe = () => {
      offOp();
      offControl();
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
