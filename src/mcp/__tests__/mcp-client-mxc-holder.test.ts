/** MCP stdio servers as extension container holders (design row 5): initialize over native pipes, calls, cancellation by
 * disconnect, reconnect after verified termination, quarantine after unverified termination, env parity with the legacy
 * route and the 0.0.80 fallback. The holder adapter is mocked; its layout has its own tests. */
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  selected: true,
  gateActive: true,
  holderSpawn: vi.fn(),
  legacySpawn: vi.fn(),
}));

vi.mock("../../sandbox/wrap-bundled-command.js", async (original) => ({
  ...await original<typeof import("../../sandbox/wrap-bundled-command.js")>(),
  isMxcExtensionBackendSelected: () => state.selected,
  spawnMxcBundledHolder: (input: unknown) => state.holderSpawn(input),
  spawnWindowsBundledProcess: (input: unknown) => state.legacySpawn(input),
}));
vi.mock("../../permissions/asrt-sandbox.js", async (original) => ({
  ...await original<typeof import("../../permissions/asrt-sandbox.js")>(),
  isPluginWorkerConfinementActive: () => state.gateActive,
  assertExtensionStartAllowed: () => undefined,
  cleanupAsrtSandboxAfterCommand: async () => undefined,
}));

const { McpClient } = await import("../mcp-client.js");
const { ToolRegistry } = await import("../../tools/registry.js");
const { unusedNetworkFetch } = await import("../../__tests__/support/network-fetch-stubs.js");
const { governanceWithPolicy, buildPolicy, stdioApproval } = await import("./test-helpers.js");
const { __resetWrappedMcpServersForTest, isMcpServerWrapped } = await import("../../permissions/sandbox-capability.js");
const { MxcHolderQuarantinedError } = await import("../../sandbox/wrap-bundled-command.js");
const { MxcProcessCleanupError } = await import("../../permissions/mxc-extension-errors.js");
const { FORWARD_ENV_KEYS } = await import("../../tools/safe-env.js");
const { setProcessPlatform } = await import("../../__tests__/support/process-platform.js");

const REAL_PLATFORM = process.platform;

type Handler = (params: unknown) => { result?: unknown; error?: { code: number; message: string } } | undefined;

/** A contained server on owned streams: reads newline-delimited JSON-RPC from stdin, answers on stdout. */
function containedServer(handlers: Record<string, Handler>) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const received: Array<{ method: string; id?: number; params?: unknown }> = [];
  let buffer = "";
  stdin.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    for (let end = buffer.indexOf("\n"); end !== -1; end = buffer.indexOf("\n")) {
      const message = JSON.parse(buffer.slice(0, end)) as { method: string; id?: number; params?: unknown };
      buffer = buffer.slice(end + 1);
      received.push(message);
      const reply = handlers[message.method]?.(message.params);
      if (message.id !== undefined && reply !== undefined) {
        queueMicrotask(() => stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, ...reply })}\n`));
      }
    }
  });
  let finish!: (value: { exitCode: number; timedOut: boolean }) => void;
  const completion = new Promise<{ exitCode: number; timedOut: boolean }>((resolve) => { finish = resolve; });
  const release = vi.fn(async () => { finish({ exitCode: 0, timedOut: false }); });
  const holder = {
    process: { id: 3, stdin, stdout, stderr, completion, dispose: vi.fn(), diagnostics: {} },
    confinement: "windows-mxc" as const,
    release,
    quarantined: false,
  };
  return { holder, received, exit: (exitCode: number) => finish({ exitCode, timedOut: false }) };
}

const LEGACY_HANDSHAKE: Record<string, Handler> = {
  "server/discover": () => ({ error: { code: -32601, message: "Method not found" } }),
  initialize: () => ({ result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "fs", version: "1" } } }),
  "tools/list": () => ({ result: { tools: [{ name: "read", description: "read", inputSchema: { type: "object" } }] } }),
  "tools/call": () => ({ result: { content: [{ type: "text", text: "contained ok" }] } }),
};

function client(overrides: Record<string, unknown> = {}) {
  const config = {
    id: "fs", transport: "stdio" as const, command: "ave-mcp-fs", args: ["--root", "C:\\data"],
    sandboxRoot: "C:\\ave\\mcp\\fs\\sandbox", env: { FS_MODE: "ro" }, apiKey: "k-123", apiKeyEnv: "FS_TOKEN", ...overrides,
  };
  const approval = stdioApproval(config.id, config.command, { requiredAuth: "api-key", apiKeyEnv: "FS_TOKEN" });
  return new McpClient(config, governanceWithPolicy(buildPolicy([approval])), new ToolRegistry(), unusedNetworkFetch);
}

beforeEach(() => {
  setProcessPlatform("win32");
  state.selected = true;
  state.gateActive = true;
  state.holderSpawn.mockReset();
  state.legacySpawn.mockReset();
  __resetWrappedMcpServersForTest();
});

afterEach(() => {
  setProcessPlatform(REAL_PLATFORM);
  __resetWrappedMcpServersForTest();
});

describe("contained MCP stdio server", () => {
  it("initializes over native pipes, calls a tool and reports confinement only after a framed reply", async () => {
    const server = containedServer(LEGACY_HANDSHAKE);
    state.holderSpawn.mockImplementation(async () => {
      // Opened, not yet confirmed: no reply has crossed the native pipes.
      expect(isMcpServerWrapped("fs")).toBe(false);
      return server.holder;
    });
    const mcp = client();
    await mcp.connect();
    expect(server.received.map((message) => message.method)).toEqual(["server/discover", "initialize", "notifications/initialized", "tools/list"]);
    expect(isMcpServerWrapped("fs")).toBe(true);
    const output = await mcp.callTool("read", { path: "a" });
    expect(JSON.stringify(output)).toContain("contained ok");
    expect(state.holderSpawn.mock.calls[0]![0]).toMatchObject({ label: "mcp:fs", command: "ave-mcp-fs", args: ["--root", "C:\\data"],
      allowRead: [], allowWrite: ["C:\\ave\\mcp\\fs\\sandbox"], ownedReadRoots: [],
      egressOwner: { kind: "worker", role: "mcp-server", pluginId: undefined, instanceId: "fs" } });
    expect(state.legacySpawn).not.toHaveBeenCalled();
    await mcp.disconnect();
    expect(server.holder.release).toHaveBeenCalledTimes(1);
    expect(isMcpServerWrapped("fs")).toBe(false);
  });

  it("passes a configured cwd and plugin roots to the holder without widening them", async () => {
    const server = containedServer(LEGACY_HANDSHAKE);
    state.holderSpawn.mockResolvedValue(server.holder);
    const mcp = client({ cwd: "C:\\ave\\plugins\\fs\\gen", pluginDataDir: "C:\\ave\\plugins\\fs\\data", bundledPayloadRoot: "C:\\ave\\plugins\\fs\\gen" });
    await mcp.connect();
    expect(state.holderSpawn.mock.calls[0]![0]).toMatchObject({ cwd: "C:\\ave\\plugins\\fs\\gen",
      allowRead: ["C:\\ave\\plugins\\fs\\gen"], ownedReadRoots: ["C:\\ave\\plugins\\fs\\gen"],
      allowWrite: ["C:\\ave\\mcp\\fs\\sandbox", "C:\\ave\\plugins\\fs\\data"] });
    await mcp.disconnect();
  });

  it("cancels in-flight calls on disconnect, disposes the container and never replays them", async () => {
    const server = containedServer({ ...LEGACY_HANDSHAKE, "tools/call": () => undefined });
    state.holderSpawn.mockResolvedValue(server.holder);
    const mcp = client();
    await mcp.connect();
    const pending = mcp.callTool("read", {});
    await vi.waitFor(() => expect(server.received.some((message) => message.method === "tools/call")).toBe(true));
    await mcp.disconnect();
    await expect(pending).rejects.toThrow();
    expect(server.holder.release).toHaveBeenCalledTimes(1);
    const next = containedServer(LEGACY_HANDSHAKE);
    state.holderSpawn.mockResolvedValue(next.holder);
    await mcp.connect();
    expect(next.received.some((message) => message.method === "tools/call")).toBe(false);
    await mcp.disconnect();
  });

  it("reconnects as a new incarnation after an unexpected exit, once the old one is verified dead", async () => {
    const first = containedServer(LEGACY_HANDSHAKE);
    let finishRelease!: () => void;
    first.holder.release.mockImplementation(() => new Promise<void>((resolve) => { finishRelease = resolve; }));
    state.holderSpawn.mockResolvedValueOnce(first.holder);
    const mcp = client();
    await mcp.connect();
    first.exit(1);
    await vi.waitFor(() => expect(first.holder.release).toHaveBeenCalled());
    expect(isMcpServerWrapped("fs")).toBe(false);
    const second = containedServer(LEGACY_HANDSHAKE);
    state.holderSpawn.mockResolvedValueOnce(second.holder);
    const reconnect = mcp.connect();
    await new Promise((resolve) => setTimeout(resolve, 10));
    // The replacement waits for the previous container's termination.
    expect(state.holderSpawn).toHaveBeenCalledTimes(1);
    finishRelease();
    await reconnect;
    expect(state.holderSpawn).toHaveBeenCalledTimes(2);
    expect(isMcpServerWrapped("fs")).toBe(true);
    await mcp.disconnect();
  });

  it("refuses reconnect after an unverified termination and keeps it quarantined", async () => {
    const server = containedServer(LEGACY_HANDSHAKE);
    server.holder.release.mockRejectedValue(new MxcProcessCleanupError("death unverified"));
    state.holderSpawn.mockResolvedValue(server.holder);
    const mcp = client({ id: "fs-q" });
    await mcp.connect().catch(() => undefined);
    await mcp.disconnect();
    await expect(mcp.connect()).rejects.toBeInstanceOf(MxcHolderQuarantinedError);
    await expect(mcp.connect()).rejects.toThrow(/could not be confirmed stopped/u);
    expect(state.holderSpawn).toHaveBeenCalledTimes(1);
  });

  it("refuses a bash-form server before admission", async () => {
    const mcp = client({ command: "bash" });
    await expect(mcp.connect()).rejects.toThrow(/Git Bash cannot start/u);
    expect(state.holderSpawn).not.toHaveBeenCalled();
  });

  it("gives the container the same host-owned variables the legacy route passes", async () => {
    const server = containedServer(LEGACY_HANDSHAKE);
    state.holderSpawn.mockResolvedValue(server.holder);
    const contained = client();
    await contained.connect();
    await contained.disconnect();
    const holderInput = state.holderSpawn.mock.calls[0]![0] as { holderEnv: Record<string, string>; baseEnv: Record<string, string | undefined> };
    state.selected = false;
    state.legacySpawn.mockRejectedValue(new Error("legacy route reached"));
    await expect(client().connect()).rejects.toThrow("legacy route reached");
    const legacy = (state.legacySpawn.mock.calls[0]![0] as { baseEnv: Record<string, string | undefined> }).baseEnv;
    const forwarded = new Set<string>(FORWARD_ENV_KEYS.map((key) => key.toUpperCase()));
    const hostOwned = Object.fromEntries(Object.entries(legacy).filter(([key, value]) => value !== undefined && !forwarded.has(key.toUpperCase())));
    expect(holderInput.holderEnv).toEqual(hostOwned);
    expect(holderInput.holderEnv).toMatchObject({ FS_MODE: "ro", FS_TOKEN: "k-123" });
    expect(holderInput.baseEnv).toEqual(legacy);
  });
});

describe("pinned 0.0.80 fallback and other platforms", () => {
  it("keeps the srt-win relay route when the container backend is not selected", async () => {
    state.selected = false;
    state.legacySpawn.mockRejectedValue(new Error("legacy route reached"));
    await expect(client().connect()).rejects.toThrow("legacy route reached");
    expect(state.legacySpawn.mock.calls[0]![0]).toMatchObject({ label: "mcp:fs", allowWrite: ["C:\\ave\\mcp\\fs\\sandbox"] });
    expect(state.holderSpawn).not.toHaveBeenCalled();
  });

  it.each(["darwin", "linux"] as const)("never takes the container route on %s", async (platform) => {
    setProcessPlatform(platform);
    state.selected = false;
    state.gateActive = false;
    // The plain spawn of a missing program fails; the point is that neither holder route ran.
    await client({ command: "ave-mcp-missing-binary" }).connect().catch(() => undefined);
    expect(state.holderSpawn).not.toHaveBeenCalled();
    expect(state.legacySpawn).not.toHaveBeenCalled();
  });
});
