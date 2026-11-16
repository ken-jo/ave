import { isBackgroundE2eRuntime, whenFocusEmulated } from "../e2e-window-presentation.js";
import { clipboard, dialog, Menu, session, shell, type BrowserWindow, type MenuItemConstructorOptions, type WebContents } from "electron";
import type { ObservedDownload } from "./browser-download-staging.js";
import { t } from "../../i18n/index.js";
import { createLogger } from "../../lib/logger.js";
import { browserWorkspaceUrl, type BrowserDownloadBlockReason } from "../../shared/browser-workspace.js";
import type { BrowserTabControlState } from "../../shared/browser-surface.js";
import { AVE_SIDE_BROWSER_PARTITION } from "../../shared/side-browser.js";
import { getMainWindows } from "../app-state.js";
import type { MainWindow } from "../main-window-host.js";
import { observeAgentBrowserDownload } from "../browser-observation.js";
import { trackBrowserGuest } from "./browser-guest-tracking.js";
import { subscribeBrowserGuestDestroyed } from "./browser-guest-lifecycle.js";
import { dismissedPageDialogs } from "./browser-page-dialogs.js";
import { pageContextMenu, type PageContextMenuParams } from "./browser-page-context-menu.js";
import { browserTabRegistry } from "./browser-tab-registry.js";
import { createBrowserWorkspaceService, type BrowserWorkspaceService } from "./browser-workspace.js";

const log = createLogger("browser-workspace-desktop");
const FOCUS_TIMEOUT_MS = 750;
const guests = new Map<number, { contents: WebContents; owner: MainWindow; dispose(): void }>();
const windows = new Map<number, { owner: MainWindow; dispose(): void }>();
const popups = new Map<string, { window: BrowserWindow; owner: MainWindow; title: string; dispose(): void }>();
let service: BrowserWorkspaceService | null = null;

function mainWindow(windowId: number): MainWindow | undefined {
  return getMainWindows().find((window) => !window.isDestroyed() && window.id === windowId);
}

// Created only when the browser workspace is first used.
export function getBrowserWorkspaceService(): BrowserWorkspaceService {
  return service ??= createBrowserWorkspaceService({
    liveTab: (windowId, rendererTabId) => {
      const tab = browserTabRegistry.liveRendererTab(windowId, rendererTabId);
      return tab?.guest ? { guest: tab.guest, documentGeneration: tab.documentId } : null;
    },
    listTabs: (windowId) => browserTabRegistry.controlState(windowId).tabs.flatMap((view) => {
      if (view.rendererTabId === null) return [];
      const tab = browserTabRegistry.liveRendererTab(windowId, view.rendererTabId);
      return tab?.guest ? [{ tabId: view.rendererTabId, documentGeneration: tab.documentId, url: view.url, title: view.title }] : [];
    }),
    isWindowVisible: (windowId) => {
      const window = mainWindow(windowId);
      return window !== undefined && window.isVisible() && !window.isMinimized();
    },
    // Installed only while a page-started navigation waits on the user's Leave or Stay; the profile has no other listener.
    holdPageRequests: (hold) => {
      const requests = session.fromPartition(AVE_SIDE_BROWSER_PARTITION).webRequest;
      if (hold === null) requests.onBeforeRequest(null);
      else requests.onBeforeRequest((details, callback) => hold(details, (send) => callback(send ? {} : { cancel: true })));
    },
    clearSiteData: async (origin) => {
      const profile = session.fromPartition(AVE_SIDE_BROWSER_PARTITION);
      await profile.clearStorageData({ ...(origin === null ? {} : { origin }), storages: [...BROWSER_SITE_DATA_STORAGES] });
      // Clearing everything also ends remembered HTTP sign-ins; one site's cannot be cleared apart from the rest.
      if (origin === null) await profile.clearAuthCache();
    },
    clearCache: () => session.fromPartition(AVE_SIDE_BROWSER_PARTITION).clearCache(),
    allowDownloads: (origin) => {
      if (!downloadAllowance) throw new Error("browser-download-policy-missing");
      downloadAllowance(origin);
    },
    showItemInFolder: (path) => shell.showItemInFolder(path),
    agentDrives: (guestId) => browserTabRegistry.isAgentActiveGuest(guestId),
    openExternal: (url) => shell.openExternal(url),
    promptPermission: async (request) => {
      const window = mainWindow(request.windowId);
      if (!window || !window.isVisible() || window.isMinimized()) return false;
      const result = await dialog.showMessageBox(window, {
        type: "question", title: request.origin,
        message: t("browserWorkspace.permissionPrompt.message", {
          origin: request.origin, permissions: request.permissions.map((permission) => t(`browserWorkspace.permission.${permission}`)).join(", "),
        }),
        buttons: [t("browserWorkspace.permissionPrompt.block"), t("browserWorkspace.permissionPrompt.allowOnce")],
        defaultId: 0, cancelId: 0, noLink: true,
      });
      return result.response === 1 && mainWindow(request.windowId) === window && window.isVisible() && !window.isMinimized();
    },
    fullscreenAvailable: () => false,
    onError: (error) => log.warn({ error }, "browser workspace operation failed"),
  });
}

// Main-owned identity for permission and download callbacks, never a renderer claim.
export function browserWorkspaceGuestWindowId(contents: WebContents | null): number | null {
  if (!contents || contents.isDestroyed() || contents.session !== session.fromPartition(AVE_SIDE_BROWSER_PARTITION)) return null;
  const entry = guests.get(contents.id);
  return entry?.contents === contents && !entry.owner.isDestroyed() && mainWindow(entry.owner.id) === entry.owner ? entry.owner.id : null;
}

/** The browser's menu for this page, with navigation as the user's. A popup has no tab beside which to open a link. */
export function browserPageMenuItems(contents: WebContents, windowId: number, params: PageContextMenuParams, opensTabs: boolean): MenuItemConstructorOptions[] {
  const workspace = getBrowserWorkspaceService();
  const asUser = (navigate: () => void) => () => { if (!contents.isDestroyed()) { workspace.userNavigatesGuest(contents.id); navigate(); } };
  return pageContextMenu(params, {
    pageUrl: browserWorkspaceUrl(contents.getURL()),
    canGoBack: contents.navigationHistory.canGoBack(), canGoForward: contents.navigationHistory.canGoForward(),
    back: asUser(() => contents.navigationHistory.goBack()), forward: asUser(() => contents.navigationHistory.goForward()), reload: asUser(() => contents.reload()),
    ...(opensTabs ? { openLinkInNewTab: (url: string) => { if (!contents.isDestroyed()) workspace.openLinkTab(windowId, contents.id, url, true); } } : {}),
    copyText: (text) => clipboard.writeText(text),
    openInSystemBrowser: (url) => { void shell.openExternal(url).catch((error: unknown) => log.warn({ error }, "browser page could not be opened in the system browser")); },
  });
}

export function observeBrowserWorkspaceGuest(contents: WebContents, owner: MainWindow): void {
  if (contents.isDestroyed() || owner.isDestroyed() || mainWindow(owner.id) !== owner
    || contents.session !== session.fromPartition(AVE_SIDE_BROWSER_PARTITION)) throw new Error("browser-guest-owner-mismatch");
  const guestId = contents.id;
  const windowId = owner.id;
  const existing = guests.get(guestId);
  if (existing) {
    if (existing.contents !== contents || existing.owner !== owner) throw new Error("browser-guest-owner-mismatch");
    return;
  }
  if (!windows.has(windowId)) {
    const invalidate = () => service?.invalidateWindow(windowId);
    const dispose = () => {
      owner.removeListener("hide", invalidate);
      owner.removeListener("minimize", invalidate);
      owner.removeListener("closed", dispose);
      service?.disposeWindow(windowId);
      for (const entry of [...guests.values()]) if (entry.owner === owner) entry.dispose();
      for (const popup of [...popups.values()]) if (popup.owner === owner) popup.dispose();
      windows.delete(windowId);
    };
    windows.set(windowId, { owner, dispose });
    owner.on("hide", invalidate);
    owner.on("minimize", invalidate);
    owner.once("closed", dispose);
  }
  const stopObserving = getBrowserWorkspaceService().observeGuest(windowId, contents);
  // A user's tab shows the browser's page menu. The agent's own view shows the same menu once the user has taken it
  // over, and a popup window shows it with the pause control; their hosts install those menus.
  const contextMenu = (event: { preventDefault(): void }, params: PageContextMenuParams) => {
    event.preventDefault();
    if (contents.isDestroyed() || owner.isDestroyed()) return;
    Menu.buildFromTemplate(browserPageMenuItems(contents, windowId, params, true)).popup({ window: owner });
  };
  const hasPageMenu = contents.getType() === "webview";
  if (hasPageMenu) contents.on("context-menu", contextMenu);
  let unsubscribe = () => {};
  const dispose = () => {
    unsubscribe();
    if (hasPageMenu && !contents.isDestroyed()) contents.removeListener("context-menu", contextMenu);
    stopObserving();
    guests.delete(guestId);
  };
  guests.set(guestId, { contents, owner, dispose });
  unsubscribe = subscribeBrowserGuestDestroyed(contents, dispose);
}

const BROWSER_SITE_DATA_STORAGES = ["cookies", "filesystem", "indexdb", "localstorage", "shadercache", "serviceworkers", "cachestorage"] as const;
let downloadAllowance: ((origin: string) => void) | null = null;
/** The download policy hands over how to lift a site's limit; the service calls it when the user asks in the tab. */
export function registerBrowserDownloadAllowance(allow: (origin: string) => void): void { downloadAllowance = allow; }
/** The download policy refused a download of this guest before it started. */
export function reportBrowserWorkspaceBlockedDownload(guestId: number, name: string, urlChain: readonly string[], reason: BrowserDownloadBlockReason): void {
  const entry = guests.get(guestId);
  if (browserTabRegistry.isAgentActiveGuest(guestId)) dismissedPageDialogs.noteDownload(guestId, name, "blocked", urlChain);
  if (entry && !entry.owner.isDestroyed()) getBrowserWorkspaceService().blockedDownload(entry.owner.id, guestId, name, reason);
}

// Called only after the existing native Save/rate policy admits the download.
export function observeBrowserWorkspaceDownload(contents: WebContents, item: ObservedDownload): void {
  const windowId = browserWorkspaceGuestWindowId(contents);
  if (windowId !== null) {
    getBrowserWorkspaceService().observeDownload(windowId, item);
    observeAgentBrowserDownload(contents, item);
    // A click that starts a download tells the model which file and how it went, not only that the click was done.
    if (browserTabRegistry.isAgentActiveGuest(contents.id)) {
      const update = dismissedPageDialogs.noteDownload(contents.id, item.getFilename(), "started", item.getURLChain());
      item.once("done", (_event, state) => update(state));
    }
  }
}

function focusPopup(window: BrowserWindow): Promise<boolean> {
  if (window.isDestroyed()) return Promise.resolve(false);
  const contents = window.webContents;
  if (contents.isDestroyed()) return Promise.resolve(false);
  if (isBackgroundE2eRuntime()) {
    if (window.isMinimized()) window.restore();
    window.showInactive();
    return whenFocusEmulated(contents);
  }
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let unsubscribe = () => {};
    let settled = false;
    const settle = (focused: boolean) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      window.removeListener("focus", inspect);
      window.removeListener("closed", closed);
      contents.removeListener("focus", inspect);
      unsubscribe();
      resolve(focused);
    };
    const inspect = () => {
      if (!window.isDestroyed() && !contents.isDestroyed() && window.isFocused() && contents.isFocused()) settle(true);
    };
    const closed = () => settle(false);
    window.on("focus", inspect);
    window.once("closed", closed);
    contents.on("focus", inspect);
    timer = setTimeout(() => settle(false), FOCUS_TIMEOUT_MS);
    unsubscribe = subscribeBrowserGuestDestroyed(contents, closed);
    try {
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
      contents.focus();
      inspect();
    } catch (error) {
      settle(false);
      log.warn({ error }, "browser popup focus failed");
    }
  });
}

function nativeTitle(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, "").slice(0, 160);
}

// Refreshes trusted native titles after the registry publishes its revisioned state.
export function refreshBrowserPopupControl(windowId: number, state: BrowserTabControlState): void {
  for (const [handle, popup] of popups) {
    if (popup.owner.isDestroyed() || popup.owner.id !== windowId || popup.window.isDestroyed()) continue;
    const tab = state.tabs.find((candidate) => candidate.tabId === handle && candidate.kind === "popup");
    if (!tab) continue;
    // The page chooses its title, so the origin main computed from the page's address comes first.
    const url = browserWorkspaceUrl(tab.url);
    popup.window.setTitle(`${url === null ? "Ave" : `${new URL(url).origin} · Ave`} · ${t(`browserWorkspace.mode.${tab.mode}`)} · ${popup.title}`);
  }
}

// The caller must first verify the native child's session and owning main window.
export function registerBrowserWorkspacePopup(openerGuestId: number, child: BrowserWindow, owner: MainWindow): string | null {
  if (child.isDestroyed() || owner.isDestroyed() || mainWindow(owner.id) !== owner) return null;
  const contents = child.webContents;
  if (contents.session !== session.fromPartition(AVE_SIDE_BROWSER_PARTITION)) return null;
  trackBrowserGuest(contents, owner.id);
  const handle = browserTabRegistry.registerPopup(openerGuestId, contents, {
    select: () => focusPopup(child), close: () => { if (!child.isDestroyed()) child.close(); },
  });
  if (handle === null) return null;
  const titleChanged = (event: { preventDefault(): void }, title: string) => {
    event.preventDefault();
    const popup = popups.get(handle);
    if (popup) popup.title = nativeTitle(title);
    refreshBrowserPopupControl(owner.id, browserTabRegistry.controlState(owner.id));
  };
  const contextMenu = (event: { preventDefault(): void }, params: PageContextMenuParams & { x: number; y: number }) => {
    event.preventDefault();
    const tab = browserTabRegistry.liveTabInWindow(handle, owner.id);
    if (child.isDestroyed() || !tab || tab.guest !== contents) return;
    const paused = tab.controlMode === "human-paused";
    const menu = Menu.buildFromTemplate([{
      label: t(paused ? "agentBrowser.resume" : "agentBrowser.stop"),
      enabled: paused || tab.controlMode === "agent-active",
      click: () => {
        const current = browserTabRegistry.liveTabInWindow(handle, owner.id);
        if (child.isDestroyed() || !current || current.guest !== contents) return;
        if (paused) browserTabRegistry.resumePopup(owner.id, handle);
        else browserTabRegistry.pausePopup(owner.id, handle);
        refreshBrowserPopupControl(owner.id, browserTabRegistry.controlState(owner.id));
      },
    }, { type: "separator" }, ...browserPageMenuItems(contents, owner.id, params, false)]);
    menu.popup({ window: child, x: params.x, y: params.y });
  };
  const navigated = () => refreshBrowserPopupControl(owner.id, browserTabRegistry.controlState(owner.id));
  const dispose = () => {
    contents.removeListener("did-navigate", navigated);
    child.removeListener("page-title-updated", titleChanged);
    contents.removeListener("context-menu", contextMenu);
    child.removeListener("closed", dispose);
    popups.delete(handle);
  };
  popups.set(handle, { window: child, owner, title: nativeTitle(contents.getTitle()), dispose });
  child.on("page-title-updated", titleChanged);
  contents.on("did-navigate", navigated);
  contents.on("context-menu", contextMenu);
  child.once("closed", dispose);
  refreshBrowserPopupControl(owner.id, browserTabRegistry.controlState(owner.id));
  return handle;
}

// Shutdown owns disposal; no renderer event can invoke it.
export function disposeBrowserWorkspaceService(): void {
  for (const window of [...windows.values()]) window.dispose();
  for (const popup of [...popups.values()]) popup.dispose();
  service?.dispose();
  service = null;
}
