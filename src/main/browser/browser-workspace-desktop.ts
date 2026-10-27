import { dialog, Menu, session, type BrowserWindow, type DownloadItem, type WebContents } from "electron";
import { t } from "../../i18n/index.js";
import { createLogger } from "../../lib/logger.js";
import type { BrowserTabControlState } from "../../shared/browser-surface.js";
import { AVE_SIDE_BROWSER_PARTITION } from "../../shared/side-browser.js";
import { getMainWindows } from "../app-state.js";
import { observeAgentBrowserDownload } from "../browser-observation.js";
import { trackBrowserGuest } from "./browser-guest-tracking.js";
import { browserTabRegistry } from "./browser-tab-registry.js";
import { createBrowserWorkspaceService, type BrowserWorkspaceService } from "./browser-workspace.js";

const log = createLogger("browser-workspace-desktop");
const FOCUS_TIMEOUT_MS = 750;
const guests = new Map<number, { contents: WebContents; owner: BrowserWindow; dispose(): void }>();
const windows = new Map<number, { owner: BrowserWindow; dispose(): void }>();
const popups = new Map<string, { window: BrowserWindow; owner: BrowserWindow; title: string; dispose(): void }>();
let service: BrowserWorkspaceService | null = null;

function mainWindow(windowId: number): BrowserWindow | undefined {
  return getMainWindows().find((window) => window.id === windowId && !window.isDestroyed());
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
    promptPermission: async (request) => {
      const window = mainWindow(request.windowId);
      if (!window || !window.isVisible() || window.isMinimized()) return false;
      const result = await dialog.showMessageBox(window, {
        type: "question", title: t("browserWorkspace.permissionPrompt.title"),
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
  return entry?.contents === contents && mainWindow(entry.owner.id) === entry.owner ? entry.owner.id : null;
}

export function observeBrowserWorkspaceGuest(contents: WebContents, owner: BrowserWindow): void {
  if (contents.isDestroyed() || mainWindow(owner.id) !== owner
    || contents.session !== session.fromPartition(AVE_SIDE_BROWSER_PARTITION)) throw new Error("browser-guest-owner-mismatch");
  const existing = guests.get(contents.id);
  if (existing) {
    if (existing.contents !== contents || existing.owner !== owner) throw new Error("browser-guest-owner-mismatch");
    return;
  }
  if (!windows.has(owner.id)) {
    const invalidate = () => service?.invalidateWindow(owner.id);
    const dispose = () => {
      owner.removeListener("hide", invalidate);
      owner.removeListener("minimize", invalidate);
      owner.removeListener("closed", dispose);
      service?.disposeWindow(owner.id);
      for (const entry of [...guests.values()]) if (entry.owner === owner) entry.dispose();
      for (const popup of [...popups.values()]) if (popup.owner === owner) popup.dispose();
      windows.delete(owner.id);
    };
    windows.set(owner.id, { owner, dispose });
    owner.on("hide", invalidate);
    owner.on("minimize", invalidate);
    owner.once("closed", dispose);
  }
  const stopObserving = getBrowserWorkspaceService().observeGuest(owner.id, contents);
  const dispose = () => {
    contents.removeListener("destroyed", dispose);
    stopObserving();
    guests.delete(contents.id);
  };
  guests.set(contents.id, { contents, owner, dispose });
  contents.once("destroyed", dispose);
}

// Called only after the existing native Save/rate policy admits the download.
export function observeBrowserWorkspaceDownload(contents: WebContents, item: DownloadItem): void {
  const windowId = browserWorkspaceGuestWindowId(contents);
  if (windowId !== null) {
    getBrowserWorkspaceService().observeDownload(windowId, item);
    observeAgentBrowserDownload(contents, item);
  }
}

function focusPopup(window: BrowserWindow): Promise<boolean> {
  if (window.isDestroyed()) return Promise.resolve(false);
  const contents = window.webContents;
  if (contents.isDestroyed()) return Promise.resolve(false);
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = (focused: boolean) => {
      if (timer !== undefined) clearTimeout(timer);
      window.removeListener("focus", inspect);
      window.removeListener("closed", closed);
      contents.removeListener("focus", inspect);
      contents.removeListener("destroyed", closed);
      resolve(focused);
    };
    const inspect = () => {
      if (!window.isDestroyed() && !contents.isDestroyed() && window.isFocused() && contents.isFocused()) settle(true);
    };
    const closed = () => settle(false);
    window.on("focus", inspect);
    window.once("closed", closed);
    contents.on("focus", inspect);
    contents.once("destroyed", closed);
    timer = setTimeout(() => settle(false), FOCUS_TIMEOUT_MS);
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
    if (popup.owner.id !== windowId || popup.window.isDestroyed()) continue;
    const tab = state.tabs.find((candidate) => candidate.tabId === handle && candidate.kind === "popup");
    if (!tab) continue;
    popup.window.setTitle(`Ave · ${t(`browserWorkspace.mode.${tab.mode}`)} · ${popup.title}`);
  }
}

// The caller must first verify the native child's session and owning main window.
export function registerBrowserWorkspacePopup(openerGuestId: number, child: BrowserWindow, owner: BrowserWindow): string | null {
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
  const contextMenu = (event: { preventDefault(): void }, params: { x: number; y: number }) => {
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
    }]);
    menu.popup({ window: child, x: params.x, y: params.y });
  };
  const dispose = () => {
    child.removeListener("page-title-updated", titleChanged);
    contents.removeListener("context-menu", contextMenu);
    child.removeListener("closed", dispose);
    popups.delete(handle);
  };
  popups.set(handle, { window: child, owner, title: nativeTitle(contents.getTitle()), dispose });
  child.on("page-title-updated", titleChanged);
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
