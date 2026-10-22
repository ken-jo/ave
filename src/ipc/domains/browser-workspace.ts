import { ipcMain, type IpcMainInvokeEvent } from "electron";
import { CHANNELS } from "../../contract/app-contract.js";
import { mainWindowForContents, getMainWindows } from "../../main/app-state.js";
import type { BrowserWorkspaceService } from "../../main/browser/browser-workspace.js";
import { BROWSER_WORKSPACE_ERRORS, parseBrowserWorkspaceRequest, type BrowserWorkspaceError, type BrowserWorkspaceRequests, type BrowserWorkspaceResult } from "../../shared/browser-workspace.js";
import { validateHostRendererSender, auditUnauthorized } from "../gated.js";
import { sendToWindow } from "../safe-send.js";
import type { IpcDeps } from "../types.js";
import { createLogger } from "../../lib/logger.js";

const log = createLogger("browser-workspace-ipc");
const ERRORS: ReadonlySet<string> = new Set(BROWSER_WORKSPACE_ERRORS);

export function registerBrowserWorkspaceHandlers(deps: IpcDeps, service: BrowserWorkspaceService): void {
  service.onChanged((windowId, state) => {
    sendToWindow(getMainWindows().find((window) => window.id === windowId), CHANNELS.browserWorkspace.changed, state, log);
  });
  function register<K extends keyof BrowserWorkspaceRequests>(operation: K, execute: (windowId: number, request: BrowserWorkspaceRequests[K]) => unknown | Promise<unknown>): void {
    const channel = CHANNELS.browserWorkspace[operation];
    ipcMain.handle(channel, async (event: IpcMainInvokeEvent, payload: unknown): Promise<BrowserWorkspaceResult<unknown>> => {
      if (!validateHostRendererSender(event)) { auditUnauthorized(deps.auditLogger, channel, event); return { ok: false, error: "unauthorized-frame" }; }
      const window = mainWindowForContents(event.sender);
      if (!window || window.isDestroyed()) return { ok: false, error: "unauthorized-frame" };
      const request = parseBrowserWorkspaceRequest(operation, payload);
      if (request === null) return { ok: false, error: "bad-request" };
      try { return { ok: true, value: await execute(window.id, request) }; }
      catch (error) {
        const code = error instanceof Error ? error.message : "";
        if (ERRORS.has(code)) return { ok: false, error: code as BrowserWorkspaceError };
        log.warn({ error, operation }, "browser workspace operation failed");
        throw error;
      }
    });
  }
  register("getState", (windowId) => service.getState(windowId));
  register("setBookmark", (windowId, request) => service.setBookmark(windowId, request));
  register("clearHistory", (windowId) => service.clearHistory(windowId));
  register("setSitePermission", (windowId, request) => service.setSitePermission(windowId, request));
  register("find", (windowId, request) => service.find(windowId, request));
  register("stopFind", (windowId, request) => service.stopFind(windowId, request));
  register("zoom", (windowId, request) => service.zoom(windowId, request));
  register("preview", (windowId, request) => service.preview(windowId, request));
}
