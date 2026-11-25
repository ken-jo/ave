/** A stdio server that nothing confines waits in the pending list; a yes connects it again with its own consent. */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdir, rm } from "node:fs/promises";
import { mkdtempSync } from "node:fs";

const mockConnect = vi.fn();
const created = vi.hoisted(() => [] as unknown[]);
const probe = vi.hoisted(() => ({ now: "no-backend" as "no-backend" | "confined" }));

vi.mock("../mcp-client.js", () => ({
  McpClient: class {
    constructor(config: unknown) { created.push(config); }
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
vi.mock("../../permissions/asrt-sandbox.js", async (original) => ({ ...await original<typeof import("../../permissions/asrt-sandbox.js")>(), probeExtensionStart: () => probe.now }));

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
  created.length = 0;
  probe.now = "no-backend";
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

  it("connects with no card once a backend confines the server", async () => {
    const manager = await makeManager();
    mockConnect.mockRejectedValueOnce(new ExtensionStartConsentRequiredError("no-backend")).mockResolvedValue(undefined);
    await expect(manager.connectServer(SERVER)).rejects.toBeInstanceOf(ExtensionStartConsentRequiredError);
    const ask = vi.fn(async () => "yes" as const);
    setExtensionStartAsker({ ask, notify: vi.fn() });
    probe.now = "confined";
    await settlePendingExtensionStarts({ sessionId: "s1", attended: true });
    expect(ask).not.toHaveBeenCalled();
    expect(mockConnect).toHaveBeenCalledTimes(2);
    expect(listPendingExtensionStarts()).toEqual([]);
  });

  it.each([
    ["command", { command: "bun" }],
    ["args", { args: ["serve", "--all"] }],
    ["env", { env: { MODE: "b" } }],
  ])("asks again after a no once the server's %s is edited", async (_field, change) => {
    const manager = await makeManager();
    const stdio: McpServerConfig = { id: "files", transport: "stdio", command: "node", args: ["serve"], env: { MODE: "a" } };
    mockConnect.mockRejectedValue(new ExtensionStartConsentRequiredError("no-backend"));
    await expect(manager.connectServer(stdio)).rejects.toBeInstanceOf(ExtensionStartConsentRequiredError);
    const ask = vi.fn(async () => "no" as const);
    setExtensionStartAsker({ ask, notify: vi.fn() });
    await settlePendingExtensionStarts({ sessionId: "s1", attended: true });
    expect(ask).toHaveBeenCalledTimes(1);

    // The same config keeps the no.
    await expect(manager.connectServer({ ...stdio, args: ["serve"], env: { MODE: "a" } })).rejects.toBeInstanceOf(ExtensionStartConsentRequiredError);
    await settlePendingExtensionStarts({ sessionId: "s1", attended: true });
    expect(ask).toHaveBeenCalledTimes(1);

    await expect(manager.connectServer({ ...stdio, ...change } as McpServerConfig)).rejects.toBeInstanceOf(ExtensionStartConsentRequiredError);
    await settlePendingExtensionStarts({ sessionId: "s1", attended: true });
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it("never reconnects the old config of a server edited while it waited", async () => {
    const manager = await makeManager();
    const edited: McpServerConfig = { ...SERVER, url: "https://example.org/mcp" };
    mockConnect.mockRejectedValue(new ExtensionStartConsentRequiredError("no-backend"));
    await expect(manager.connectServer(SERVER)).rejects.toBeInstanceOf(ExtensionStartConsentRequiredError);
    await expect(manager.connectServer(edited)).rejects.toBeInstanceOf(ExtensionStartConsentRequiredError);
    mockConnect.mockResolvedValue(undefined);
    created.length = 0;
    setExtensionStartAsker({ ask: async () => "yes", notify: vi.fn() });
    await settlePendingExtensionStarts({ sessionId: "s1", attended: true });
    expect(created).toEqual([edited]);
    expect(listPendingExtensionStarts()).toEqual([]);
  });

  it("forgets the waiting start of a removed server", async () => {
    const manager = await makeManager();
    mockConnect.mockRejectedValue(new ExtensionStartConsentRequiredError("no-backend"));
    await expect(manager.connectServer(SERVER)).rejects.toBeInstanceOf(ExtensionStartConsentRequiredError);
    await manager.removeConfig(SERVER.id);
    expect(listPendingExtensionStarts()).toEqual([]);
    const ask = vi.fn(async () => "yes" as const);
    setExtensionStartAsker({ ask, notify: vi.fn() });
    await settlePendingExtensionStarts({ sessionId: "s1", attended: true });
    expect(ask).not.toHaveBeenCalled();
    expect(mockConnect).toHaveBeenCalledTimes(1);
  });

  it("does not queue any other connect failure", async () => {
    const manager = await makeManager();
    mockConnect.mockRejectedValue(new Error("connection refused"));
    await expect(manager.connectServer(SERVER)).rejects.toThrow("connection refused");
    expect(listPendingExtensionStarts()).toEqual([]);
  });
});
