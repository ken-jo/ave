import { afterEach, describe, expect, it, vi } from "vitest";
import { ipcRenderer } from "electron";
import { mcpApiSurface } from "../mcp-api-surface.js";
import { CHANNELS } from "../../contract/app-contract.js";

vi.mock("electron", () => ({ ipcRenderer: { invoke: vi.fn(async () => undefined) } }));
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe("MCP management preload intent", () => {
  it.each([true, false])("derives current activation (%s) for start, undo and credential clear in isolated preload", async (isActive) => {
    vi.stubGlobal("navigator", { userActivation: { isActive } });
    await mcpApiSurface.startServer("local-notes", "a".repeat(64));
    expect(ipcRenderer.invoke).toHaveBeenNthCalledWith(1, CHANNELS.mcp.startServer, "local-notes", "a".repeat(64),
      { inputOrigin: "user-keyboard", userActivation: isActive });
    await mcpApiSurface.undoRemove("local-notes");
    expect(ipcRenderer.invoke).toHaveBeenNthCalledWith(2, CHANNELS.mcp.undoRemove, "local-notes",
      { inputOrigin: "user-keyboard", userActivation: isActive });
    await mcpApiSurface.clearApiKey("local-notes");
    expect(ipcRenderer.invoke).toHaveBeenNthCalledWith(3, CHANNELS.mcp.clearApiKey, "local-notes",
      { inputOrigin: "user-keyboard", userActivation: isActive });
  });
});
