// Every settings path that changes a provider address must refresh sandbox network configuration.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { resolve } from "node:path";
import { installNativeChatWindow, invokeNativeChatHandler } from "../../../__tests__/support/native-chat-window.js";
import {
  makeAppIpcInvoker,
} from "./test-helpers.js";

const handlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    }),
  },
  app: { getPath: vi.fn(() => "/tmp"), getName: vi.fn(() => "ave") },
}));

vi.mock("../../../boot/dev-flags.js", () => ({
  getIsPackaged: vi.fn(() => false),
  isPackagedElectronProcess: vi.fn(() => false),
  isE2eTestRuntime: vi.fn(() => false),
}));

vi.mock("../../../engine/conversation-loop.js", () => ({}), { virtual: true });

const invoke = makeAppIpcInvoker(handlers);

describe("ASRT choke-point 1 — ave:settings:update (settings.ts)", () => {
  beforeEach(async () => {
    handlers.clear();
    vi.resetModules();
    const { configureHostResources } = await import("../../../main/host-resources.js");
    configureHostResources({ resourcePath: resolve("resources"), isPackaged: false });
  });

  function makeSettingsDeps(initialBaseUrl: string | null, newBaseUrl: string | null) {
    let currentBaseUrl = initialBaseUrl;
    const refreshSandboxNetworkConfig = vi.fn();
    const deps = {
      settingsService: {
        getAll: vi.fn(() => ({ llm: { provider: "openai", activeChatRuntime: { kind: "api" }, vendors: {} }, appearance: {} })),
        get: vi.fn((key: string) => {
          if (key === "llm") {
            return {
              provider: "openai",
              activeChatRuntime: { kind: "api" },
              vendors: { openai: { baseUrl: currentBaseUrl } },
            };
          }
          if (key === "marketplace") return {};
          return {};
        }),
        patch: vi.fn(async () => {
          currentBaseUrl = newBaseUrl;
          return { ok: true };
        }),
        replaceLlm: vi.fn(async () => {}),
        getSecret: vi.fn(() => null),
        hasStoredSecret: vi.fn(() => false),
        setSecret: vi.fn(async () => {}),
        deleteSecret: vi.fn(async () => {}),
      },
      conversationLoop: { refreshProvider: vi.fn() },
      auditLogger: { log: vi.fn() },
      getAppWindows: vi.fn(() => []),
      rewireReviewerAgent: vi.fn(),
      refreshActiveLlmWildcard: vi.fn(),
      refreshSandboxNetworkConfig,
    };
    return { deps, refreshSandboxNetworkConfig };
  }

  it("calls refreshSandboxNetworkConfig when a vendor baseUrl changes", async () => {
    const { deps, refreshSandboxNetworkConfig } = makeSettingsDeps(
      "https://old.openai.azure.com",
      "https://new.openai.azure.com",
    );
    const { registerSettingsHandlers } = await import("../settings.js");
    registerSettingsHandlers(deps as never);

    await invoke("ave:settings:update", {
      llm: { vendors: { openai: { baseUrl: "https://new.openai.azure.com" } } },
    });

    expect(refreshSandboxNetworkConfig).toHaveBeenCalledTimes(1);
  });

  it("does NOT call refreshSandboxNetworkConfig when baseUrl is unchanged", async () => {
    const { deps, refreshSandboxNetworkConfig } = makeSettingsDeps(
      "https://same.openai.azure.com",
      "https://same.openai.azure.com",
    );
    const { registerSettingsHandlers } = await import("../settings.js");
    registerSettingsHandlers(deps as never);

    await invoke("ave:settings:update", {
      llm: { vendors: { openai: { model: "gpt-4o" } } },
    });

    expect(refreshSandboxNetworkConfig).not.toHaveBeenCalled();
  });
});

describe("ASRT choke-point 2 — marketplace provider preset mutations (settings.ts)", () => {
  beforeEach(async () => {
    handlers.clear();
    vi.resetModules();
    const { configureHostResources } = await import("../../../main/host-resources.js");
    configureHostResources({ resourcePath: resolve("resources"), isPackaged: false });
  });

  const preset = {
    providerId: "future-router",
    label: "Future Router",
    baseUrl: "https://future.example/v1",
    defaultModel: "future/free",
    modelOptions: ["future/free"],
    requiresApiKey: true,
  };

  function makePresetDeps() {
    let presets: Array<typeof preset> = [preset];
    let presetId: string | undefined = "future-router";
    const refreshSandboxNetworkConfig = vi.fn();
    const deps = {
      settingsService: {
        getAll: vi.fn(() => ({ llm: { provider: "openai-compatible", activeChatRuntime: { kind: "api" }, vendors: {} }, appearance: {} })),
        get: vi.fn((key: string) => {
          if (key === "llm") {
            return {
              provider: "openai-compatible",
              activeChatRuntime: { kind: "api" },
              ...(presetId ? { marketplaceProviderPresetId: presetId } : {}),
              vendors: { "openai-compatible": {} },
            };
          }
          if (key === "marketplace") {
            return { installedProviderPresets: presets };
          }
          return {};
        }),
        uninstallMarketplaceProviderPreset: vi.fn(async () => {
          presets = [];
          presetId = undefined;
          return { ok: true };
        }),
        patch: vi.fn(async () => ({ ok: true })),
        replaceLlm: vi.fn(async () => {}),
        getSecret: vi.fn(() => null),
        hasStoredSecret: vi.fn(() => false),
        setSecret: vi.fn(async () => {}),
        deleteSecret: vi.fn(async () => {}),
      },
      conversationLoop: { refreshProvider: vi.fn() },
      auditLogger: { log: vi.fn() },
      getAppWindows: vi.fn(() => []),
      rewireReviewerAgent: vi.fn(),
      refreshActiveLlmWildcard: vi.fn(),
      refreshSandboxNetworkConfig,
    };
    return { deps, refreshSandboxNetworkConfig };
  }

  it("calls refreshSandboxNetworkConfig when the active preset is uninstalled", async () => {
    // Capture the pre-mutation registry signature or uninstall loses the old host from both comparisons.
    const { deps, refreshSandboxNetworkConfig } = makePresetDeps();
    const { registerSettingsHandlers } = await import("../settings.js");
    registerSettingsHandlers(deps as never);

    await invoke("ave:settings:marketplace:uninstall-provider-preset", "future-router");

    expect(refreshSandboxNetworkConfig).toHaveBeenCalledTimes(1);
  });
});

describe("ASRT choke-point 3 — ave:chat:retry-effort (chat.ts)", () => {
  beforeEach(async () => {
    handlers.clear();
    vi.resetModules();
    const { configureHostResources } = await import("../../../main/host-resources.js");
    configureHostResources({ resourcePath: resolve("resources"), isPackaged: false });
  });

  function makeChatDeps(baseUrl: string | undefined = undefined) {
    const refreshSandboxNetworkConfig = vi.fn();
    const currentBlock = { model: "gpt-4o", baseUrl } as Record<string, unknown>;
    const deps = {
      settingsService: {
        get: vi.fn((key: string) => {
          if (key === "llm") {
            return { provider: "openai", activeChatRuntime: { kind: "api" }, vendors: { openai: currentBlock } };
          }
          return {};
        }),
        patch: vi.fn(async () => {}),
        getAll: vi.fn(() => ({})),
        getSecret: vi.fn(() => null),
        hasStoredSecret: vi.fn(() => false),
      },
      conversationLoop: {
        refreshProvider: vi.fn(),
        hasProvider: vi.fn(() => true),
        getSessionId: vi.fn(() => "test-session"),
        getHistory: vi.fn(() => ({
          getMessages: vi.fn(() => [
            { role: "user", content: "hello" },
          ]),
          restore: vi.fn(),
          truncate: vi.fn(),
        })),
        streamTurn: vi.fn(async () => ({ ok: true })),
        runTurn: vi.fn(async () => ({ text: "", toolCalls: [], route: "chat" })),
        getActivePersonaId: vi.fn(() => null),
        getSessionKind: vi.fn(),
      },
      personaPromptStore: { getById: vi.fn(() => null) },
      auditLogger: { log: vi.fn() },
      getAppWindows: vi.fn(() => []),
      getMainWindow: vi.fn(() => null),
      memoryManager: { getSessionKind: vi.fn(() => "main") },
      starredStore: undefined,
      feedbackStore: undefined,
      rewireReviewerAgent: vi.fn(),
      refreshActiveLlmWildcard: vi.fn(),
      refreshSandboxNetworkConfig,
    };
    return { deps, refreshSandboxNetworkConfig };
  }

  it("does NOT call refreshSandboxNetworkConfig when retry-effort leaves baseUrl unchanged", async () => {
    const { deps, refreshSandboxNetworkConfig } = makeChatDeps("https://same.openai.azure.com");

    const { registerChatHandlers } = await import("../chat.js");
    await installNativeChatWindow();
    registerChatHandlers(deps as never);

    // An unchanged provider address must not trigger sandbox network refresh. The retry runs from a real app window with the
    // click's consumed gesture, so it reaches the settings patch this choke point guards.
    await invokeNativeChatHandler(handlers, "ave:chat:retry-effort", { enableThinking: true, thinkingBudgetTokens: 10000 }, "main", {
      inputOrigin: "user-keyboard", userActivation: true,
    });

    expect(deps.settingsService.patch).toHaveBeenCalled();
    expect(refreshSandboxNetworkConfig).not.toHaveBeenCalled();
  });
});
