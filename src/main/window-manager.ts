/**
 * WindowManager — the main window's identity and its mode-driven bounds.
 *
 * This used to manage detached child BrowserWindows and a magnetic snap-to-edge
 * system for them. Detach is a retired feature: every view renders inline, and MCP-app
 * cards reach `fullscreen` and `pip` through in-renderer surfaces (see
 * `shared/mcp-app-display-mode.ts`). Nothing spawns a child window any more, so the
 * child registry, the snap geometry, and the per-window bounds persistence went with
 * the feature they served.
 *
 * What remains is the animated resizes the workspace mode and the chat side panel ask
 * for. Several main windows may be open (`app-state.ts` owns which), so each resize
 * acts on the main window whose renderer asked — never on "the" main window — and
 * each window has its own tween. Auxiliary HTML-preview, link, and auth windows own
 * themselves and do not route through here.
 */

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

/** The live main window whose renderer sent `event`, or null for any other sender. */
function senderMainWindow(event: IpcMainInvokeEvent): BrowserWindow | null {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed()) return null;
  return getMainWindows().includes(win) ? win : null;
}

export class WindowManager {
  /**
   * Active resize tween per window id. At most one tween runs per window — a new
   * tween cancels that window's in-flight one so rapid chat↔work toggling does not
   * overlap animations; the latest target always wins and lands exactly.
   */
  private readonly _resizeTweens = new Map<number, ReturnType<typeof setInterval>>();

  private cancelTween(windowId: number): void {
    const tween = this._resizeTweens.get(windowId);
    if (tween === undefined) return;
    clearInterval(tween);
    this._resizeTweens.delete(windowId);
  }

  /**
   * Smoothly animate a window to `target` bounds via a manual, cancellable
   * tween. Electron's `setBounds(bounds, animate=true)` flag is macOS-ONLY —
   * Windows/Linux ignore it and snap instantly. This interpolates x/y/width/
   * height with an easeOutCubic curve on a ~60fps interval so the resize is
   * smooth uniformly on every platform.
   *
   * Cancellation: the window's in-flight tween (`_resizeTweens`) is cleared before a new
   * one starts, so rapid chat↔work toggling never overlaps animations — the
   * latest target wins and still lands EXACTLY on `target` (the final step
   * snaps to the precise integer bounds rather than an interpolated value).
   */
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

  // ── IPC registration ──────────────────────────────────────────────────────

  registerIpc(auditLogger: AuditLogger): void {
    // Resize the sender's main window to match the active workspace mode.
    //   work → centered 1243×768 (golden ratio, clamped to the work area), the focused
    //          working canvas where inline views need room.
    //   chat → the right-docked initial bounds (the same ones the window boots with),
    //          computed from the primary work area.
    // State-mutating channel — validateHostRendererSender (rejects plugin UI shells),
    // mirroring the other host-only window IPCs.
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
        // Manual easeOut tween (uniform on every platform). The native animate
        // flag is macOS-only and is intentionally NOT passed anymore.
        this.animateBoundsTo(main, computeWorkModeBounds(workArea));
      } else {
        this.animateBoundsTo(main, computeInitialMainWindowBounds(workArea));
      }
      return { ok: true };
    });

    // Resize the sender's main window when the in-chat right-side work panel opens or
    // closes. Work mode keeps the panel in normal flex layout and does not call
    // this channel; this is only for chat mode's narrower OS window.
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
