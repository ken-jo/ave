import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserWorkspaceService } from "../../../main/browser/browser-workspace.js";
import type { IpcDeps } from "../../types.js";

const { handlers, authorize, mainWindow, send, changed } = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, payload?: unknown) => Promise<unknown>>(), authorize: vi.fn(() => true), mainWindow: vi.fn(() => ({ id: 1, isDestroyed: () => false })), send: vi.fn(), changed: { handler: null as null | ((windowId: number, state: unknown) => void) },
}));
vi.mock("electron", () => ({ ipcMain: { handle: (channel: string, callback: (event: unknown, payload?: unknown) => Promise<unknown>) => handlers.set(channel, callback) } }));
vi.mock("../../../contract/app-contract.js", () => ({ CHANNELS: { browserWorkspace: Object.fromEntries(["getState", "setBookmark", "clearHistory", "setSitePermission", "find", "stopFind", "zoom", "preview", "changed"].map((key) => [key, `workspace:${key}`])) } }));
vi.mock("../../gated.js", () => ({ validateHostRendererSender: authorize, auditUnauthorized: vi.fn() }));
vi.mock("../../../main/app-state.js", () => ({ mainWindowForContents: mainWindow, getMainWindows: () => [{ id: 1 }, { id: 2 }] }));
vi.mock("../../safe-send.js", () => ({ sendToWindow: send }));
import { registerBrowserWorkspaceHandlers } from "../browser-workspace.js";

function setup() {
  const service = { onChanged: vi.fn((handler: (windowId: number, state: unknown) => void) => { changed.handler = handler; }), getState: vi.fn(async () => ({ revision: 1 })), setBookmark: vi.fn(), clearHistory: vi.fn(), setSitePermission: vi.fn(), find: vi.fn(), stopFind: vi.fn(), zoom: vi.fn(), preview: vi.fn() };
  registerBrowserWorkspaceHandlers({ auditLogger: {} } as IpcDeps, service as unknown as BrowserWorkspaceService);
  return service;
}
beforeEach(() => { handlers.clear(); vi.clearAllMocks(); authorize.mockReturnValue(true); mainWindow.mockReturnValue({ id: 1, isDestroyed: () => false }); });
const EVENT = { sender: {} };

describe("private browser workspace IPC", () => {
  it("rejects every invoke from an unauthorized frame before service access", async () => {
    const service = setup(); authorize.mockReturnValue(false);
    expect(handlers.size).toBe(8);
    for (const handler of handlers.values()) expect(await handler(EVENT)).toEqual({ ok: false, error: "unauthorized-frame" });
    expect(service.getState).not.toHaveBeenCalled(); expect(service.preview).not.toHaveBeenCalled();
  });
  it("derives the owner window from the sender and rejects injected authority and stale errors", async () => {
    const service = setup();
    expect(await handlers.get("workspace:preview")!(EVENT, { tabId: "browser:one", documentGeneration: 1, windowId: 2 })).toEqual({ ok: false, error: "bad-request" });
    expect(service.preview).not.toHaveBeenCalled();
    service.preview.mockRejectedValueOnce(new Error("stale-document"));
    const target = { tabId: "browser:one", documentGeneration: 1 };
    expect(await handlers.get("workspace:preview")!(EVENT, target)).toEqual({ ok: false, error: "stale-document" });
    expect(service.preview).toHaveBeenCalledWith(1, target);
  });
  it("returns storage failures explicitly and sends changed state only to its owner window", async () => {
    const service = setup();
    service.getState.mockRejectedValueOnce(new Error("storage-unavailable"));
    expect(await handlers.get("workspace:getState")!(EVENT)).toEqual({ ok: false, error: "storage-unavailable" });
    const state = { revision: 3 };
    changed.handler!(2, state);
    expect(send).toHaveBeenCalledWith({ id: 2 }, "workspace:changed", state, expect.anything());
  });
  it("rejects an unknown internal failure instead of relabeling it as storage failure", async () => {
    const service = setup();
    service.getState.mockRejectedValueOnce(new TypeError("Missing internal callback"));
    await expect(handlers.get("workspace:getState")!(EVENT)).rejects.toThrow("Missing internal callback");
  });
});
