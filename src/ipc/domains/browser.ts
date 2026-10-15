/**
 * Browser-tab and active-surface IPC — the renderer's half of the main-side
 * browser tab registry (main/browser/browser-tab-registry.ts).
 *
 * Channels (ALL INTERNAL — never in PUBLIC_CHANNELS / EXTERNAL_MUTATION_CHANNELS):
 *   `ave:browser:bind-tab`    invoke  renderer→main  tab id ↔ guest webContents id
 *   `ave:browser:stop`        invoke  renderer→main  badge stop on an agent tab
 *   `ave:browser:tab-op`      event   main→renderer  new / select / close a tab
 *   `ave:browser:control`     event   main→renderer  the window's agent-controlled tabs
 *   `ave:surface:set-active`  invoke  renderer→main  the window's active browser/terminal tab
 *
 * TRUST BOUNDARY: a bind decides which page the agent's browser tools reach,
 * so every invoke gates on {@link validateHostRendererSender} and acts only on
 * the sender's own main window; the registry additionally accepts a bind only
 * for a guest that attached to that same window.
 *
 * Error contract: kebab-case English `error`.
 */
import { ipcMain } from "electron";
import { CHANNELS } from "../../contract/app-contract.js";
import { validateHostRendererSender, auditUnauthorized } from "../gated.js";
import { sendToWindow } from "../safe-send.js";
import { createLogger } from "../../lib/logger.js";
import { getMainWindows, mainWindowForContents } from "../../main/app-state.js";
import { browserTabRegistry } from "../../main/browser/browser-tab-registry.js";
import type {
  BrowserTabStopRequest,
  ActiveWorkspaceSurface,
  BrowserTabBindResult,
} from "../../shared/browser-surface.js";
import type { IpcDeps } from "../types.js";

const log = createLogger("browser-ipc");

const MAX_TAB_ID_LENGTH = 200;

function asTabId(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_TAB_ID_LENGTH ? value : null;
}

/** Parse an `ave:surface:set-active` payload; `undefined` = malformed. */
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

  browserTabRegistry.setRendererLink({
    sendTabOp: (windowId, request) => {
      const win = getMainWindows().find((candidate) => candidate.id === windowId);
      return sendToWindow(win, CHANNELS.browser.tabOp, request, log);
    },
    sendControl: (windowId, state) => {
      const win = getMainWindows().find((candidate) => candidate.id === windowId);
      sendToWindow(win, CHANNELS.browser.control, state, log);
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
