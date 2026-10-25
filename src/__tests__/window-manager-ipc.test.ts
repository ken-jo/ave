/** State-mutating window handlers must reject and audit non-host senders; retired channels must remain absent. */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { IpcMainInvokeEvent } from "electron";

const handleMap = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();
const listenerMap = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();
const fromWebContents = vi.hoisted(() => vi.fn());

vi.mock("electron", () => ({
  BrowserWindow: {
    fromWebContents,
  },
  ipcMain: {
    handle: vi.fn((channel: string, fn: (e: IpcMainInvokeEvent, ...a: unknown[]) => unknown) => {
      handleMap.set(channel, fn);
    }),
    on: vi.fn((channel: string, fn: (e: IpcMainInvokeEvent, ...a: unknown[]) => unknown) => {
      listenerMap.set(channel, fn);
    }),
    removeListener: vi.fn((channel: string, fn: (e: IpcMainInvokeEvent, ...a: unknown[]) => unknown) => {
      if (listenerMap.get(channel) === fn) listenerMap.delete(channel);
    }),
  },
  screen: {
    getAllDisplays: vi.fn(() => []),
    getPrimaryDisplay: vi.fn(() => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } })),
  },
}));

import { UNAUTHORIZED_FRAME } from "../ipc-bridge.js";
import { CHAT_SIDE_PANEL_WIDTH } from "../main/main-window-bounds.js";
import { MAIN_WINDOW_WIDTH } from "../shared/shell-geometry.js";
import { hostFrameEvent } from "./test-helpers.js";

function unauthorizedEvent(): IpcMainInvokeEvent {
  return {
    senderFrame: { url: "https://evil.example.com/pwn" },
    sender: {},
  } as unknown as IpcMainInvokeEvent;
}

function makeAuditLogger() {
  return { log: vi.fn() };
}

describe("WindowManager IPC — validateSender guard", () => {
  let WindowManager: typeof import("../main/window-manager.js").WindowManager;
  let auditLogger: ReturnType<typeof makeAuditLogger>;
  let wm: InstanceType<typeof WindowManager>;
  let appState: typeof import("../main/app-state.js");

  beforeEach(async () => {
    handleMap.clear();
    listenerMap.clear();
    fromWebContents.mockReset();
    vi.resetModules();
    const mod = await import("../main/window-manager.js?t=" + Date.now());
    appState = await import("../main/app-state.js");
    appState.resetMainWindowsForTests();
    WindowManager = mod.WindowManager;
    auditLogger = makeAuditLogger();
    wm = new WindowManager();
    wm.registerIpc(auditLogger as never);
  });

  it.each([
    "ave:window:open-detached",
    "ave:window:close-detached",
    "ave:window:list-detached",
    "ave:window:close-all-detached",
    "ave:window:load-session-in-main",
    "ave:mcp:open-detached",
    "ave:mcp:close-detached",
    "ave:mcp:detached-payload",
  ])("registers no handler for the retired channel %s", (channel) => {
    // Retired detach channels must never regain live handlers.
    expect(handleMap.has(channel)).toBe(false);
  });

  describe("ave:window:resize-for-mode", () => {
    // Native animated bounds work only on macOS; flush the manual tween and assert its final target.
    let nextWindowId = 7;
    function makeMainWindow() {
      let bounds = { x: 0, y: 0, width: 100, height: 100 };
      return {
        id: nextWindowId++,
        on: vi.fn(),
        isDestroyed: vi.fn(() => false),
        getBounds: vi.fn(() => ({ ...bounds })),
        setBounds: vi.fn((b: { x: number; y: number; width: number; height: number }) => {
          bounds = { ...b };
        }),
        webContents: { send: vi.fn() },
      };
    }

    function useAsSender(main: ReturnType<typeof makeMainWindow>) {
      appState.registerMainWindow(main as never, appState.nextMainWindowRole());
      fromWebContents.mockReturnValue(main);
    }

    function flushTween() {
      vi.runAllTimers();
    }

    function lastBounds(main: ReturnType<typeof makeMainWindow>) {
      const calls = main.setBounds.mock.calls;
      return calls[calls.length - 1]?.[0] as {
        x: number; y: number; width: number; height: number;
      };
    }

    beforeEach(() => {
      // Fake timers make tween completion deterministic.
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.runOnlyPendingTimers();
      vi.useRealTimers();
    });

    it("returns UNAUTHORIZED_FRAME and audits for unauthorized sender", async () => {
      const handler = handleMap.get("ave:window:resize-for-mode")!;
      const result = await handler(unauthorizedEvent(), "work");
      expect(result).toEqual(UNAUTHORIZED_FRAME);
      expect(auditLogger.log).toHaveBeenCalledOnce();
    });

    it("rejects an invalid mode", async () => {
      const main = makeMainWindow();
      useAsSender(main);
      const handler = handleMap.get("ave:window:resize-for-mode")!;
      const result = await handler(hostFrameEvent(), "fullscreen");
      expect(result).toEqual({ ok: false, error: "invalid-mode" });
      expect(main.setBounds).not.toHaveBeenCalled();
    });

    it("returns main-window-not-found when the sender is not a registered main window", async () => {
      fromWebContents.mockReturnValue(makeMainWindow());
      const handler = handleMap.get("ave:window:resize-for-mode")!;
      const result = await handler(hostFrameEvent(), "work");
      expect(result).toEqual({ ok: false, error: "main-window-not-found" });
    });

    it("centers a 1243×768 window on the work area for work mode", async () => {
      const main = makeMainWindow();
      useAsSender(main);
      const handler = handleMap.get("ave:window:resize-for-mode")!;
      const result = await handler(hostFrameEvent(), "work");
      expect(result).toEqual({ ok: true });
      flushTween();
      expect(lastBounds(main)).toEqual({ x: 339, y: 156, width: 1243, height: 768 });
    });

    it("restores the right-docked initial bounds for chat mode", async () => {
      const main = makeMainWindow();
      useAsSender(main);
      const handler = handleMap.get("ave:window:resize-for-mode")!;
      const result = await handler(hostFrameEvent(), "chat");
      expect(result).toEqual({ ok: true });
      flushTween();
      const bounds = lastBounds(main);
      expect(bounds.width).toBeLessThan(800);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(1920);
    });

    it("resizes chat mode for the side panel and restores normal chat bounds when closed", async () => {
      const main = makeMainWindow();
      useAsSender(main);
      const handler = handleMap.get("ave:window:resize-for-side-panel")!;

      const openResult = await handler(hostFrameEvent(), true);
      expect(openResult).toEqual({ ok: true });
      flushTween();
      const expanded = lastBounds(main);
      expect(expanded.width).toBe(MAIN_WINDOW_WIDTH + CHAT_SIDE_PANEL_WIDTH);
      expect(expanded.height).toBe(840);
      expect(expanded.x + expanded.width).toBe(1910);

      const closeResult = await handler(hostFrameEvent(), false);
      expect(closeResult).toEqual({ ok: true });
      flushTween();
      const restored = lastBounds(main);
      expect(restored.width).toBe(MAIN_WINDOW_WIDTH);
      expect(restored.height).toBe(expanded.height);
      expect(restored.y).toBe(expanded.y);
      expect(restored.x + restored.width).toBe(expanded.x + expanded.width);
    });

    it("rejects invalid side-panel resize payloads", async () => {
      const main = makeMainWindow();
      useAsSender(main);
      const handler = handleMap.get("ave:window:resize-for-side-panel")!;

      const result = await handler(hostFrameEvent(), "open");
      expect(result).toEqual({ ok: false, error: "invalid-open-state" });
      expect(main.setBounds).not.toHaveBeenCalled();
    });

    it("audits unauthorized side-panel resize requests", async () => {
      const handler = handleMap.get("ave:window:resize-for-side-panel")!;
      const result = await handler(unauthorizedEvent(), true);
      expect(result).toEqual(UNAUTHORIZED_FRAME);
      expect(auditLogger.log).toHaveBeenCalledOnce();
    });

    it("cancels an in-flight tween so the latest target wins and lands exactly", async () => {
      const main = makeMainWindow();
      useAsSender(main);
      const handler = handleMap.get("ave:window:resize-for-mode")!;
      await handler(hostFrameEvent(), "work");
      vi.advanceTimersByTime(48); // a few frames in, not yet settled
      await handler(hostFrameEvent(), "chat");
      flushTween();
      const bounds = lastBounds(main);
      expect(bounds.width).toBeLessThan(800);
      expect(bounds).not.toEqual({ x: 339, y: 156, width: 1243, height: 768 });
    });

    it("resizes only the sender's window and keeps each window's tween independent", async () => {
      const first = makeMainWindow();
      const second = makeMainWindow();
      appState.registerMainWindow(first as never, "primary");
      appState.registerMainWindow(second as never, "secondary");
      const handler = handleMap.get("ave:window:resize-for-mode")!;

      fromWebContents.mockReturnValue(first);
      await handler(hostFrameEvent(), "work");
      vi.advanceTimersByTime(48);
      fromWebContents.mockReturnValue(second);
      await handler(hostFrameEvent(), "chat");
      flushTween();

      expect(lastBounds(first)).toEqual({ x: 339, y: 156, width: 1243, height: 768 });
      expect(lastBounds(second).width).toBeLessThan(800);
    });
  });
});
