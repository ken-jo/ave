import { describe, expect, it, vi } from "vitest";
import { CHANNELS, isPublicChannel } from "../../../contract/app-contract.js";
import { makeAppIpcInvoker } from "./test-helpers.js";
import { MAX_SERVER_ID_LEN } from "../../../shared/mcp-app-partition.js";
import { UNAUTHORIZED_FRAME } from "../../gated.js";
import { bundledConfigId } from "../../../mcp/bundled-credential.js";

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
    expect(result).toEqual(UNAUTHORIZED_FRAME);
    expect(authenticate).not.toHaveBeenCalled();
    expect(auditLogger.log).toHaveBeenCalled();
  });

  it.each([undefined, null, {}, "", "../other", "server\nsecret", "s".repeat(MAX_SERVER_ID_LEN + 1), "bundled:not-json", 'bundled:["other","a","b"]'])("rejects malformed server ids before authentication: %j", async (id) => {
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

  it.each(["mcp-auth-storage-unavailable", "mcp-auth-storage-unreadable", "mcp-auth-registration-unsupported", "mcp-auth-resource-mismatch"] as const)(
    "passes the distinct %s outcome through", async (errorCode) => {
      const { authenticate } = await setup();
      authenticate.mockResolvedValueOnce({ connected: false, errorCode });
      expect(await invoke(CHANNELS.mcp.authenticate, "remote-a")).toEqual({ connected: false, errorCode });
    });

  it("accepts the settings-row id of a bundled server that is not running", async () => {
    const { authenticate } = await setup();
    const id = bundledConfigId({ kind: "agent-plugin", name: "remote-tools" }, "remote");
    expect(await invoke(CHANNELS.mcp.authenticate, id)).toEqual({ connected: true });
    expect(authenticate).toHaveBeenCalledWith(id);
  });

  it("sanitizes unknown failure results and thrown provider text", async () => {
    const { authenticate } = await setup();
    authenticate.mockResolvedValueOnce({ connected: false, errorCode: "private-value", message: "private-value" });
    expect(await invoke(CHANNELS.mcp.authenticate, "remote-a")).toEqual({ connected: false, errorCode: "mcp-auth-failed" });
    authenticate.mockRejectedValueOnce(new Error("private-value"));
    expect(await invoke(CHANNELS.mcp.authenticate, "remote-a")).toEqual({ connected: false, errorCode: "mcp-auth-failed" });
  });
});
