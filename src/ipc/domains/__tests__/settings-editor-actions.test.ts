import { requiredFixture } from "../../../__tests__/support/required-fixture.js";
import { EventEmitter } from "node:events";
import { securitySettingsGestures } from "../../security-settings-gesture.js";
import { USER_GESTURE_LIFETIME_MS } from "../../../shared/chat-origin.js";
import { useConfigurationOwner as configureTestOwner } from "../../../__tests__/support/configuration-owner.js";
configureTestOwner();
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettingsService } from "../../../data/settings-store.js";
import { DEFAULT_SETTINGS } from "../../../data/settings-defaults.js";
import { unavailableSecretEncryption } from "../../../__tests__/support/host-runtime.js";
import { cleanupTmpDir } from "../../../__tests__/support/tmp-dir-teardown.js";
import { SETTINGS } from "../../../shared/ipc-channels.js";
import { makeAppIpcInvoker, makeAppIpcFrameInvoker } from "./test-helpers.js";
const { handlers, openPath, showOpenDialog } = vi.hoisted(() => ({ handlers: new Map<string, (...args: unknown[]) => unknown>(), openPath: vi.fn(async (_path: string) => ""), showOpenDialog: vi.fn(async () => ({ canceled: false, filePaths: ["/synthetic/folder"] })) }));
vi.mock("electron", () => ({ ipcMain: { handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler)) }, shell: { openPath }, dialog: { showOpenDialog } }));
const invoke = makeAppIpcInvoker(handlers);
let userDataPath: string;
let actionEvent: { sender: EventEmitter & { mainFrame: { url: string }; isDestroyed: () => boolean }; senderFrame: { url: string } };
function invokeAction(channel: string, native = true) {
  if (native) actionEvent.sender.emit("before-mouse-event", {}, { type: "mouseUp" });
  return requiredFixture(handlers.get(channel))(actionEvent, { intent: { inputOrigin: "user-keyboard", userActivation: true } });
}
afterEach(async () => { handlers.clear(); vi.clearAllMocks(); if (userDataPath) await cleanupTmpDir(userDataPath); });
async function register() {
  userDataPath = mkdtempSync(join(tmpdir(), "settings-editor-ipc-"));
  const frame = { url: "file:///Applications/Ave.app/dist/index.html" };
  const contents = Object.assign(new EventEmitter(), { mainFrame: frame, isDestroyed: () => false });
  securitySettingsGestures.observe(contents as never);
  actionEvent = { sender: contents, senderFrame: frame };
  const settingsService = new SettingsService({ userDataPath, encryption: unavailableSecretEncryption });
  const { registerSettingsHandlers } = await import("../settings.js");
  registerSettingsHandlers({ settingsService, conversationLoop: { refreshProvider: vi.fn() }, auditLogger: { log: vi.fn() }, getAppWindows: () => [{ webContents: contents, isDestroyed: () => false }], singleHopNetworkFetch: vi.fn() } as never);
  return settingsService;
}
describe("settings editor actions IPC", () => {
  it("returns canonical defaults independently from a modified saved value", async () => {
    const service = await register(); await service.patch({ chat: { autoCompact: !DEFAULT_SETTINGS.chat.autoCompact } });
    const snapshot = await invoke(SETTINGS.defaults) as { chat: typeof DEFAULT_SETTINGS.chat };
    expect(snapshot.chat.autoCompact).toBe(DEFAULT_SETTINGS.chat.autoCompact);
    expect(service.get("chat").autoCompact).not.toBe(snapshot.chat.autoCompact);
    expect(snapshot).not.toHaveProperty("upstreamProxy"); expect(snapshot).not.toHaveProperty("a2aRemote");
  });
  it("refuses a native input older than the gesture lifetime", async () => {
    vi.useFakeTimers();
    try {
      await register();
      actionEvent.sender.emit("before-mouse-event", {}, { type: "mouseUp" });
      vi.advanceTimersByTime(USER_GESTURE_LIFETIME_MS + 1);
      expect(await invokeAction(SETTINGS.openFile, false)).toMatchObject({ ok: false, error: "user-keyboard-required" });
      expect(openPath).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
  it("opens only the main-owned settings file and reports native refusal", async () => {
    const service = await register();
    expect(await invokeAction(SETTINGS.openFile)).toEqual({ ok: true });
    expect(openPath).toHaveBeenCalledWith(service.getSettingsFilePath());
    openPath.mockResolvedValueOnce("native refusal");
    expect(await invokeAction(SETTINGS.openFile)).toEqual({ ok: false, error: "settings-file-open-failed" });
  });
  it("returns a picked folder or cancellation without changing permissions", async () => {
    const service = await register(); const before = service.getAll();
    expect(await invokeAction(SETTINGS.pickDirectory)).toEqual({ ok: true, path: "/synthetic/folder" });
    expect(showOpenDialog).toHaveBeenCalledWith({ properties: ["openDirectory"] });
    showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] });
    expect(await invokeAction(SETTINGS.pickDirectory)).toEqual({ ok: true, path: null });
    showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [] });
    expect(await invokeAction(SETTINGS.pickDirectory)).toEqual({ ok: false, error: "directory-picker-empty-result" });
    expect(service.getAll()).toEqual(before);
  });
  it("requires a real main input gesture and consumes it once", async () => {
    await register();
    expect(await invokeAction(SETTINGS.openFile, false)).toEqual({ ok: false, error: "user-keyboard-required" });
    expect(await invokeAction(SETTINGS.pickDirectory)).toEqual({ ok: true, path: "/synthetic/folder" });
    expect(await invokeAction(SETTINGS.pickDirectory, false)).toEqual({ ok: false, error: "user-keyboard-required" });
    expect(openPath).not.toHaveBeenCalled();
  });
  it.each([SETTINGS.defaults, SETTINGS.openFile, SETTINGS.pickDirectory])("refuses a foreign frame on %s", async (channel) => {
    await register();
    const result = await makeAppIpcFrameInvoker(handlers)(channel, "https://foreign.invalid/");
    expect(result).toMatchObject({ ok: false }); expect(openPath).not.toHaveBeenCalled(); expect(showOpenDialog).not.toHaveBeenCalled();
  });
});
