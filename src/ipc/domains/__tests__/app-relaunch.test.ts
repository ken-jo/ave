import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ipcMain } from "electron";
import { CHANNELS, CHANNEL_GESTURE, isPublicChannel } from "../../../contract/app-contract.js";
import { hostFrameEvent, pluginShellFrameEvent } from "../../../__tests__/test-helpers.js";
import { beginAppUpdateInstallRequest, clearAppUpdateInstallRequested } from "../../../main/app-update-install-intent.js";
import { withPluginInstallLock } from "../../../plugins/install-lifecycle.js";
import { registerAppHandlers } from "../app.js";
import type { IpcDeps } from "../../types.js";

vi.mock("electron", () => ({ ipcMain: { handle: vi.fn() } }));

const handlers = new Map<string, Parameters<typeof ipcMain.handle>[1]>();
const auditLogger = { log: vi.fn() };
const relaunchApp = vi.fn();
const intent = { intent: { inputOrigin: "user-keyboard", userActivation: true } };

beforeEach(() => {
  clearAppUpdateInstallRequested();
  auditLogger.log.mockClear();
  relaunchApp.mockReset();
  vi.spyOn(ipcMain, "handle").mockImplementation((channel, handler) => { handlers.set(channel, handler); });
  registerAppHandlers({ auditLogger, relaunchApp } as unknown as IpcDeps);
});
afterEach(() => { clearAppUpdateInstallRequested(); vi.restoreAllMocks(); handlers.clear(); });

function invoke(event = hostFrameEvent(), payload: unknown = intent) {
  return handlers.get(CHANNELS.app.relaunch)!(event, payload);
}

describe("app relaunch boundary", () => {
  it("requires a user gesture and stays internal", () => {
    expect(CHANNEL_GESTURE[CHANNELS.app.relaunch]).toBe("required");
    expect(isPublicChannel(CHANNELS.app.relaunch)).toBe(false);
    expect(invoke(hostFrameEvent(), {})).toEqual({ ok: false, error: "user-keyboard-required" });
    expect(relaunchApp).not.toHaveBeenCalled();
  });

  it("audits and refuses a plugin frame before considering consent", () => {
    expect(invoke(pluginShellFrameEvent())).toEqual({ ok: false, error: "unauthorized-frame" });
    expect(auditLogger.log).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "ipc-guard", input: expect.stringContaining(CHANNELS.app.relaunch) }));
    expect(relaunchApp).not.toHaveBeenCalled();
  });

  it("refuses while an extension installation holds its lifecycle lock", async () => {
    await withPluginInstallLock("relaunch-fixture", async () => {
      expect(invoke()).toEqual({ ok: false, error: "plugin-install-in-progress" });
      expect(relaunchApp).not.toHaveBeenCalled();
    });
    expect(invoke()).toEqual({ ok: true });
  });

  it("refuses while an app update installation is requested", () => {
    beginAppUpdateInstallRequest();
    expect(invoke()).toEqual({ ok: false, error: "update-install-in-progress" });
    expect(relaunchApp).not.toHaveBeenCalled();
  });

  it("relaunches the host after authorized confirmation", () => {
    expect(invoke()).toEqual({ ok: true });
    expect(relaunchApp).toHaveBeenCalledExactlyOnceWith();
  });

  it("returns a typed unsupported result from a headless host", () => {
    relaunchApp.mockImplementation(() => { throw new Error("relaunch-unsupported"); });
    expect(invoke()).toEqual({ ok: false, error: "relaunch-unsupported" });
  });

  it("contains unexpected runtime failures in a typed result", () => {
    relaunchApp.mockImplementation(() => { throw new Error("private runtime detail"); });
    expect(invoke()).toEqual({ ok: false, error: "relaunch-failed" });
  });
});
