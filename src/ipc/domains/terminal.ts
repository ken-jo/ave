import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from "electron";
import { CHANNELS } from "../../contract/app-contract.js";
import { validateHostRendererSender, UNAUTHORIZED_FRAME, auditUnauthorized } from "../gated.js";
import { fanOutToAllWindows } from "../window-fanout.js";
import { createLogger } from "../../lib/logger.js";
import {
  setTerminalEmitter, spawnTerminal, writeTerminal, resizeTerminal, killTerminal,
  terminalOwnedBy,
} from "../../main/terminal/pty-manager.js";
import { getWindowTerminalBlockTracker, getWindowTerminalBlockSession, listTerminalBlockTabs } from "../../main/terminal/terminal-blocks.js";
import { isTerminalSessionRef } from "../../shared/terminal-session.js";
import type { IpcDeps } from "../types.js";
import { updateApprovalSurface } from "../../permissions/approval-surface-registry.js";

const log = createLogger("terminal-ipc");

export function registerTerminalHandlers(deps: IpcDeps): void {
  const { auditLogger } = deps;
  setTerminalEmitter((event, payload, ownerWindowId) => {
    if (payload.lane !== "manual") return;
    const channel = event === "data" ? CHANNELS.terminal.data : CHANNELS.terminal.exit;
    const windows = deps.getAppWindows?.() ?? [deps.getMainWindow()];
    const targets = ownerWindowId === null ? windows : windows.filter((win) => win && !win.isDestroyed() && win.id === ownerWindowId);
    fanOutToAllWindows(targets, channel, payload, { logger: log });
  });
  const senderWindowId = (event: IpcMainInvokeEvent): number | null => {
    const window = BrowserWindow.fromWebContents(event.sender);
    return window && !window.isDestroyed() ? window.id : null;
  };
  const authorized = (event: IpcMainInvokeEvent, channel: string): boolean => {
    if (validateHostRendererSender(event)) return true;
    auditUnauthorized(auditLogger, channel, event);
    return false;
  };

  ipcMain.handle(CHANNELS.terminal.spawn, async (event, payload) => {
    if (!authorized(event, CHANNELS.terminal.spawn)) return { ok: false, reason: "unauthorized-frame", message: "sender frame is not authorized" };
    if (!payload || typeof payload.tabId !== "string" || payload.lane !== "manual"
      || (payload.cwd !== undefined && typeof payload.cwd !== "string")
      || (payload.cols !== undefined && (typeof payload.cols !== "number" || !Number.isFinite(payload.cols)))
      || (payload.rows !== undefined && (typeof payload.rows !== "number" || !Number.isFinite(payload.rows)))) {
      return { ok: false, reason: "bad-request", message: "invalid terminal spawn request" };
    }
    const ownerWindowId = senderWindowId(event);
    if (ownerWindowId === null) return { ok: false, reason: "unauthorized-frame", message: "sender has no app window" };
    const owner = (deps.getAppWindows?.() ?? [deps.getMainWindow()]).find((window) =>
      window && !window.isDestroyed() && window.id === ownerWindowId && window.webContents === event.sender);
    if (!owner || event.sender.isDestroyed() || event.senderFrame !== event.sender.mainFrame) {
      auditUnauthorized(auditLogger, CHANNELS.terminal.spawn, event);
      return { ok: false, reason: "unauthorized-frame", message: "sender is not an app window main frame" };
    }
    if (!terminalOwnedBy(payload.tabId, ownerWindowId)) return { ok: false, reason: "not-owner", message: "terminal belongs to another window" };
    updateApprovalSurface({ kind: "attach-terminal", tabId: payload.tabId, surface: event.sender });
    return spawnTerminal({ tabId: payload.tabId, lane: payload.lane, ownerWindowId,
      ...(payload.cwd !== undefined ? { cwd: payload.cwd } : {}),
      ...(payload.cols !== undefined ? { cols: payload.cols } : {}),
      ...(payload.rows !== undefined ? { rows: payload.rows } : {}),
    });
  });

  for (const operation of ["input", "resize"] as const) {
    ipcMain.handle(CHANNELS.terminal[operation], async (event, payload) => {
      if (!authorized(event, CHANNELS.terminal[operation])) return { ok: false, error: UNAUTHORIZED_FRAME.error };
      if (!isTerminalSessionRef(payload) || payload.lane !== "manual") return { ok: false, error: "invalid-params" };
      if (!terminalOwnedBy(payload.tabId, senderWindowId(event))) return { ok: false, error: "not-owner" };
      if (operation === "input") {
        if (!("data" in payload) || typeof payload.data !== "string") return { ok: false, error: "invalid-params" };
        return writeTerminal(payload, payload.data);
      }
      if (!("cols" in payload) || !("rows" in payload) || typeof payload.cols !== "number" || !Number.isFinite(payload.cols) || typeof payload.rows !== "number" || !Number.isFinite(payload.rows)) return { ok: false, error: "invalid-params" };
      return resizeTerminal(payload, payload.cols, payload.rows);
    });
  }
  ipcMain.handle(CHANNELS.terminal.kill, async (event, payload) => {
    if (!authorized(event, CHANNELS.terminal.kill)) return { ok: false, error: UNAUTHORIZED_FRAME.error };
    if (!payload || typeof payload.tabId !== "string" || !payload.tabId || (payload.lane !== undefined && payload.lane !== "manual")) return { ok: false, error: "invalid-params" };
    if (!terminalOwnedBy(payload.tabId, senderWindowId(event))) return { ok: false, error: "not-owner" };
    killTerminal(payload.tabId);
    return { ok: true };
  });
  ipcMain.handle(CHANNELS.terminal.preview, async (event, payload) => {
    if (!authorized(event, CHANNELS.terminal.preview)) return { ok: false, error: UNAUTHORIZED_FRAME.error };
    if (event.sender.isDestroyed() || event.senderFrame !== event.sender.mainFrame) {
      auditUnauthorized(auditLogger, CHANNELS.terminal.preview, event);
      return { ok: false, error: UNAUTHORIZED_FRAME.error };
    }
    if (!payload || typeof payload.tabId !== "string" || !payload.tabId || Object.keys(payload).some((key) => key !== "tabId")) return { ok: false, error: "invalid-params" };
    const ownerWindowId = senderWindowId(event);
    if (ownerWindowId === null || !terminalOwnedBy(payload.tabId, ownerWindowId)) return { ok: false, error: "not-owner" };
    const entry = listTerminalBlockTabs(ownerWindowId).find(({ session }) => session.tabId === payload.tabId && session.lane === "manual");
    const command = entry?.tracker.list().find((block) => block.source === "osc133" && block.command.trim())?.command ?? null;
    return { ok: true, command };
  });
  for (const operation of ["blocks", "block"] as const) {
    ipcMain.handle(CHANNELS.terminal[operation], async (event, payload) => {
      if (!authorized(event, CHANNELS.terminal[operation])) return { ok: false, error: UNAUTHORIZED_FRAME.error };
      if (!isTerminalSessionRef(payload) || payload.lane !== "manual") return { ok: false, error: "invalid-params" };
      const ownerWindowId = senderWindowId(event);
      if (ownerWindowId === null || !terminalOwnedBy(payload.tabId, ownerWindowId)) return { ok: false, error: "not-owner" };
      const tracker = getWindowTerminalBlockTracker(payload, ownerWindowId);
      const session = getWindowTerminalBlockSession(payload, ownerWindowId);
      if (!tracker || !session) return { ok: false, error: "stale-terminal-session" };
      if (operation === "blocks") return { ok: true, session, integrated: session.shellIntegration, blocks: tracker.list() };
      if (!("blockId" in payload) || typeof payload.blockId !== "number" || !Number.isInteger(payload.blockId) || payload.blockId < 1) return { ok: false, error: "invalid-params" };
      const block = tracker.get(payload.blockId);
      return block ? { ok: true, session, block } : { ok: false, error: "block-not-found" };
    });
  }
}
