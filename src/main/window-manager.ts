// Resize the requesting main window with its own tween; auxiliary preview, link, and auth windows manage themselves.

import { BrowserWindow, ipcMain, screen, type IpcMainInvokeEvent } from "electron";
import { auditUnauthorized, UNAUTHORIZED_FRAME } from "../ipc-bridge.js";
import { validateHostRendererSender } from "../ipc/gated.js";
import { CHANNELS } from "../contract/app-contract.js";
import type { AuditLogger } from "../audit/audit-logger.js";
import { getMainWindows } from "./app-state.js";
import {
  computeChatModeSidePanelBounds,
  computeInitialMainWindowBounds,
  computeWorkModeBounds,
} from "./main-window-bounds.js";

// The live main window whose renderer sent `event`, or null for any other sender.
function senderMainWindow(event: IpcMainInvokeEvent): BrowserWindow | null {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed()) return null;
  return getMainWindows().includes(win) ? win : null;
}

export class WindowManager {
  // Active resize tween per window id. At most one tween runs per window — a new tween cancels that window's in-flight one so rapid chat↔work toggling
  // does not overlap animations; the latest target always wins and lands exactly.
  private readonly _resizeTweens = new Map<number, ReturnType<typeof setInterval>>();

  private cancelTween(windowId: number): void {
    const tween = this._resizeTweens.get(windowId);
    if (tween === undefined) return;
    clearInterval(tween);
    this._resizeTweens.delete(windowId);
  }

  // Native animate=true works only on macOS; use one cancellable per-window tween and snap to exact final bounds.
  animateBoundsTo(
    win: BrowserWindow,
    target: { x: number; y: number; width: number; height: number },
    opts: { durationMs?: number } = {},
  ): void {
    const durationMs = opts.durationMs ?? 220;

    if (win.isDestroyed()) return;
    const windowId = win.id;
    // Cancel this window's in-flight tween — latest target wins.
    this.cancelTween(windowId);

    const start = win.getBounds();
    const sameTarget =
      start.x === target.x &&
      start.y === target.y &&
      start.width === target.width &&
      start.height === target.height;
    if (sameTarget || durationMs <= 0) {
      win.setBounds(target, false);
      return;
    }

    const frameMs = 16; // ≈60fps
    const startedAt = Date.now();
    // easeOutCubic: fast start, gentle settle.
    const ease = (t: number): number => 1 - Math.pow(1 - t, 3);

    this._resizeTweens.set(windowId, setInterval(() => {
      if (win.isDestroyed()) {
        this.cancelTween(windowId);
        return;
      }

      const elapsed = Date.now() - startedAt;
      const linear = Math.min(1, elapsed / durationMs);

      if (linear >= 1) {
        // Final step — snap to the EXACT target, never an interpolated value.
        this.cancelTween(windowId);
        win.setBounds(target, false);
        return;
      }

      const k = ease(linear);
      win.setBounds(
        {
          x: Math.round(start.x + (target.x - start.x) * k),
          y: Math.round(start.y + (target.y - start.y) * k),
          width: Math.round(start.width + (target.width - start.width) * k),
          height: Math.round(start.height + (target.height - start.height) * k),
        },
        false,
      );
    }, frameMs));
  }

  registerIpc(auditLogger: AuditLogger): void {
    // Resize only the requesting trusted host renderer’s main window; enforce the host sender guard on this mutating channel.
    ipcMain.handle(CHANNELS.window.resizeForMode, (event: IpcMainInvokeEvent, mode: unknown) => {
      if (!validateHostRendererSender(event)) {
        auditUnauthorized(auditLogger, CHANNELS.window.resizeForMode, event);
        return UNAUTHORIZED_FRAME;
      }
      if (mode !== "chat" && mode !== "work") {
        return { ok: false, error: "invalid-mode" };
      }
      const main = senderMainWindow(event);
      if (!main) return { ok: false, error: "main-window-not-found" };

      const { workArea } = screen.getPrimaryDisplay();
      if (mode === "work") {
        // Manual easeOut tween (uniform on every platform). The native animate flag is macOS-only and is intentionally NOT passed anymore.
        this.animateBoundsTo(main, computeWorkModeBounds(workArea));
      } else {
        this.animateBoundsTo(main, computeInitialMainWindowBounds(workArea));
      }
      return { ok: true };
    });

    // Resize the sender's main window when the in-chat right-side work panel opens or closes. Work mode keeps the panel in normal flex layout and does not
    // call this channel; this is only for chat mode's narrower OS window.
    ipcMain.handle(CHANNELS.window.resizeForSidePanel, (event: IpcMainInvokeEvent, open: unknown) => {
      if (!validateHostRendererSender(event)) {
        auditUnauthorized(auditLogger, CHANNELS.window.resizeForSidePanel, event);
        return UNAUTHORIZED_FRAME;
      }
      if (typeof open !== "boolean") {
        return { ok: false, error: "invalid-open-state" };
      }
      const main = senderMainWindow(event);
      if (!main) return { ok: false, error: "main-window-not-found" };

      const { workArea } = screen.getPrimaryDisplay();
      this.animateBoundsTo(
        main,
        open
          ? computeChatModeSidePanelBounds(workArea)
          : computeInitialMainWindowBounds(workArea),
      );
      return { ok: true };
    });
  }
}
