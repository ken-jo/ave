// Browser bindings require a host renderer and a guest attached to that sender's own main window.
import { ipcMain } from "electron";
import { CHANNELS } from "../../contract/app-contract.js";
import { validateHostRendererSender, auditUnauthorized } from "../gated.js";
import { sendToWindow } from "../safe-send.js";
import { createLogger } from "../../lib/logger.js";
import { getMainWindows, getPrimaryMainWindow, mainWindowForContents } from "../../main/app-state.js";
import { browserTabRegistry } from "../../main/browser/browser-tab-registry.js";
import { disposeBrowserWorkspaceService, getBrowserWorkspaceService, refreshBrowserPopupControl } from "../../main/browser/browser-workspace-desktop.js";
import { registerShutdownHook } from "../../main/app-shutdown.js";
import { registerBrowserWorkspaceHandlers } from "./browser-workspace.js";
import { BrowserNativeSurfaceHost } from "../../main/browser/browser-native-surfaces.js";
import { attachSideBrowserWebview } from "../../main/side-browser-webview.js";
import { trackBrowserGuest } from "../../main/browser/browser-guest-tracking.js";
import { parseBrowserNativeSurfaceRequest, type BrowserNativeSurfaceResult } from "../../shared/browser-native-surface.js";
import type {
  BrowserTabStopRequest,
  ActiveWorkspaceSurface,
  BrowserTabBindResult,
} from "../../shared/browser-surface.js";
import type { IpcDeps } from "../types.js";

const log = createLogger("browser-ipc");

const MAX_TAB_ID_LENGTH = 200;
let cleanupRegistered = false;
let nativeSurfaces: BrowserNativeSurfaceHost | undefined;

function asTabId(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_TAB_ID_LENGTH ? value : null;
}

export function parseActiveSurface(value: unknown): ActiveWorkspaceSurface | null | undefined {
  if (value === null) return null;
  if (typeof value !== "object") return undefined;
  const record = value as { kind?: unknown; tabId?: unknown };
  const tabId = asTabId(record.tabId);
  if ((record.kind !== "browser" && record.kind !== "terminal") || tabId === null) return undefined;
  return { kind: record.kind, tabId };
}

export function registerBrowserHandlers(deps: IpcDeps): void {
  const { auditLogger } = deps;
  if (!cleanupRegistered) {
    registerShutdownHook("browser-workspace", disposeBrowserWorkspaceService);
    registerShutdownHook("browser-native-surfaces", () => nativeSurfaces?.dispose());
    cleanupRegistered = true;
  }
  registerBrowserWorkspaceHandlers(deps, getBrowserWorkspaceService());
  nativeSurfaces ??= new BrowserNativeSurfaceHost({
    windowForId: (windowId) => getMainWindows().find(window => window.id === windowId && !window.isDestroyed()),
    authorizeCreate: (windowId, tabId, requestId) => browserTabRegistry.authorizeNativeSurface(windowId, tabId, requestId),
    attach: (contents, owner) => {
      trackBrowserGuest(contents, owner.id, { kind: "native-view" });
      attachSideBrowserWebview(contents, owner);
    },
    bind: (windowId, request) => browserTabRegistry.bindTab(windowId, request),
    changed: (windowId, surface, tabId) => {
      const owner = getMainWindows().find(window => window.id === windowId && !window.isDestroyed());
      sendToWindow(owner, CHANNELS.browser.nativeSurfaceChanged, { tabId, surface }, log);
    },
    userFocus: (guestId, explicit) => browserTabRegistry.userFocus(guestId, explicit),
    userNavigate: (windowId, tabId) => { browserTabRegistry.stop(windowId, tabId); },
  });

  ipcMain.handle(CHANNELS.browser.nativeSurface, (event, payload: unknown): Promise<BrowserNativeSurfaceResult> | BrowserNativeSurfaceResult => {
    if (!validateHostRendererSender(event)) {
      auditUnauthorized(auditLogger, CHANNELS.browser.nativeSurface, event);
      return { ok: false, error: "unauthorized-frame" };
    }
    const owner = mainWindowForContents(event.sender);
    const request = parseBrowserNativeSurfaceRequest(payload);
    if (!owner || !request) return { ok: false, error: "bad-request" };
    return nativeSurfaces!.request(owner.id, request);
  });

  browserTabRegistry.setBindingPersistence({
    savedWindowId: () => getPrimaryMainWindow()?.id,
    load: (windowId) => getPrimaryMainWindow()?.id === windowId ? deps.settingsService.get("system").mainLayout : undefined,
    save: async (windowId, layout) => {
      if (getPrimaryMainWindow()?.id !== windowId) return;
      await deps.settingsService.patch({ system: { ...deps.settingsService.get("system"), mainLayout: layout } });
    },
    sessionExists: (sessionId) => [deps.memoryManager, deps.sideChatMemoryManager]
      .some((store) => store?.sessions.hasSessionTranscript(sessionId))
      || (deps.getSubAgentRunner?.()?.hasPersistedSession(sessionId) ?? false),
    legacyPaneSession: (tabId) => deps.sideChatMemoryManager?.sessions.findPaneSession(tabId),
  });

  browserTabRegistry.setRendererLink({
    isWindowFocused: (windowId) => getMainWindows().some(window => window.id === windowId && !window.isDestroyed() && window.isFocused()),
    isWindowVisible: (windowId) => {
      const window = getMainWindows().find((candidate) => candidate.id === windowId);
      return window !== undefined && !window.isDestroyed() && window.isVisible() && !window.isMinimized();
    },
    sendTabOp: (windowId, request) => {
      const win = getMainWindows().find((candidate) => candidate.id === windowId);
      return sendToWindow(win, CHANNELS.browser.tabOp, request, log);
    },
    sendControl: (windowId, state) => {
      refreshBrowserPopupControl(windowId, state);
      const win = getMainWindows().find((candidate) => candidate.id === windowId);
      sendToWindow(win, CHANNELS.browser.control, state, log);
    },
    sendSessionBindings: (windowId, state) => {
      const win = getMainWindows().find((candidate) => candidate.id === windowId);
      sendToWindow(win, CHANNELS.browser.sessionBindingsChanged, state, log);
    },
  });

  ipcMain.handle(CHANNELS.browser.bindTab, (e, payload: unknown): BrowserTabBindResult => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, CHANNELS.browser.bindTab, e);
      return { ok: false, error: "unauthorized-frame" };
    }
    const win = mainWindowForContents(e.sender);
    const record = (payload ?? {}) as { tabId?: unknown; webContentsId?: unknown; requestId?: unknown; parked?: unknown };
    const tabId = asTabId(record.tabId);
    const webContentsId = record.webContentsId;
    if (
      !win
      || tabId === null
      || typeof webContentsId !== "number"
      || !Number.isInteger(webContentsId)
      || (record.requestId !== undefined && typeof record.requestId !== "string")
      || (record.parked !== undefined && typeof record.parked !== "boolean")
    ) {
      return { ok: false, error: "bad-request" };
    }
    if (browserTabRegistry.isIndependentGuest(webContentsId)) return { ok: false, error: "guest-not-hosted" };
    return browserTabRegistry.bindTab(win.id, {
      tabId,
      webContentsId,
      ...(typeof record.requestId === "string" ? { requestId: record.requestId } : {}),
      ...(typeof record.parked === "boolean" ? { parked: record.parked } : {}),
    });
  });

  ipcMain.handle(CHANNELS.browser.completeFocus, (e, payload: unknown): { ok: boolean } => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, CHANNELS.browser.completeFocus, e);
      return { ok: false };
    }
    const win = mainWindowForContents(e.sender);
    const record = payload as { requestId?: unknown; restored?: unknown } | null;
    if (!win || typeof record?.requestId !== "string" || typeof record.restored !== "boolean") return { ok: false };
    return { ok: browserTabRegistry.completeFocus(win.id, record.requestId, record.restored) };
  });

  ipcMain.handle(CHANNELS.browser.refuseTabOp, (e, payload: unknown): { ok: boolean } => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, CHANNELS.browser.refuseTabOp, e);
      return { ok: false };
    }
    const win = mainWindowForContents(e.sender);
    const requestId = (payload as { requestId?: unknown } | null)?.requestId;
    if (!win || typeof requestId !== "string" || requestId.length === 0) return { ok: false };
    return { ok: browserTabRegistry.refuseTabOp(win.id, requestId) };
  });

  ipcMain.handle(CHANNELS.browser.stop, (e, payload: unknown) => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, CHANNELS.browser.stop, e);
      return { ok: false, error: "unauthorized-frame" };
    }
    const win = mainWindowForContents(e.sender);
    const tabId = asTabId((payload as { [K in keyof BrowserTabStopRequest]?: unknown } | null)?.tabId);
    if (!win || tabId === null) return { ok: false, error: "bad-request" };
    return browserTabRegistry.stop(win.id, tabId) ? { ok: true } : { ok: false, error: "no-such-tab" };
  });

  ipcMain.handle(CHANNELS.browser.pause, (e, payload: unknown) => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, CHANNELS.browser.pause, e);
      return { ok: false, error: "unauthorized-frame" };
    }
    const win = mainWindowForContents(e.sender);
    const tabId = asTabId((payload as { tabId?: unknown } | null)?.tabId);
    if (!win || tabId === null) return { ok: false, error: "bad-request" };
    return browserTabRegistry.pause(win.id, tabId) ? { ok: true } : { ok: false, error: "no-such-tab" };
  });

  ipcMain.handle(CHANNELS.browser.resume, (e, payload: unknown) => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, CHANNELS.browser.resume, e);
      return { ok: false, error: "unauthorized-frame" };
    }
    const win = mainWindowForContents(e.sender);
    const tabId = asTabId((payload as { tabId?: unknown } | null)?.tabId);
    if (!win || tabId === null) return { ok: false, error: "bad-request" };
    return browserTabRegistry.resume(win.id, tabId) ? { ok: true } : { ok: false, error: "not-resumable" };
  });

  ipcMain.handle(CHANNELS.browser.getState, (e, payload: unknown) => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, CHANNELS.browser.getState, e);
      return { ok: false, error: "unauthorized-frame" };
    }
    const win = mainWindowForContents(e.sender);
    if (!win || payload !== undefined) return { ok: false, error: "bad-request" };
    return browserTabRegistry.controlState(win.id);
  });

  ipcMain.handle(CHANNELS.browser.getSessionBindings, (e, payload: unknown) => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, CHANNELS.browser.getSessionBindings, e);
      return { ok: false, error: "unauthorized-frame" };
    }
    const win = mainWindowForContents(e.sender);
    if (!win || payload !== undefined) return { ok: false, error: "bad-request" };
    return browserTabRegistry.sessionBindingsState(win.id);
  });

  ipcMain.handle(CHANNELS.surface.setActive, (e, payload: unknown) => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, CHANNELS.surface.setActive, e);
      return { ok: false, error: "unauthorized-frame" };
    }
    const win = mainWindowForContents(e.sender);
    const surface = parseActiveSurface(payload);
    if (!win || surface === undefined) return { ok: false, error: "bad-request" };
    browserTabRegistry.setActiveSurface(win.id, surface);
    return { ok: true };
  });
}
