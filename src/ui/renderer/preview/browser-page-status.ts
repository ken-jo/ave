/**
 * What main knows about each browser tab's page (a failed load, and later its other host-drawn states), held once per
 * window. Main sends whole revisioned snapshots; the newest one replaces the previous, nothing is merged.
 */
import { useSyncExternalStore } from "react";
import type { BrowserPageStatus, BrowserPromptAnswer, BrowserWorkspaceState, BrowserWorkspaceTarget } from "../../../shared/browser-workspace.js";
import type { AveApi } from "../types.js";
import { navigateBrowserTabAsUser, openLinkTabInHost } from "./agent-browser-bridge.js";

let api: AveApi | null = null;
let state: BrowserWorkspaceState | null = null;
const listeners = new Set<() => void>();

function accept(next: BrowserWorkspaceState): void {
  if (state && next.revision < state.revision) return;
  state = next;
  for (const listener of [...listeners]) listener();
}

/** Mounted once by the window's web-surface layer. */
export function connectBrowserPageStatus(next: AveApi): () => void {
  const workspace = next.browserWorkspace;
  if (!workspace) return () => {};
  api = next;
  let alive = true;
  const off = workspace.onChanged((value) => { if (alive) accept(value); });
  // A page asked for a link in a new tab. A page that is not a tab in a strip (a web pane) shows the link in itself, so
  // the link still opens somewhere with an address row.
  const offOpenTab = workspace.onOpenTab((request) => {
    if (alive && !openLinkTabInHost(request.url, request.openerTabId, request.active)) loadBrowserPageUrl(request.openerTabId, request.url);
  });
  void workspace.getState().then((result) => { if (alive && result.ok) accept(result.value); });
  return () => {
    alive = false;
    off();
    offOpenTab();
    if (api === next) { api = null; state = null; }
  };
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function browserPageStatus(tabId: string): BrowserPageStatus | null {
  return state?.pages.find((page) => page.tabId === tabId) ?? null;
}

/** The tab's current document as main last described it; requests name it so main can refuse a stale one. */
function browserPageTarget(tabId: string): BrowserWorkspaceTarget | null {
  const tab = state?.tabs.find((candidate) => candidate.tabId === tabId);
  return tab ? { tabId: tab.tabId, documentGeneration: tab.documentGeneration } : null;
}

/** The whole snapshot the page statuses come from: the site rules and what the host can grant. */
export function useBrowserWorkspaceSnapshot(): BrowserWorkspaceState | null {
  return useSyncExternalStore(subscribe, () => state);
}

export function useBrowserPageStatus(tabId: string): BrowserPageStatus | null {
  return useSyncExternalStore(subscribe, () => browserPageStatus(tabId));
}

/**
 * A navigation the user starts from the app's own controls. The tab is first taken back from the agent, then main is told
 * the coming unload is the user's, so a page's unload handler cannot hold it back, and only then does `navigate` run.
 * A tab with no page yet has nothing to unload and navigates at once.
 */
export function navigateBrowserPageAsUser(client: AveApi, tabId: string, navigate: () => void): void {
  void navigateBrowserTabAsUser(client, tabId, () => {
    const target = browserPageTarget(tabId);
    const workspace = client.browserWorkspace;
    if (!target || !workspace) { navigate(); return; }
    void workspace.userNavigation(target).then(navigate);
  });
}

/** The user asks for the failed page again. */
export function retryBrowserPageLoad(tabId: string): void {
  const connected = api;
  const target = browserPageTarget(tabId);
  if (!connected?.browserWorkspace || !target) return;
  const workspace = connected.browserWorkspace;
  navigateBrowserPageAsUser(connected, tabId, () => { void workspace.retryLoad(target); });
}

/** Load `url` in the tab's existing page. For an address the tab is already pointed at, where pointing it again changes nothing. */
export function loadBrowserPageUrl(tabId: string, url: string): void {
  const target = browserPageTarget(tabId);
  if (target) void api?.browserWorkspace?.load({ ...target, url });
}

export function answerBrowserPagePrompt(tabId: string, promptId: string, answer: BrowserPromptAnswer): void {
  void api?.browserWorkspace?.answerPrompt({ tabId, promptId, answer });
}

/** The user stops the load in progress. */
export function stopBrowserPageLoad(tabId: string): void {
  const connected = api;
  const target = browserPageTarget(tabId);
  if (!connected?.browserWorkspace || !target) return;
  const workspace = connected.browserWorkspace;
  void navigateBrowserTabAsUser(connected, tabId, () => { void workspace.stopLoad(target); });
}

export function openBrowserPageInSystemBrowser(url: string): void {
  void api?.openExternalUrl(url);
}

export function __setBrowserPageStatusForTest(next: BrowserWorkspaceState | null, client: AveApi | null = null): void {
  state = next;
  api = client;
  for (const listener of [...listeners]) listener();
}
