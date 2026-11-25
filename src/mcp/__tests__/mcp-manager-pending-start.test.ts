/** A stdio server that nothing confines waits in the pending list; a yes connects it again with its own consent. */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdir, rm } from "node:fs/promises";
import { mkdtempSync } from "node:fs";

const mockConnect = vi.fn();

vi.mock("../mcp-client.js", () => ({
  McpClient: class {
    connect = mockConnect;
    disconnect = vi.fn().mockResolvedValue(undefined);
    getState = () => ({ id: "files", status: "connected" as const, registeredTools: [] });
  },
  scrubSecrets: (s: string) => s,
}));
vi.mock("../mcp-governance.js", () => ({
  McpGovernance: class {
    validateServer = () => ({ valid: true as const });
    getApproval = () => ({ status: "approved" });
    unregisterRuntimeApproval = vi.fn();
  },
}));
vi.mock("../../tools/registry.js", () => ({ ToolRegistry: class { unregisterByMcp = vi.fn(); } }));

import { McpManager } from "../mcp-manager.js";
import type { McpServerConfig } from "../types.js";
import { unusedNetworkFetch } from "../../__tests__/support/network-fetch-stubs.js";
import {
  __resetExtensionStartsForTest, ExtensionStartConsentRequiredError, listPendingExtensionStarts,
  setExtensionStartAsker, settlePendingExtensionStarts,
} from "../../permissions/extension-start-consent.js";

const testDir = mkdtempSync(join(tmpdir(), "ave-mcp-pending-"));
const SERVER: McpServerConfig = { id: "files", transport: "http", url: "https://example.com/mcp" };

async function makeManager() {
  const { McpGovernance } = await import("../mcp-governance.js");
  const { ToolRegistry } = await import("../../tools/registry.js");
  return new McpManager(
    new (McpGovernance as new () => InstanceType<typeof McpGovernance>)(),
    new (ToolRegistry as new () => InstanceType<typeof ToolRegistry>)(),
    unusedNetworkFetch,
    join(testDir, "mcp-servers.json"),
    { log: vi.fn() } as never,
    undefined,
    vi.fn(),
    { getSecret: async () => null, setSecret: async () => undefined, deleteSecret: async () => undefined },
  );
}

beforeEach(async () => {
  mockConnect.mockReset();
  await mkdir(testDir, { recursive: true });
});
afterEach(() => __resetExtensionStartsForTest());
afterAll(async () => { await rm(testDir, { recursive: true, force: true }); });

describe("an MCP server start that nothing confines", () => {
  it("is left unconnected in the pending list, and a yes connects it again", async () => {
    const manager = await makeManager();
    mockConnect.mockRejectedValueOnce(new ExtensionStartConsentRequiredError("no-backend")).mockResolvedValue(undefined);
    await expect(manager.connectServer(SERVER)).rejects.toBeInstanceOf(ExtensionStartConsentRequiredError);
    expect(listPendingExtensionStarts()).toMatchObject([{ key: "mcp-stdio:files", kind: "mcp-stdio", cause: "no-backend", state: "pending" }]);
    expect(mockConnect).toHaveBeenCalledTimes(1);

    const ask = vi.fn(async () => "yes" as const);
    setExtensionStartAsker({ ask, notify: vi.fn() });
    await settlePendingExtensionStarts({ sessionId: "s1", attended: true });
    expect(ask).toHaveBeenCalledTimes(1);
    expect(mockConnect).toHaveBeenCalledTimes(2);
    expect(listPendingExtensionStarts()).toEqual([]);
  });

  it("stays unconnected after a no, with one notice", async () => {
    const manager = await makeManager();
    mockConnect.mockRejectedValue(new ExtensionStartConsentRequiredError("no-backend"));
    await expect(manager.connectServer(SERVER)).rejects.toBeInstanceOf(ExtensionStartConsentRequiredError);
    const notify = vi.fn();
    setExtensionStartAsker({ ask: async () => "no", notify });
    await settlePendingExtensionStarts({ sessionId: "s1", attended: true });
    await settlePendingExtensionStarts({ sessionId: "s1", attended: true });
    expect(mockConnect).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("does not queue any other connect failure", async () => {
    const manager = await makeManager();
    mockConnect.mockRejectedValue(new Error("connection refused"));
    await expect(manager.connectServer(SERVER)).rejects.toThrow("connection refused");
    expect(listPendingExtensionStarts()).toEqual([]);
  });
});
