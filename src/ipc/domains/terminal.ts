/**
 * Terminal domain IPC handlers (#1444) — interactive PTY terminal in the
 * workspace rail.
 *
 * Channels (ALL INTERNAL — never in PUBLIC_CHANNELS / EXTERNAL_MUTATION_CHANNELS):
 *   `ave:terminal:spawn`  invoke  renderer→main  → { ok, tabId, replayed } | { ok:false, reason, message }
 *   `ave:terminal:input`  invoke  keystrokes → pty stdin
 *   `ave:terminal:resize` invoke  cols/rows
 *   `ave:terminal:kill`   invoke  tab close / teardown
 *   `ave:terminal:data`   event   main→renderer  pty output chunk
 *   `ave:terminal:exit`   event   main→renderer  pty exited
 *   `ave:terminal:blocks` invoke  command-block summaries of one tab
 *   `ave:terminal:block`  invoke  one command block with its output
 *
 * TRUST BOUNDARY: a terminal spawns arbitrary user commands, so every invoke
 * gates on {@link validateHostRendererSender} — the HOST renderer frame only.
 * A plugin-ui-shell frame (also file://) is rejected there, and an external
 * origin (local-api / cli) can never reach these channels because they are
 * absent from PUBLIC_CHANNELS (fail-closed `isPublicChannel`). The confinement
 * itself (deny-by-default egress + filesystem jail) is enforced in the main
 * process by pty-manager via the ASRT sandbox; see pty-manager.ts.
 *
 * Error contract (project CLAUDE.md): kebab-case English `reason` / `error`.
 */
import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from "electron";
import { CHANNELS } from "../../contract/app-contract.js";
import { validateHostRendererSender, UNAUTHORIZED_FRAME, auditUnauthorized } from "../gated.js";
import { fanOutToAllWindows } from "../window-fanout.js";
import { createLogger } from "../../lib/logger.js";
import {
  setTerminalEmitter,
  spawnTerminal,
  writeTerminal,
  resizeTerminal,
  killTerminal,
  terminalOwnedBy,
  type SpawnTerminalResult,
} from "../../main/terminal/pty-manager.js";
import { getTerminalBlockTracker, getWindowTerminalBlockTracker } from "../../main/terminal/terminal-blocks.js";
import type { TerminalBlock, TerminalBlockSummary } from "../../shared/terminal-blocks.js";
import type { IpcDeps } from "../types.js";

const log = createLogger("terminal-ipc");

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : NaN;
}

/** A window reads only its own terminals' blocks; a windowless caller reads any. */
function blockTrackerFor(tabId: string, windowId: number | null) {
  return windowId === null ? getTerminalBlockTracker(tabId) : getWindowTerminalBlockTracker(tabId, windowId);
}

export function registerTerminalHandlers(deps: IpcDeps): void {
  const { auditLogger } = deps;

  // Wire the main→renderer output sink ONCE. pty-manager stays electron-free.
  // A terminal's output goes to the window that owns it, never to the others:
  // another window showing it would be a second view of one shell, and its
  // attention watcher would raise a second OS notice for the same alert. A
  // terminal no window owns (spawned windowless) goes to every app window.
  setTerminalEmitter((event, payload, ownerWindowId) => {
    const channel = event === "data" ? CHANNELS.terminal.data : CHANNELS.terminal.exit;
    const windows = deps.getAppWindows?.() ?? [deps.getMainWindow()];
    const targets = ownerWindowId === null
      ? windows
      : windows.filter((win) => win !== null && win !== undefined && !win.isDestroyed() && win.id === ownerWindowId);
    fanOutToAllWindows(targets, channel, payload, { logger: log });
  });

  /** The app window an IPC call came from, as terminal ownership names it. */
  const senderWindowId = (e: IpcMainInvokeEvent): number | null => {
    const owner = BrowserWindow.fromWebContents(e.sender);
    return owner && !owner.isDestroyed() ? owner.id : null;
  };

  ipcMain.handle(
    CHANNELS.terminal.spawn,
    async (
      e,
      payload: { tabId?: unknown; cwd?: unknown; cols?: unknown; rows?: unknown },
    ): Promise<SpawnTerminalResult | { ok: false; reason: "unauthorized-frame"; message: string }> => {
      if (!validateHostRendererSender(e)) {
        auditUnauthorized(auditLogger, CHANNELS.terminal.spawn, e);
        return { ok: false, reason: "unauthorized-frame", message: "sender frame is not authorized" };
      }
      const tabId = asString(payload?.tabId);
      if (!tabId) {
        return { ok: false, reason: "bad-request", message: "tabId must be a non-empty string" };
      }
      return spawnTerminal({
        tabId,
        ownerWindowId: senderWindowId(e),
        ...(typeof payload?.cwd === "string" ? { cwd: payload.cwd } : {}),
        ...(typeof payload?.cols === "number" ? { cols: payload.cols } : {}),
        ...(typeof payload?.rows === "number" ? { rows: payload.rows } : {}),
      });
    },
  );

  ipcMain.handle(
    CHANNELS.terminal.input,
    async (
      e,
      payload: { tabId?: unknown; data?: unknown },
    ): Promise<{ ok: true } | { ok: false; error: string }> => {
      if (!validateHostRendererSender(e)) {
        auditUnauthorized(auditLogger, CHANNELS.terminal.input, e);
        return { ok: false, error: UNAUTHORIZED_FRAME.error };
      }
      const tabId = asString(payload?.tabId);
      const data = asString(payload?.data);
      if (!tabId) return { ok: false, error: "invalid-params" };
      if (!terminalOwnedBy(tabId, senderWindowId(e))) return { ok: false, error: "not-owner" };
      writeTerminal(tabId, data);
      return { ok: true };
    },
  );

  ipcMain.handle(
    CHANNELS.terminal.resize,
    async (
      e,
      payload: { tabId?: unknown; cols?: unknown; rows?: unknown },
    ): Promise<{ ok: true } | { ok: false; error: string }> => {
      if (!validateHostRendererSender(e)) {
        auditUnauthorized(auditLogger, CHANNELS.terminal.resize, e);
        return { ok: false, error: UNAUTHORIZED_FRAME.error };
      }
      const tabId = asString(payload?.tabId);
      if (!tabId) return { ok: false, error: "invalid-params" };
      if (!terminalOwnedBy(tabId, senderWindowId(e))) return { ok: false, error: "not-owner" };
      resizeTerminal(tabId, asNumber(payload?.cols), asNumber(payload?.rows));
      return { ok: true };
    },
  );

  ipcMain.handle(
    CHANNELS.terminal.kill,
    async (
      e,
      payload: { tabId?: unknown },
    ): Promise<{ ok: true } | { ok: false; error: string }> => {
      if (!validateHostRendererSender(e)) {
        auditUnauthorized(auditLogger, CHANNELS.terminal.kill, e);
        return { ok: false, error: UNAUTHORIZED_FRAME.error };
      }
      const tabId = asString(payload?.tabId);
      if (!tabId) return { ok: false, error: "invalid-params" };
      if (!terminalOwnedBy(tabId, senderWindowId(e))) return { ok: false, error: "not-owner" };
      killTerminal(tabId);
      return { ok: true };
    },
  );

  // Command blocks (terminal-blocks.ts). Reads only: the renderer lists a tab's
  // blocks and fetches one block's output to copy it or attach it to chat. A
  // tab with no live shell record answers an empty list, not an error — the
  // tab may simply not have spawned yet.
  ipcMain.handle(
    CHANNELS.terminal.blocks,
    async (
      e,
      payload: { tabId?: unknown },
    ): Promise<
      | { ok: true; integrated: boolean; blocks: TerminalBlockSummary[] }
      | { ok: false; error: string }
    > => {
      if (!validateHostRendererSender(e)) {
        auditUnauthorized(auditLogger, CHANNELS.terminal.blocks, e);
        return { ok: false, error: UNAUTHORIZED_FRAME.error };
      }
      const tabId = asString(payload?.tabId);
      if (!tabId) return { ok: false, error: "invalid-params" };
      const tracker = blockTrackerFor(tabId, senderWindowId(e));
      if (!tracker) return { ok: true, integrated: false, blocks: [] };
      return { ok: true, integrated: tracker.isIntegrated(), blocks: tracker.list() };
    },
  );

  ipcMain.handle(
    CHANNELS.terminal.block,
    async (
      e,
      payload: { tabId?: unknown; blockId?: unknown },
    ): Promise<{ ok: true; block: TerminalBlock } | { ok: false; error: string }> => {
      if (!validateHostRendererSender(e)) {
        auditUnauthorized(auditLogger, CHANNELS.terminal.block, e);
        return { ok: false, error: UNAUTHORIZED_FRAME.error };
      }
      const tabId = asString(payload?.tabId);
      const blockId = asNumber(payload?.blockId);
      if (!tabId || !Number.isInteger(blockId)) return { ok: false, error: "invalid-params" };
      const block = blockTrackerFor(tabId, senderWindowId(e))?.get(blockId) ?? null;
      if (!block) return { ok: false, error: "block-not-found" };
      return { ok: true, block };
    },
  );
}
