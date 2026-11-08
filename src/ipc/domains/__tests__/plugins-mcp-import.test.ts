import { describe, expect, it, vi } from "vitest";
import { makeAppIpcInvoker } from "./test-helpers.js";
import { CHANNELS } from "../../../contract/app-contract.js";
import { MCP_GOVERNANCE_UNAPPROVED_SERVER } from "../../../shared/mcp-error-code.js";
import type { IpcDeps } from "../../types.js";

const handlers = new Map<string, (...args: unknown[]) => unknown>();
vi.mock("electron", () => ({
  app: { isPackaged: false, getPath: vi.fn(() => "") },
  dialog: { showOpenDialog: vi.fn() },
  ipcMain: { handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn)) },
  webContents: { fromId: vi.fn() },
}));
const invoke = makeAppIpcInvoker(handlers);

describe("MCP config import refusal details", () => {
  it.each(["add", "remove"])("strips the known leading code from a failed %s", async (operation) => {
    const detail = "서버 승인이 필요합니다.";
    const error = new Error(`${MCP_GOVERNANCE_UNAPPROVED_SERVER}: ${detail}`);
    const mcpManager = {
      getConfigs: vi.fn(async () => operation === "remove" ? [{ id: "notes" }] : []),
      addConfig: vi.fn().mockRejectedValue(error),
      removeConfig: vi.fn().mockRejectedValue(error),
    };
    const { registerPluginsHandlers } = await import("../plugins.js");
    registerPluginsHandlers({ pluginRuntime: { subscribePluginStateChange: vi.fn(() => () => undefined) }, mcpManager, auditLogger: { log: vi.fn() } } as unknown as IpcDeps);
    const result = await invoke(CHANNELS.mcp.importClaudeDesktopApply, {
      raw: JSON.stringify({ mcpServers: { notes: { command: "notes-server" } } }),
      conflictPolicy: "overwrite",
    });
    expect(result).toMatchObject({ ok: true, results: [{ id: "notes", action: "failed", reason: detail }] });
    expect(JSON.stringify(result)).not.toContain(MCP_GOVERNANCE_UNAPPROVED_SERVER);
    expect(operation === "remove" ? mcpManager.removeConfig : mcpManager.addConfig).toHaveBeenCalledOnce();
    if (operation === "remove") expect(mcpManager.addConfig).not.toHaveBeenCalled();
  });
});
