import { collectPermissionEvents, watchPermissionEvents } from "../../__tests__/support/permission-events.js";
import { describe, expect, it, vi } from "vitest";
import { fanOutToAllWindows } from "../window-fanout.js";
import { liveWindow, type FakeBrowserWindow } from "../../__tests__/test-helpers.js";


describe("fanOutToAllWindows", () => {
  it("delivers the payload to every live window and returns the count", () => {
    const w1 = liveWindow();
    const w2 = liveWindow();

    const delivered = fanOutToAllWindows([w1, w2] as never, "ave:test", { x: 1 });

    expect(delivered).toBe(2);
    expect(w1.webContents.send).toHaveBeenCalledWith("ave:test", { x: 1 });
    expect(w2.webContents.send).toHaveBeenCalledWith("ave:test", { x: 1 });
  });

  it("skips null and destroyed windows without throwing", () => {
    const live = liveWindow();
    const destroyed: FakeBrowserWindow = {
      isDestroyed: () => true,
      webContents: { isDestroyed: () => true, send: vi.fn() },
    };

    const delivered = fanOutToAllWindows(
      [null, undefined, destroyed, live] as never,
      "ave:test",
      undefined,
    );

    expect(delivered).toBe(1);
    expect(destroyed.webContents.send).not.toHaveBeenCalled();
    expect(live.webContents.send).toHaveBeenCalledWith("ave:test", undefined);
  });

  it("swallows a per-window send race, logs it, and keeps fanning out", () => {
    const logger = { warn: vi.fn() };
    const failing: FakeBrowserWindow = {
      isDestroyed: () => false,
      webContents: {
        isDestroyed: () => false,
        send: () => {
          throw new TypeError("Object has been destroyed");
        },
      },
    };
    const ok = liveWindow();

    const delivered = fanOutToAllWindows([failing, ok] as never, "ave:test", { x: 1 }, { logger });

    expect(delivered).toBe(1);
    expect(ok.webContents.send).toHaveBeenCalledWith("ave:test", { x: 1 });
    expect(logger.warn).toHaveBeenCalledWith(
      { channel: "ave:test", error: "Object has been destroyed" },
      "renderer IPC send skipped",
    );
  });

  it("emits channel and inbox count for an observed broadcast", () => {
    const capture = collectPermissionEvents();
    try {
      const windows = [liveWindow(), liveWindow()];
      expect(fanOutToAllWindows(windows as never, "ave:test", { payload: "secret-canary" }, { auditSessionId: "auth" })).toBe(2);
      expect(capture.events).toEqual([{ event: "ipc_broadcast", sessionId: "auth", channel: "ave:test", delivered: 2 }]);
    } finally {
      capture.restore();
    }
  });

  it("delivers the broadcast when logging throws", () => {
    const sink = watchPermissionEvents(() => { throw new Error("Log sink unavailable"); });
    try {
      const window = liveWindow();
      expect(fanOutToAllWindows([window] as never, "ave:test", { x: 1 }, { auditSessionId: "auth" })).toBe(1);
      expect(window.webContents.send).toHaveBeenCalledWith("ave:test", { x: 1 });
    } finally {
      sink.mockRestore();
    }
  });
});
