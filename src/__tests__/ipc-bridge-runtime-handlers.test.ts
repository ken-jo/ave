/** Invoke captured runtime IPC handlers with synthetic sender events. */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fakeLlmSettings } from "../shared/__tests__/fake-llm-settings.js";
import {
  makeMockApprovalGate,
  makeMockConversationLoop,
  makeMockPermissionManager,
  invokeRegisteredHandler,
  invokeRegisteredHandlerWithEvent,
  untrustedEvent,
} from "./test-helpers.js";
import { unusedNetworkFetch } from "./support/network-fetch-stubs.js";

const handlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock("electron", () => ({
  protocol: { handle: vi.fn() },
  ipcMain: {
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    }),
  },
}));

const mockLoadPolicy = vi.fn();
const mockSavePolicy = vi.fn();

vi.mock("../permissions/policy-store.js", () => ({
  loadPolicy: mockLoadPolicy,
  savePolicy: mockSavePolicy,
}));

function makeServices(
  pm = makeMockPermissionManager(),
  gate = makeMockApprovalGate(),
  overrides: {
    toolRegistrySize?: number;
    pluginIds?: string[];
    mcpServers?: Array<{ status: string }>;
  } = {},
) {
  const toolRegistrySize = overrides.toolRegistrySize ?? 5;
  const pluginIds = overrides.pluginIds ?? ["meeting", "email"];
  const mcpServers = overrides.mcpServers ?? [
    { status: "connected" },
    { status: "connected" },
    { status: "disconnected" },
  ];

  return {
    pluginRuntime: {
      call: vi.fn(),
      listToolNames: vi.fn(() => []),
      listPluginIds: vi.fn(() => pluginIds),
      listPluginCards: vi.fn(() => []),
      restartAll: vi.fn(),
      setConfigOverride: vi.fn(),
      listUiExtensions: vi.fn(() => []),
    } as any,
    pluginMarketplace: { list: vi.fn(), install: vi.fn(), uninstall: vi.fn() } as any,
    settingsService: {
      getAll: vi.fn(),
      patch: vi.fn(),
      get: vi.fn((key: string) => {
        if (key === "marketplace") return {};
        return fakeLlmSettings();
      }),
      getSecret: vi.fn(),
      setSecret: vi.fn(),
      deleteSecret: vi.fn(),
      getPluginConfig: vi.fn(() => ({})),
      setPluginConfig: vi.fn(async (_pluginId: string, config: unknown) => config),
    } as any,
    memoryManager: {
      listMemoryEntries: vi.fn(() => []),
      saveMemory: vi.fn(),
      deleteMemory: vi.fn(),
      searchMemoryEntries: vi.fn(() => []),
      getMemoryContext: vi.fn(() => ""),
      getUserPreferences: vi.fn(),
      updateUserPreferences: vi.fn(),
    } as any,
    conversationLoop: makeMockConversationLoop(pm) as any,
    approvalGate: gate as any,
    mcpManager: { listServers: vi.fn(() => mcpServers), killSwitch: vi.fn(), setPackageTransactionProbe: vi.fn() } as any,
    toolRegistry: {
      setDenyRules: vi.fn(),
      size: toolRegistrySize,
      // Counts include model-visible tools, excluding app-only tools.
      getModelVisibleTools: () => Array.from({ length: toolRegistrySize }, () => ({})),
    } as any,
    auditLogger: { log: vi.fn() } as any,
    // A throwing transport makes unexpected network requests fail locally.
    singleHopNetworkFetch: unusedNetworkFetch,
    idleScheduler: undefined,
    bashAstValidator: {} as any,
    auditService: {} as any,
    postTurnHookChain: {} as any,
  };
}

async function setupHandlers(
  pm = makeMockPermissionManager(),
  gate = makeMockApprovalGate(),
  serviceOverrides: Parameters<typeof makeServices>[2] = {},
) {
  handlers.clear();
  vi.clearAllMocks();
  const { registerIpcHandlers } = await import("../ipc-bridge.js");
  registerIpcHandlers(makeServices(pm, gate, serviceOverrides), () => null);
  return { pm, gate };
}

describe("ave:runtime:counts", () => {
  it("returns { tools, plugins, mcps } with correct numeric values", async () => {
    await setupHandlers(makeMockPermissionManager(), makeMockApprovalGate(), {
      toolRegistrySize: 7,
      pluginIds: ["meeting", "email", "calendar"],
      mcpServers: [
        { status: "connected" },
        { status: "connected" },
        { status: "disconnected" },
        { status: "connected" },
      ],
    });

    const result = await invokeRegisteredHandler(handlers, "ave:runtime:counts") as {
      tools: number;
      plugins: number;
      mcps: number;
    };

    expect(result.tools).toBe(7);
    expect(result.plugins).toBe(3);
    expect(result.mcps).toBe(3);
  });

  it("rejects unauthorized sender frames", async () => {
    await setupHandlers();

    const result = await invokeRegisteredHandlerWithEvent(handlers,
      "ave:runtime:counts",
      untrustedEvent(),
    );

    expect(result).toEqual({ ok: false, error: "unauthorized-frame" });
  });
});

describe("ave:runtime:env", () => {
  it("returns { platform, hostname, user } — no cwd, no release", async () => {
    await setupHandlers();

    const result = await invokeRegisteredHandler(handlers, "ave:runtime:env") as Record<string, unknown>;

    expect(typeof result.platform).toBe("string");
    expect(result.platform).toBeTruthy();
    expect(typeof result.hostname).toBe("string");
    expect(result.hostname).toBeTruthy();
    expect(typeof result.user).toBe("string");
    expect(result.user).toBeTruthy();

    expect(result).not.toHaveProperty("cwd");
    expect(result).not.toHaveProperty("release");
  });

  it("rejects unauthorized sender frames", async () => {
    await setupHandlers();

    const result = await invokeRegisteredHandlerWithEvent(handlers,
      "ave:runtime:env",
      untrustedEvent(),
    );

    expect(result).toEqual({ ok: false, error: "unauthorized-frame" });
  });
});

describe("new runtime handlers — all reject unauthorized frames", () => {
  const channels = [
    "ave:runtime:counts",
    "ave:runtime:env",
  ] as const;

  beforeEach(async () => {
    await setupHandlers();
  });

  for (const channel of channels) {
    it(`${channel} returns UNAUTHORIZED_FRAME for a foreign origin`, async () => {
      const result = await invokeRegisteredHandlerWithEvent(handlers, channel, untrustedEvent());
      expect(result).toEqual({ ok: false, error: "unauthorized-frame" });
    });
  }
});
