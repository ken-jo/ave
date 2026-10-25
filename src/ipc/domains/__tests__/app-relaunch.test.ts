import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ipcMain, type IpcMainInvokeEvent } from "electron";
import { CHANNELS, CHANNEL_GESTURE, isPublicChannel } from "../../../contract/app-contract.js";
import { hostFrameEvent, pluginShellFrameEvent } from "../../../__tests__/test-helpers.js";
import { beginAppUpdateInstallRequest, clearAppUpdateInstallRequested } from "../../../main/app-update-install-intent.js";
import { withPluginInstallLock } from "../../../plugins/install-lifecycle.js";
import { registerAppHandlers } from "../app.js";
import type { IpcDeps } from "../../types.js";
import { setAppRelaunchRequested } from "../../../main/app-relaunch-state.js";

vi.mock("electron", () => ({ ipcMain: { handle: vi.fn() } }));

const handlers = new Map<string, Parameters<typeof ipcMain.handle>[1]>();
const auditLogger = { log: vi.fn() };
const relaunchApp = vi.fn();
const intent = { intent: { inputOrigin: "user-keyboard", userActivation: true } };
let mainEvent: IpcMainInvokeEvent;

beforeEach(() => {
  clearAppUpdateInstallRequested();
  setAppRelaunchRequested(false);
  auditLogger.log.mockClear();
  relaunchApp.mockReset();
  mainEvent = hostFrameEvent();
  Object.assign(mainEvent.sender, { mainFrame: mainEvent.senderFrame });
  vi.spyOn(ipcMain, "handle").mockImplementation((channel, handler) => { handlers.set(channel, handler); });
  registerAppHandlers({ auditLogger, relaunchApp, getMainWindow: () => ({ webContents: mainEvent.sender, isDestroyed: () => false }) } as unknown as IpcDeps);
});
afterEach(() => { clearAppUpdateInstallRequested(); setAppRelaunchRequested(false); vi.restoreAllMocks(); handlers.clear(); });

function invoke(event = mainEvent, payload: unknown = intent) {
  return handlers.get(CHANNELS.app.relaunch)!(event, payload);
}

describe("app relaunch boundary", () => {
  it("refuses an unrelated local window with hand-written intent", () => {
    const event = hostFrameEvent();
    Object.assign(event.senderFrame!, { url: "file:///tmp/unrelated.html" });
    Object.assign(event.sender, { mainFrame: event.senderFrame });
    expect(invoke(event)).toEqual({ ok: false, error: "unauthorized-frame" });
    expect(relaunchApp).not.toHaveBeenCalled();
  });

  it("refuses a subframe of the main window", () => {
    const event = { ...mainEvent, senderFrame: { url: mainEvent.senderFrame!.url } } as IpcMainInvokeEvent;
    expect(invoke(event)).toEqual({ ok: false, error: "unauthorized-frame" });
    expect(relaunchApp).not.toHaveBeenCalled();
  });

  it("audits missing activation", () => {
    expect(invoke(mainEvent, {})).toEqual({ ok: false, error: "user-keyboard-required" });
    expect(auditLogger.log).toHaveBeenCalledWith(expect.objectContaining({ type: "warn", input: expect.stringContaining("user-keyboard-required") }));
  });

  it("closes plugin install entry before invoking the host", async () => {
    const install = vi.fn(async () => undefined);
    let pending!: Promise<unknown>;
    relaunchApp.mockImplementation(() => { pending = withPluginInstallLock("after-relaunch", install); });
    expect(invoke()).toEqual({ ok: true });
    await expect(pending).rejects.toMatchObject({ code: "relaunch-in-progress" });
    expect(install).not.toHaveBeenCalled();
  });

  it("closes update install entry after accepting relaunch", () => {
    expect(invoke()).toEqual({ ok: true });
    expect(() => beginAppUpdateInstallRequest()).toThrow("relaunch-in-progress");
  });

  it("audits and refuses repeated IPC requests", () => {
    expect(invoke()).toEqual({ ok: true });
    expect(invoke()).toEqual({ ok: false, error: "relaunch-in-progress" });
    expect(relaunchApp).toHaveBeenCalledExactlyOnceWith();
    expect(auditLogger.log).toHaveBeenCalledWith(expect.objectContaining({ type: "warn", input: expect.stringContaining("relaunch-in-progress") }));
  });

  it("reopens install entry after a failed relaunch", async () => {
    relaunchApp.mockImplementation(() => { throw new Error("relaunch-unsupported"); });
    expect(invoke()).toEqual({ ok: false, error: "relaunch-unsupported" });
    const install = vi.fn(async () => undefined);
    await withPluginInstallLock("after-failure", install);
    expect(install).toHaveBeenCalledExactlyOnceWith();
    expect(() => beginAppUpdateInstallRequest()).not.toThrow();
  });

  it("keeps installs closed when the host reports an already scheduled relaunch", async () => {
    relaunchApp.mockImplementation(() => { throw new Error("relaunch-in-progress"); });
    expect(invoke()).toEqual({ ok: false, error: "relaunch-in-progress" });
    const install = vi.fn(async () => undefined);
    await expect(withPluginInstallLock("scheduled", install)).rejects.toMatchObject({ code: "relaunch-in-progress" });
    expect(install).not.toHaveBeenCalled();
    expect(() => beginAppUpdateInstallRequest()).toThrow("relaunch-in-progress");
  });

  it("requires a user gesture and stays internal", () => {
    expect(CHANNEL_GESTURE[CHANNELS.app.relaunch]).toBe("required");
    expect(isPublicChannel(CHANNELS.app.relaunch)).toBe(false);
    expect(invoke(mainEvent, {})).toEqual({ ok: false, error: "user-keyboard-required" });
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
      expect(auditLogger.log).toHaveBeenCalledWith(expect.objectContaining({ type: "warn", input: expect.stringContaining("plugin-install-in-progress") }));
      expect(relaunchApp).not.toHaveBeenCalled();
    });
    expect(invoke()).toEqual({ ok: true });
  });

  it("refuses while an app update installation is requested", () => {
    beginAppUpdateInstallRequest();
    expect(invoke()).toEqual({ ok: false, error: "update-install-in-progress" });
    expect(auditLogger.log).toHaveBeenCalledWith(expect.objectContaining({ type: "warn", input: expect.stringContaining("update-install-in-progress") }));
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
