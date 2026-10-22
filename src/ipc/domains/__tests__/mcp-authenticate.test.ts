import { describe, expect, it, vi } from "vitest";
import { CHANNELS, isPublicChannel } from "../../../contract/app-contract.js";
import { makeAppIpcInvoker } from "./test-helpers.js";
import { MAX_SERVER_ID_LEN } from "../../../shared/mcp-app-partition.js";

const handlers = new Map<string, (...args: unknown[]) => unknown>();
vi.mock("electron", () => ({
  app: { isPackaged: false, getPath: vi.fn(() => "") },
  dialog: { showOpenDialog: vi.fn() },
  ipcMain: { handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler)) },
  webContents: { fromId: vi.fn() },
}));
const invoke = makeAppIpcInvoker(handlers);

async function setup() {
  handlers.clear();
  const authenticate = vi.fn(async (_id: string): Promise<unknown> => ({ connected: true }));
  const auditLogger = { log: vi.fn() };
  const { registerPluginsHandlers } = await import("../plugins.js");
  registerPluginsHandlers({
    pluginRuntime: { getPerfStats: vi.fn(() => ({})) },
    pluginLoopbackManager: { has: vi.fn(() => false), readUiResource: vi.fn() },
    mcpManager: { authenticate },
    toolRegistry: { size: 0, findByName: vi.fn() },
    getPluginToolInvoker: () => vi.fn(),
    settingsService: { get: vi.fn(() => ({})) },
    auditLogger,
    pluginMarketplace: { list: vi.fn(async () => []) },
    refreshPluginEventBridge: vi.fn(),
    getMainWindow: vi.fn(() => null),
    getAppWindows: vi.fn(() => []),
  } as never);
  return { authenticate, auditLogger };
}

describe("remote authentication IPC", () => {
  it("is internal and rejects unauthorized frames before calling the manager", async () => {
    const { authenticate, auditLogger } = await setup();
    expect(isPublicChannel(CHANNELS.mcp.authenticate)).toBe(false);
    const result = await handlers.get(CHANNELS.mcp.authenticate)!({ senderFrame: { url: "https://untrusted.test" } }, "remote-a");
    expect(result).toEqual({ connected: false, errorCode: "mcp-auth-failed" });
    expect(authenticate).not.toHaveBeenCalled();
    expect(auditLogger.log).toHaveBeenCalled();
  });

  it.each([undefined, null, {}, "", "../other", "server\nsecret", "s".repeat(MAX_SERVER_ID_LEN + 1)])("rejects malformed server ids before authentication: %j", async (id) => {
    const { authenticate } = await setup();
    expect(await invoke(CHANNELS.mcp.authenticate, id)).toEqual({ connected: false, errorCode: "mcp-auth-failed" });
    expect(authenticate).not.toHaveBeenCalled();
  });

  it("returns only the safe success outcome", async () => {
    const { authenticate } = await setup();
    authenticate.mockResolvedValueOnce({ connected: true, access_token: "private-value", authorizationUrl: "https://untrusted.test/?secret=private-value" });
    expect(await invoke(CHANNELS.mcp.authenticate, "remote-a")).toEqual({ connected: true });
    expect(authenticate).toHaveBeenCalledWith("remote-a");
  });

  it("preserves the reauthentication result without other manager fields", async () => {
    const { authenticate } = await setup();
    authenticate.mockResolvedValueOnce({ connected: false, errorCode: "mcp-auth-required", refresh_token: "private-value" });
    expect(await invoke(CHANNELS.mcp.authenticate, "remote-a")).toEqual({ connected: false, errorCode: "mcp-auth-required" });
  });

  it("sanitizes unknown failure results and thrown provider text", async () => {
    const { authenticate } = await setup();
    authenticate.mockResolvedValueOnce({ connected: false, errorCode: "private-value", message: "private-value" });
    expect(await invoke(CHANNELS.mcp.authenticate, "remote-a")).toEqual({ connected: false, errorCode: "mcp-auth-failed" });
    authenticate.mockRejectedValueOnce(new Error("private-value"));
    expect(await invoke(CHANNELS.mcp.authenticate, "remote-a")).toEqual({ connected: false, errorCode: "mcp-auth-failed" });
  });
});
