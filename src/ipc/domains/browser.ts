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
import type {
  BrowserTabStopRequest,
  ActiveWorkspaceSurface,
  BrowserTabBindResult,
} from "../../shared/browser-surface.js";
import type { IpcDeps } from "../types.js";

const log = createLogger("browser-ipc");

const MAX_TAB_ID_LENGTH = 200;
let cleanupRegistered = false;

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
    cleanupRegistered = true;
  }
  registerBrowserWorkspaceHandlers(deps, getBrowserWorkspaceService());

  browserTabRegistry.setBindingPersistence({
    savedWindowId: () => getPrimaryMainWindow()?.id,
    load: (windowId) => getPrimaryMainWindow()?.id === windowId ? deps.settingsService.get("system").mainLayout : undefined,
    save: async (windowId, layout) => {
      if (getPrimaryMainWindow()?.id !== windowId) return;
      await deps.settingsService.patch({ system: { ...deps.settingsService.get("system"), mainLayout: layout } });
    },
    sessionExists: (sessionId) => [deps.memoryManager, deps.sideChatMemoryManager]
      .some((store) => store?.hasSessionTranscript(sessionId))
      || (deps.getSubAgentRunner?.()?.hasPersistedSession(sessionId) ?? false),
    legacyPaneSession: (tabId) => deps.sideChatMemoryManager?.findPaneSession(tabId),
  });

  browserTabRegistry.setRendererLink({
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
    const record = (payload ?? {}) as { tabId?: unknown; webContentsId?: unknown; requestId?: unknown };
    const tabId = asTabId(record.tabId);
    const webContentsId = record.webContentsId;
    if (
      !win
      || tabId === null
      || typeof webContentsId !== "number"
      || !Number.isInteger(webContentsId)
      || (record.requestId !== undefined && typeof record.requestId !== "string")
    ) {
      return { ok: false, error: "bad-request" };
    }
    return browserTabRegistry.bindTab(win.id, {
      tabId,
      webContentsId,
      ...(typeof record.requestId === "string" ? { requestId: record.requestId } : {}),
    });
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

  ipcMain.handle(CHANNELS.browser.pausePopup, (e, payload: unknown) => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, CHANNELS.browser.pausePopup, e);
      return { ok: false, error: "unauthorized-frame" };
    }
    const win = mainWindowForContents(e.sender);
    const tabId = asTabId((payload as { tabId?: unknown } | null)?.tabId);
    if (!win || tabId === null) return { ok: false, error: "bad-request" };
    return browserTabRegistry.pausePopup(win.id, tabId) ? { ok: true } : { ok: false, error: "no-such-tab" };
  });

  ipcMain.handle(CHANNELS.browser.resumePopup, (e, payload: unknown) => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, CHANNELS.browser.resumePopup, e);
      return { ok: false, error: "unauthorized-frame" };
    }
    const win = mainWindowForContents(e.sender);
    const tabId = asTabId((payload as { tabId?: unknown } | null)?.tabId);
    if (!win || tabId === null) return { ok: false, error: "bad-request" };
    return browserTabRegistry.resumePopup(win.id, tabId) ? { ok: true } : { ok: false, error: "not-resumable" };
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
