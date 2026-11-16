import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CHANNELS } from "../../../contract/app-contract.js";
import { hostFrameEvent } from "../../../__tests__/test-helpers.js";
import { securitySettingsGestures } from "../../security-settings-gesture.js";
import { USER_GESTURE_LIFETIME_MS } from "../../../shared/chat-origin.js";
import type { IpcDeps } from "../../types.js";

const handlers = new Map<string, (...args: unknown[]) => unknown>();
vi.mock("electron", () => ({
  app: { isPackaged: false, getPath: vi.fn(() => "") },
  dialog: { showOpenDialog: vi.fn() },
  ipcMain: { handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn)) },
  webContents: { fromId: vi.fn() },
}));
const startServer = vi.fn(async () => ({ connected: true }));
const undoRemove = vi.fn(async () => undefined);
const audit = vi.fn();
const activeIntent = { inputOrigin: "user-keyboard", userActivation: true };

function getHandler(channel: string) {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`Missing IPC handler: ${channel}`);
  return handler;
}

async function register() {
  const { registerPluginsHandlers } = await import("../plugins.js");
  registerPluginsHandlers({ pluginRuntime: { subscribePluginStateChange: vi.fn(() => () => undefined) },
    mcpManager: { startServer, undoRemove }, auditLogger: { log: audit } } as unknown as IpcDeps);
  const contents = Object.assign(new EventEmitter(), { mainFrame: hostFrameEvent().senderFrame });
  securitySettingsGestures.observe(contents as never);
  return { contents, event: { sender: contents, senderFrame: contents.mainFrame } };
}

beforeEach(() => vi.clearAllMocks());

describe("MCP server start authority", () => {
  it("requires a main-observed native gesture and consumes it once", async () => {
    const { contents, event } = await register();
    const start = getHandler(CHANNELS.mcp.startServer);
    await expect(start(event, "local-notes", "a".repeat(64), activeIntent)).rejects.toThrow("user-keyboard-required");
    expect(startServer).not.toHaveBeenCalled();
    contents.emit("before-mouse-event", {}, { type: "mouseUp" });
    await expect(start(event, "local-notes", "a".repeat(64), activeIntent)).resolves.toEqual({ connected: true });
    expect(startServer).toHaveBeenCalledExactlyOnceWith("local-notes", "a".repeat(64));
    await expect(start(event, "local-notes", undefined, activeIntent)).rejects.toThrow("user-keyboard-required");
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ type: "approval", input: expect.stringContaining("mcp_server_start_refused") }));
  });

  it("refuses a stale native input although the renderer asserts an active intent", async () => {
    vi.useFakeTimers();
    try {
      const { contents, event } = await register();
      contents.emit("before-input-event", {}, { type: "keyDown", isAutoRepeat: false });
      vi.advanceTimersByTime(USER_GESTURE_LIFETIME_MS + 1);
      await expect(getHandler(CHANNELS.mcp.startServer)(event, "local-notes", "a".repeat(64), activeIntent)).rejects.toThrow("user-keyboard-required");
      expect(startServer).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it("does not let the input that started a server also restore another one", async () => {
    const { contents, event } = await register();
    contents.emit("before-mouse-event", {}, { type: "mouseUp" });
    await expect(getHandler(CHANNELS.mcp.startServer)(event, "local-notes", "a".repeat(64), activeIntent)).resolves.toEqual({ connected: true });
    await expect(getHandler(CHANNELS.mcp.undoRemove)(event, "other-notes", activeIntent)).rejects.toThrow("user-keyboard-required");
    expect(undoRemove).not.toHaveBeenCalled();
  });

  it("refuses expired renderer activation despite earlier native input", async () => {
    const { contents, event } = await register();
    const start = getHandler(CHANNELS.mcp.startServer);
    const undo = getHandler(CHANNELS.mcp.undoRemove);
    contents.emit("before-input-event", {}, { type: "keyDown", isAutoRepeat: false });
    await expect(start(event, "local-notes", "a".repeat(64), { inputOrigin: "user-keyboard", userActivation: false })).rejects.toThrow("user-keyboard-required");
    await expect(undo(event, "local-notes", { inputOrigin: "user-keyboard", userActivation: false })).rejects.toThrow("user-keyboard-required");
    expect(startServer).not.toHaveBeenCalled();
    expect(undoRemove).not.toHaveBeenCalled();
  });

  it("refuses a host subframe even when the window has native input", async () => {
    const { contents, event } = await register();
    contents.emit("before-input-event", {}, { type: "keyDown", isAutoRepeat: false });
    const result = await getHandler(CHANNELS.mcp.startServer)({ ...event, senderFrame: { ...event.senderFrame } }, "local-notes");
    expect(result).toEqual({ ok: false, error: "unauthorized-frame" });
    expect(startServer).not.toHaveBeenCalled();
    await expect(getHandler(CHANNELS.mcp.undoRemove)({ ...event, senderFrame: { ...event.senderFrame } }, "local-notes")).rejects.toThrow("unauthorized-frame");
    expect(undoRemove).not.toHaveBeenCalled();
  });

  it("requires the same shared native authority for undo", async () => {
    const { contents, event } = await register();
    const undo = getHandler(CHANNELS.mcp.undoRemove);
    await expect(undo(event, "local-notes", activeIntent)).rejects.toThrow("user-keyboard-required");
    contents.emit("before-input-event", {}, { type: "keyDown", isAutoRepeat: false });
    await expect(undo(event, "local-notes", activeIntent)).resolves.toBeUndefined();
    expect(undoRemove).toHaveBeenCalledExactlyOnceWith("local-notes");
  });
});
