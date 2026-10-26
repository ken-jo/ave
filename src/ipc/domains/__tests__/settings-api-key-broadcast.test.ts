/** MAJOR-3 regression: all 4 secret-mutation handlers broadcast SETTINGS.updated to all app windows so the reviewer tab auto-unlocks without a full reload: -
 * ave:settings:set-api-key - ave:settings:delete-api-key - ave:settings:set-web-api-key - ave:settings:delete-web-api-key - ave:settings:marketplace:set-api-key - ave:settings:marketplace:delete-api-key */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SETTINGS } from "../../../shared/ipc-channels.js";
import { makeAppIpcInvoker } from "./test-helpers.js";

const handlers = new Map<string, (...args: unknown[]) => unknown>();
const listLlmModelsFromSettingsMock = vi.hoisted(() => vi.fn());

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    }),
  },
}));
vi.mock("../../../engine/llm/model-list.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../engine/llm/model-list.js")>(),
  listLlmModelsFromSettings: listLlmModelsFromSettingsMock,
}));

// Shared fixture (test-helpers.ts); no senderFrame set, so validateSender's `!frame` early-allow applies, same as this file's former inline `invoke`.
const invoke = makeAppIpcInvoker(handlers);

function makeWindow() {
  return {
    isDestroyed: vi.fn(() => false),
    webContents: {
      isDestroyed: vi.fn(() => false),
      send: vi.fn(),
    },
  };
}

/** Main's projection for these fakes: an API route with no stored credential. */
const NO_CONNECTED_PROVIDER = { kind: "none", reason: "no-connected-provider" } as const;

function makeDeps(appWindows: ReturnType<typeof makeWindow>[], vendorBaseUrl?: string) {
  const llm = {
    provider: "openai",
    activeChatRuntime: { kind: "api" },
    vendors: { "azure-foundry": { baseUrl: vendorBaseUrl ?? null } },
  };
  const marketplace = { installedProviderIds: [] as string[] };
  return {
    settingsService: {
      getAll: vi.fn(() => ({ llm: { provider: "openai", activeChatRuntime: { kind: "api" } } })),
      get: vi.fn((key?: string) => {
        if (key === "marketplace") return marketplace;
        if (key === "shortcuts") return {};
        if (key === "system") return {};
        return llm;
      }),
      patch: vi.fn(async (p: unknown) => p),
      replaceLlm: vi.fn(async (llm: unknown) => llm),
      getSecret: vi.fn(() => null),
      hasStoredSecret: vi.fn(() => false),
      setSecret: vi.fn(async () => undefined),
      deleteSecret: vi.fn(async () => undefined),
    },
    conversationLoop: {
      refreshProvider: vi.fn(),
    },
    sideChatConversationLoop: {
      refreshProvider: vi.fn(),
    },
    auditLogger: { log: vi.fn() },
    getAppWindows: vi.fn(() => appWindows),
    // Main's Chromium-stack transport; the handler is expected to hand it to the engine rather than let the engine reach for ambient `fetch`.
    singleHopNetworkFetch: vi.fn() as unknown as typeof fetch,
  };
}

beforeEach(() => {
  handlers.clear();
  listLlmModelsFromSettingsMock.mockReset();
  listLlmModelsFromSettingsMock.mockResolvedValue({ ok: true, models: [], endpoint: "", fetchedAt: "" });
  vi.resetModules();
});

describe("set-api-key broadcast (M3)", () => {
  it("broadcasts SETTINGS.updated to all app windows after storing the key", async () => {
    const windows = [makeWindow(), makeWindow()];
    const deps = makeDeps(windows);
    const snapshot = { llm: { provider: "openai", activeChatRuntime: { kind: "api" } } };
    deps.settingsService.getAll.mockReturnValue(snapshot);

    const { registerSettingsHandlers } = await import("../settings.js");
    registerSettingsHandlers(deps as never);

    await invoke("ave:settings:set-api-key", "claude", "sk-ant-test");

    expect(deps.settingsService.setSecret).toHaveBeenCalledWith("llm.apiKey.claude", "sk-ant-test");
    expect(deps.conversationLoop.refreshProvider).toHaveBeenCalled();
    expect(deps.sideChatConversationLoop.refreshProvider).toHaveBeenCalled();
    for (const win of windows) {
      expect(win.webContents.send).toHaveBeenCalledWith(SETTINGS.updated, { ...snapshot, activeChatModel: NO_CONNECTED_PROVIDER });
    }
  });

  it("broadcasts to all windows, skipping destroyed ones via sendToWindow", async () => {
    const liveWindow = makeWindow();
    const deadWindow = makeWindow();
    deadWindow.isDestroyed.mockReturnValue(true);
    const deps = makeDeps([liveWindow, deadWindow]);

    const { registerSettingsHandlers } = await import("../settings.js");
    registerSettingsHandlers(deps as never);

    await invoke("ave:settings:set-api-key", "gemini", "gemini-key");

    // live window gets the broadcast; destroyed window is skipped by sendToWindow
    expect(liveWindow.webContents.send).toHaveBeenCalledWith(SETTINGS.updated, expect.anything());
    expect(deadWindow.webContents.send).not.toHaveBeenCalled();
  });

  it("accepts API keys for a bundled provider without a marketplace install", async () => {
    const deps = makeDeps([]);

    const { registerSettingsHandlers } = await import("../settings.js");
    registerSettingsHandlers(deps as never);

    const result = await invoke("ave:settings:set-api-key", "groq", "gsk-test");

    expect(result).toEqual({ ok: true });
    expect(deps.settingsService.setSecret).toHaveBeenCalledWith("llm.apiKey.groq", "gsk-test");
  });

  it("accepts API keys for installed marketplace providers", async () => {
    const deps = makeDeps([]);
    deps.settingsService.get.mockImplementation((key?: string) => {
      if (key === "marketplace") return { installedProviderIds: ["groq"] };
      if (key === "shortcuts") return {};
      if (key === "system") return {};
      return {
        provider: "openai",
        activeChatRuntime: { kind: "api" },
        vendors: { "azure-foundry": { baseUrl: null } },
      };
    });

    const { registerSettingsHandlers } = await import("../settings.js");
    registerSettingsHandlers(deps as never);

    const result = await invoke("ave:settings:set-api-key", "groq", "gsk-test");

    expect(result).toEqual({ ok: true });
    expect(deps.settingsService.setSecret).toHaveBeenCalledWith("llm.apiKey.groq", "gsk-test");
  });

  it("rejects model list sync for unknown providers", async () => {
    const deps = makeDeps([]);

    const { registerSettingsHandlers } = await import("../settings.js");
    registerSettingsHandlers(deps as never);

    const result = await invoke("ave:settings:list-llm-models", {
      vendor: "not-a-provider",
    });

    expect(result).toMatchObject({ ok: false, error: "invalid-provider" });
  });
});

describe("delete-api-key broadcast (MAJOR-3)", () => {
  it("broadcasts SETTINGS.updated to all app windows after deleting the key", async () => {
    const windows = [makeWindow(), makeWindow()];
    const deps = makeDeps(windows);
    const snapshot = { llm: { provider: "openai", activeChatRuntime: { kind: "api" } } };
    deps.settingsService.getAll.mockReturnValue(snapshot);

    const { registerSettingsHandlers } = await import("../settings.js");
    registerSettingsHandlers(deps as never);

    await invoke("ave:settings:delete-api-key", "gemini");

    expect(deps.settingsService.deleteSecret).toHaveBeenCalledWith("llm.apiKey.gemini");
    expect(deps.conversationLoop.refreshProvider).toHaveBeenCalled();
    expect(deps.sideChatConversationLoop.refreshProvider).toHaveBeenCalled();
    for (const win of windows) {
      expect(win.webContents.send).toHaveBeenCalledWith(SETTINGS.updated, { ...snapshot, activeChatModel: NO_CONNECTED_PROVIDER });
    }
  });

  it("deletes API keys for installed marketplace provider presets", async () => {
    const deps = makeDeps([]);
    deps.settingsService.get.mockImplementation((key?: string) => {
      if (key === "marketplace") {
        return {
          installedProviderPresets: [{
            providerId: "future-router",
            label: "Future Router",
            baseUrl: "https://future.example/v1",
            defaultModel: "future/free",
            modelOptions: ["future/free"],
            requiresApiKey: true,
          }],
        };
      }
      if (key === "shortcuts") return {};
      if (key === "system") return {};
      return {
        provider: "openai",
        activeChatRuntime: { kind: "api" },
        vendors: { "azure-foundry": { baseUrl: null } },
      };
    });

    const { registerSettingsHandlers } = await import("../settings.js");
    registerSettingsHandlers(deps as never);

    const result = await invoke(
      "ave:settings:delete-api-key",
      "marketplace-provider:future-router",
    );

    expect(result).toEqual({ ok: true });
    expect(deps.settingsService.deleteSecret).toHaveBeenCalledWith(
      "llm.marketplaceProvider.future-router.apiKey",
    );
  });

  it("rejects API key deletion for uninstalled inactive marketplace provider presets", async () => {
    const deps = makeDeps([]);

    const { registerSettingsHandlers } = await import("../settings.js");
    registerSettingsHandlers(deps as never);

    const result = await invoke(
      "ave:settings:delete-api-key",
      "marketplace-provider:ghost-router",
    );

    expect(result).toMatchObject({ ok: false, error: "unknown-provider" });
    expect(deps.settingsService.deleteSecret).not.toHaveBeenCalled();
  });
});

describe("set-web-api-key broadcast (MAJOR-3)", () => {
  it("broadcasts SETTINGS.updated to all app windows after storing the web key", async () => {
    const windows = [makeWindow(), makeWindow()];
    const deps = makeDeps(windows);
    const snapshot = { llm: { provider: "openai", activeChatRuntime: { kind: "api" } } };
    deps.settingsService.getAll.mockReturnValue(snapshot);

    const { registerSettingsHandlers } = await import("../settings.js");
    registerSettingsHandlers(deps as never);

    await invoke("ave:settings:set-web-api-key", "bing", "bing-key-123");

    expect(deps.settingsService.setSecret).toHaveBeenCalledWith("web.apiKey.bing", "bing-key-123");
    for (const win of windows) {
      expect(win.webContents.send).toHaveBeenCalledWith(SETTINGS.updated, { ...snapshot, activeChatModel: NO_CONNECTED_PROVIDER });
    }
  });
});

describe("delete-web-api-key broadcast (MAJOR-3)", () => {
  it("broadcasts SETTINGS.updated to all app windows after deleting the web key", async () => {
    const windows = [makeWindow(), makeWindow()];
    const deps = makeDeps(windows);
    const snapshot = { llm: { provider: "openai", activeChatRuntime: { kind: "api" } } };
    deps.settingsService.getAll.mockReturnValue(snapshot);

    const { registerSettingsHandlers } = await import("../settings.js");
    registerSettingsHandlers(deps as never);

    await invoke("ave:settings:delete-web-api-key", "bing");

    expect(deps.settingsService.deleteSecret).toHaveBeenCalledWith("web.apiKey.bing");
    for (const win of windows) {
      expect(win.webContents.send).toHaveBeenCalledWith(SETTINGS.updated, { ...snapshot, activeChatModel: NO_CONNECTED_PROVIDER });
    }
  });
});

describe("marketplace provider preset runtime refresh", () => {
  it("refreshes both chat runtime providers after installing a provider preset", async () => {
    const windows: ReturnType<typeof makeWindow>[] = [];
    const baseDeps = makeDeps(windows);
    const deps = {
      ...baseDeps,
      settingsService: {
        ...baseDeps.settingsService,
        installMarketplaceProviderPreset: vi.fn(async () => ({ ok: true })),
      },
    };

    const { registerSettingsHandlers } = await import("../settings.js");
    registerSettingsHandlers(deps as never);

    await expect(invoke("ave:settings:marketplace:install-provider-preset", {
      providerId: "router-a",
      label: "Router A",
      baseUrl: "https://router.example/v1",
      defaultModel: "router/default",
      modelOptions: ["router/default"],
      requiresApiKey: true,
    })).resolves.toEqual({ ok: true });

    expect(deps.conversationLoop.refreshProvider).toHaveBeenCalledOnce();
    expect(deps.sideChatConversationLoop.refreshProvider).toHaveBeenCalledOnce();
  });
});
// ─── MAJOR-2 R2: settings:update triggers rewireReviewerAgent when baseUrl changes ──

describe("MAJOR-2: settings:update triggers rewireReviewerAgent on azure-foundry baseUrl change", () => {
  it("lets the settings chooser see saved credential presence without reading its value while retirement is unresolved", async () => {
    const deps = makeDeps([]);
    deps.settingsService.get.mockImplementation((key?: string) => key === "llm"
      ? { provider: "openai", activeChatRuntime: { kind: "api" }, retiredProvider: "copilot", vendors: {} } as never
      : {} as never);
    const hasStoredSecret = vi.fn(() => true);
    const { registerSettingsHandlers } = await import("../settings.js");
    registerSettingsHandlers({ ...deps, settingsService: { ...deps.settingsService, hasStoredSecret } } as never);
    expect(await invoke("ave:settings:has-api-key", "openai")).toBe(true);
    expect(hasStoredSecret).toHaveBeenCalledWith("llm.apiKey.openai");
    expect(deps.settingsService.getSecret).not.toHaveBeenCalled();
  });
  it("rewires the reviewer when the retirement marker clears without changing provider or model", async () => {
    const rewire = vi.fn();
    const baseDeps = makeDeps([]);
    const nextLlm = { provider: "openai", activeChatRuntime: { kind: "api" }, vendors: { openai: { model: "gpt-4o" } } };
    const previousLlm = { ...nextLlm, retiredProvider: "copilot" };
    let saved = false;
    const deps = {
      ...baseDeps,
      settingsService: {
        ...baseDeps.settingsService,
        get: vi.fn((key?: string) => key === "llm" ? (saved ? nextLlm : previousLlm) : {}),
        patch: vi.fn(async () => { saved = true; return { llm: nextLlm }; }),
      },
      rewireReviewerAgent: rewire,
    };
    const { registerSettingsHandlers } = await import("../settings.js");
    registerSettingsHandlers(deps as never);
    await invoke("ave:settings:update", { llm: { provider: "openai" } });
    expect(rewire).toHaveBeenCalledOnce();
    expect(deps.conversationLoop.refreshProvider).toHaveBeenCalledOnce();
  });
  it("calls rewireReviewerAgent when the active LLM provider changes", async () => {
    const windows: ReturnType<typeof makeWindow>[] = [];
    const rewire = vi.fn();
    const prevLlm = {
      provider: "openai",
      activeChatRuntime: { kind: "api" },
      vendors: {
        openai: { model: "gpt-4o" },
        claude: { model: "claude-sonnet-4-6" },
        "azure-foundry": { baseUrl: null },
      },
    };
    const nextLlm = {
      provider: "claude",
      activeChatRuntime: { kind: "api" },
      vendors: {
        openai: { model: "gpt-4o" },
        claude: { model: "claude-sonnet-4-6" },
        "azure-foundry": { baseUrl: null },
      },
    };
    let llmReads = 0;
    const baseDeps = makeDeps(windows);
    const deps = {
      ...baseDeps,
      settingsService: {
        ...baseDeps.settingsService,
        get: vi.fn((key: string) => {
          if (key === "marketplace") return {};
          llmReads += 1;
          return llmReads === 1 ? prevLlm : nextLlm;
        }),
        patch: vi.fn(async (p: unknown) => p),
      },
      rewireReviewerAgent: rewire,
    };

    const { registerSettingsHandlers } = await import("../settings.js");
    registerSettingsHandlers(deps as never);

    await invoke("ave:settings:update", { llm: { provider: "claude" } });

    expect(rewire).toHaveBeenCalledOnce();
    expect(deps.conversationLoop.refreshProvider).toHaveBeenCalledOnce();
    expect(deps.sideChatConversationLoop.refreshProvider).toHaveBeenCalledOnce();
  });

  it.each([
    ["rewires", "claude/claude-sonnet-4-6", 1],
    ["does not rewire", null, 0],
  ] as const)("%s when a selected reviewer model's own provider route changes (reviewer model %s)", async (_label, reviewerModel, rewires) => {
    const home = mkdtempSync(join(tmpdir(), "reviewer-route-rewire-"));
    vi.stubEnv("AVE_HOME", home);
    writeFileSync(join(home, "settings.json"), JSON.stringify({ permissions: { judge: { model: reviewerModel } } }));
    try {
      const rewire = vi.fn();
      const llm = (claudeBaseUrl: string) => ({
        provider: "openai",
        activeChatRuntime: { kind: "api" },
        vendors: { openai: { model: "gpt-4o" }, claude: { model: "claude-sonnet-4-6", baseUrl: claudeBaseUrl } },
      });
      let llmReads = 0;
      const baseDeps = makeDeps([]);
      const deps = {
        ...baseDeps,
        settingsService: {
          ...baseDeps.settingsService,
          get: vi.fn((key: string) => {
            if (key === "marketplace") return {};
            llmReads += 1;
            return llm(llmReads === 1 ? "https://claude-a.example" : "https://claude-b.example");
          }),
          patch: vi.fn(async (p: unknown) => p),
        },
        rewireReviewerAgent: rewire,
      };
      const { registerSettingsHandlers } = await import("../settings.js");
      registerSettingsHandlers(deps as never);
      await invoke("ave:settings:update", { llm: { vendors: { claude: { baseUrl: "https://claude-b.example" } } } });
      expect(rewire).toHaveBeenCalledTimes(rewires);
    } finally {
      vi.unstubAllEnvs();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it.each([
    ["adds the stage model", null, ["team-stage"], 1],
    ["removes the stage model", ["team-stage", "other-model"], ["other-model"], 1],
    ["changes an unrelated entry", ["other-model"], ["other-model", "another-model"], 0],
  ] as const)("re-wires on a catalogue sync that %s for a chain stage's own model (listing %j -> %j, rewires %i)", async (_label, before, after, rewires) => {
    const home = mkdtempSync(join(tmpdir(), "stage-catalogue-rewire-"));
    vi.stubEnv("AVE_HOME", home);
    writeFileSync(join(home, "settings.json"), JSON.stringify({
      permissions: { judge: { model: null, chain: [{ id: "stage", provider: "builtin-llm", model: "openai/team-stage" }] } },
    }));
    try {
      const rewire = vi.fn();
      const llm = (models: readonly string[] | null) => ({
        provider: "openai",
        activeChatRuntime: { kind: "api" },
        vendors: { openai: { model: "gpt-4o" } },
        ...(models ? {
          modelListCache: {
            std: { vendor: "openai", endpoint: "https://api.openai.com/v1/models", models: [...models], fetchedAt: "2026-10-23T00:00:00.000Z" },
          },
        } : {}),
      });
      let llmReads = 0;
      const baseDeps = makeDeps([]);
      const deps = {
        ...baseDeps,
        settingsService: {
          ...baseDeps.settingsService,
          get: vi.fn((key: string) => {
            if (key === "marketplace") return {};
            llmReads += 1;
            return llm(llmReads === 1 ? before : after);
          }),
          patch: vi.fn(async (p: unknown) => p),
        },
        rewireReviewerAgent: rewire,
      };
      const { registerSettingsHandlers } = await import("../settings.js");
      registerSettingsHandlers(deps as never);
      await invoke("ave:settings:update", { llm: { modelListCache: llm(after).modelListCache } });
      expect(rewire).toHaveBeenCalledTimes(rewires);
    } finally {
      vi.unstubAllEnvs();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it.each([
    ["rewires", ["team-reviewer"], 1],
    ["does not rewire", ["other-model"], 0],
  ] as const)("%s when the chat provider's synced catalogue changes a same-provider reviewer model's availability (listing %j)", async (_label, listed, rewires) => {
    const home = mkdtempSync(join(tmpdir(), "reviewer-catalogue-rewire-"));
    vi.stubEnv("AVE_HOME", home);
    writeFileSync(join(home, "settings.json"), JSON.stringify({ permissions: { judge: { model: "openai/team-reviewer" } } }));
    try {
      const rewire = vi.fn();
      const llm = (models: readonly string[] | null) => ({
        provider: "openai",
        activeChatRuntime: { kind: "api" },
        vendors: { openai: { model: "gpt-4o" } },
        ...(models ? {
          modelListCache: {
            std: { vendor: "openai", endpoint: "https://api.openai.com/v1/models", models: [...models], fetchedAt: "2026-10-23T00:00:00.000Z" },
          },
        } : {}),
      });
      let llmReads = 0;
      const baseDeps = makeDeps([]);
      const deps = {
        ...baseDeps,
        settingsService: {
          ...baseDeps.settingsService,
          get: vi.fn((key: string) => {
            if (key === "marketplace") return {};
            llmReads += 1;
            return llm(llmReads === 1 ? null : listed);
          }),
          patch: vi.fn(async (p: unknown) => p),
        },
        rewireReviewerAgent: rewire,
      };
      const { registerSettingsHandlers } = await import("../settings.js");
      registerSettingsHandlers(deps as never);
      // The chat route itself is unchanged: only the synced catalogue moves.
      await invoke("ave:settings:update", { llm: { modelListCache: llm(listed).modelListCache } });
      expect(rewire).toHaveBeenCalledTimes(rewires);
    } finally {
      vi.unstubAllEnvs();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("calls rewireReviewerAgent when the active LLM model changes", async () => {
    const windows: ReturnType<typeof makeWindow>[] = [];
    const rewire = vi.fn();
    const prevLlm = {
      provider: "openai",
      activeChatRuntime: { kind: "api" },
      vendors: {
        openai: { model: "gpt-4o" },
        "azure-foundry": { baseUrl: null },
      },
    };
    const nextLlm = {
      provider: "openai",
      activeChatRuntime: { kind: "api" },
      vendors: {
        openai: { model: "gpt-5.4" },
        "azure-foundry": { baseUrl: null },
      },
    };
    let llmReads = 0;
    const baseDeps = makeDeps(windows);
    const deps = {
      ...baseDeps,
      settingsService: {
        ...baseDeps.settingsService,
        get: vi.fn((key: string) => {
          if (key === "marketplace") return {};
          llmReads += 1;
          return llmReads === 1 ? prevLlm : nextLlm;
        }),
        patch: vi.fn(async (p: unknown) => p),
      },
      rewireReviewerAgent: rewire,
    };

    const { registerSettingsHandlers } = await import("../settings.js");
    registerSettingsHandlers(deps as never);

    await invoke("ave:settings:update", {
      llm: { vendors: { openai: { model: "gpt-5.4" } } },
    });

    expect(rewire).toHaveBeenCalledOnce();
  });

  it("calls rewireReviewerAgent when only the active marketplace provider preset changes", async () => {
    const windows: ReturnType<typeof makeWindow>[] = [];
    const rewire = vi.fn();
    const providerBlock = {
      model: "shared/free",
      baseUrl: "https://router.example/v1",
    };
    const prevLlm = {
      provider: "openai-compatible",
      activeChatRuntime: { kind: "api" },
      marketplaceProviderPresetId: "router-a",
      vendors: {
        "openai-compatible": providerBlock,
        "azure-foundry": { baseUrl: null },
      },
    };
    const nextLlm = {
      provider: "openai-compatible",
      activeChatRuntime: { kind: "api" },
      marketplaceProviderPresetId: "router-b",
      vendors: {
        "openai-compatible": providerBlock,
        "azure-foundry": { baseUrl: null },
      },
    };
    let llmReads = 0;
    const baseDeps = makeDeps(windows);
    const deps = {
      ...baseDeps,
      settingsService: {
        ...baseDeps.settingsService,
        get: vi.fn((key: string) => {
          if (key === "llm") {
            llmReads += 1;
            return llmReads === 1 ? prevLlm : nextLlm;
          }
          if (key === "marketplace") {
            return {
              installedProviderPresets: [
                {
                  providerId: "router-a",
                  label: "Router A",
                  baseUrl: "https://router.example/v1",
                  defaultModel: "shared/free",
                  modelOptions: ["shared/free"],
                  requiresApiKey: true,
                },
                {
                  providerId: "router-b",
                  label: "Router B",
                  baseUrl: "https://router.example/v1",
                  defaultModel: "shared/free",
                  modelOptions: ["shared/free"],
                  requiresApiKey: true,
                },
              ],
            };
          }
          if (key === "shortcuts") return { toggleWindow: null, enabled: false };
          if (key === "system") return { launchAtStartup: false, launchMinimized: false };
          return {};
        }),
        patch: vi.fn(async (p: unknown) => p),
      },
      rewireReviewerAgent: rewire,
    };

    const { registerSettingsHandlers } = await import("../settings.js");
    registerSettingsHandlers(deps as never);

    await invoke("ave:settings:update", {
      llm: { marketplaceProviderPresetId: "router-b" },
    });

    expect(rewire).toHaveBeenCalledOnce();
  });

  it("derives model-list discovery policy from the installed marketplace provider preset", async () => {
    const deps = makeDeps([]);
    deps.settingsService.get.mockImplementation((key?: string) => {
      if (key === "marketplace") {
        return {
          installedProviderIds: [],
          installedProviderPresets: [{
            providerId: "manual-router",
            label: "Manual Router",
            baseUrl: "https://manual.example/v1",
            defaultModel: "manual/default",
            modelOptions: ["manual/default", "manual/large"],
            requiresApiKey: true,
            modelDiscoveryPolicy: "manual",
          }],
        };
      }
      if (key === "shortcuts") return {};
      if (key === "system") return {};
      return {
        provider: "openai-compatible",
        activeChatRuntime: { kind: "api" },
        marketplaceProviderPresetId: "manual-router",
        vendors: {
          "openai-compatible": {
            model: "manual/default",
            baseUrl: "https://manual.example/v1",
          },
        },
      };
    });

    const { registerSettingsHandlers } = await import("../settings.js");
    registerSettingsHandlers(deps as never);

    await invoke("ave:settings:list-llm-models", {
      vendor: "openai-compatible",
      baseUrl: "https://manual.example/v1",
      credentialScope: "manual-router",
      modelDiscoveryPolicy: "models-api",
    });

    expect(listLlmModelsFromSettingsMock).toHaveBeenCalledWith(
      deps.settingsService,
      {
        vendor: "openai-compatible",
        baseUrl: "https://manual.example/v1",
        credentialScope: "manual-router",
        modelDiscoveryPolicy: "manual",
      },
      { fetchImpl: deps.singleHopNetworkFetch },
    );
  });

  it("derives model-list discovery policy from the active marketplace provider preset", async () => {
    const deps = makeDeps([]);
    deps.settingsService.get.mockImplementation((key?: string) => {
      if (key === "marketplace") {
        return {
          installedProviderIds: [],
          installedProviderPresets: [{
            providerId: "manual-router",
            label: "Manual Router",
            baseUrl: "https://manual.example/v1",
            defaultModel: "manual/default",
            modelOptions: ["manual/default", "manual/large"],
            requiresApiKey: true,
            modelDiscoveryPolicy: "manual",
          }],
        };
      }
      if (key === "shortcuts") return {};
      if (key === "system") return {};
      return {
        provider: "openai-compatible",
        activeChatRuntime: { kind: "api" },
        marketplaceProviderPresetId: "manual-router",
        vendors: {
          "openai-compatible": {
            model: "manual/default",
            baseUrl: "https://manual.example/v1",
          },
        },
      };
    });

    const { registerSettingsHandlers } = await import("../settings.js");
    registerSettingsHandlers(deps as never);

    await invoke("ave:settings:list-llm-models", {
      vendor: "openai-compatible",
      baseUrl: "https://manual.example/v1",
    });

    expect(listLlmModelsFromSettingsMock).toHaveBeenCalledWith(
      deps.settingsService,
      {
        vendor: "openai-compatible",
        baseUrl: "https://manual.example/v1",
        modelDiscoveryPolicy: "manual",
      },
      { fetchImpl: deps.singleHopNetworkFetch },
    );
  });

  it("rolls back active LLM settings when reviewer rewire fails", async () => {
    const windows: ReturnType<typeof makeWindow>[] = [];
    const rewire = vi.fn()
      .mockImplementationOnce(() => {
        throw new Error("missing reviewer provider");
      })
      .mockImplementationOnce(() => undefined);
    const refreshWildcard = vi.fn();
    const prevLlm = {
      provider: "openai",
      activeChatRuntime: { kind: "api" },
      vendors: {
        openai: { model: "gpt-4o" },
        claude: { model: "claude-sonnet-4-6" },
        "azure-foundry": { baseUrl: null },
      },
    };
    const nextLlm = {
      provider: "claude",
      activeChatRuntime: { kind: "api" },
      vendors: {
        openai: { model: "gpt-4o" },
        claude: { model: "claude-sonnet-4-6" },
        "azure-foundry": { baseUrl: null },
      },
    };
    let llmReads = 0;
    const patch = vi.fn(async (p: unknown) => p);
    const replaceLlm = vi.fn(async (llm: unknown) => llm);
    const baseDeps = makeDeps(windows);
    const deps = {
      ...baseDeps,
      settingsService: {
        ...baseDeps.settingsService,
        get: vi.fn((key: string) => {
          if (key === "marketplace") return {};
          llmReads += 1;
          return llmReads === 1 ? prevLlm : nextLlm;
        }),
        patch,
        replaceLlm,
      },
      rewireReviewerAgent: rewire,
      refreshActiveLlmWildcard: refreshWildcard,
    };

    const { registerSettingsHandlers } = await import("../settings.js");
    registerSettingsHandlers(deps as never);

    const result = await invoke("ave:settings:update", { llm: { provider: "claude" } });

    expect(result).toMatchObject({
      ok: false,
      error: "reviewer-rewire-failed",
      message: "missing reviewer provider",
    });
    expect(patch).toHaveBeenNthCalledWith(1, { llm: { provider: "claude" } });
    expect(replaceLlm).toHaveBeenCalledWith(prevLlm);
    expect(rewire).toHaveBeenCalledTimes(2);
    expect(deps.conversationLoop.refreshProvider).toHaveBeenCalled();
    expect(deps.sideChatConversationLoop.refreshProvider).toHaveBeenCalled();
    expect(refreshWildcard).toHaveBeenCalled();
  });

  it("does not restore a stale LLM predecessor over a newer concurrent update", async () => {
    const previousLlm = {
      provider: "openai",
      activeChatRuntime: { kind: "api" },
      vendors: {
        openai: { model: "gpt-4o" },
        claude: { model: "claude-sonnet-4-6" },
        "azure-foundry": { baseUrl: null },
      },
    };
    const appliedLlm = {
      provider: "claude",
      activeChatRuntime: { kind: "api" },
      vendors: {
        openai: { model: "gpt-4o" },
        claude: { model: "claude-sonnet-4-6" },
        "azure-foundry": { baseUrl: null },
      },
    };
    const newerLlm = {
      ...appliedLlm,
      vendors: {
        ...appliedLlm.vendors,
        openai: { model: "gpt-5.1" },
      },
    };
    let currentLlm = structuredClone(previousLlm);
    const baseDeps = makeDeps([]);
    const replaceLlm = vi.fn(async (replacement: unknown) => {
      currentLlm = structuredClone(replacement as typeof previousLlm);
      return { llm: currentLlm };
    });
    const patch = vi.fn((partial: unknown) => {
      const llm = (partial as { llm?: { provider?: string; vendors?: { openai?: { model?: string } } } }).llm;
      if (llm?.provider === "claude") {
        currentLlm = structuredClone(appliedLlm);
      } else if (llm?.vendors?.openai?.model === "gpt-5.1") {
        currentLlm = structuredClone(newerLlm);
      }
      return Promise.resolve({ llm: currentLlm });
    });
    const deps = {
      ...baseDeps,
      settingsService: {
        ...baseDeps.settingsService,
        getAll: vi.fn(() => ({ appearance: { language: "en" }, llm: currentLlm })),
        get: vi.fn((key: string) => {
          if (key === "llm") return currentLlm;
          if (key === "marketplace") return {};
          if (key === "shortcuts") return { toggleWindow: null, enabled: false };
          if (key === "system") return { launchAtStartup: false, launchMinimized: false };
          return {};
        }),
        patch,
        replaceLlm,
      },
      rewireReviewerAgent: undefined as (() => void) | undefined,
    };
    const rewire = vi.fn(() => {
      void deps.settingsService.patch({ llm: { vendors: { openai: { model: "gpt-5.1" } } } });
      throw new Error("reviewer unavailable");
    });
    deps.rewireReviewerAgent = rewire;

    const { registerSettingsHandlers } = await import("../settings.js");
    registerSettingsHandlers(deps as never);

    const result = await invoke("ave:settings:update", { llm: { provider: "claude" } });

    expect(result).toMatchObject({
      ok: false,
      error: "reviewer-rewire-failed",
      message: "reviewer unavailable",
    });
    expect(rewire).toHaveBeenCalledOnce();
    expect(replaceLlm).not.toHaveBeenCalled();
    expect(currentLlm).toEqual(newerLlm);
  });
  it("uses exact LLM replacement rollback when failed update adds active transport fields", async () => {
    const windows: ReturnType<typeof makeWindow>[] = [];
    const rewire = vi.fn()
      .mockImplementationOnce(() => {
        throw new Error("bad transport");
      })
      .mockImplementationOnce(() => undefined);
    const prevLlm = {
      provider: "openai",
      activeChatRuntime: { kind: "api" },
      vendors: {
        openai: { model: "gpt-4o" },
        "azure-foundry": { baseUrl: null },
      },
    };
    const nextLlm = {
      provider: "openai",
      activeChatRuntime: { kind: "api" },
      vendors: {
        openai: {
          model: "gpt-4o",
          baseUrl: "https://proxy.example/v1",
          vertexProject: "bad-project",
          vertexLocation: "us-central1",
        },
        "azure-foundry": { baseUrl: null },
      },
    };
    let llmReads = 0;
    const replaceLlm = vi.fn(async (llm: unknown) => llm);
    const baseDeps = makeDeps(windows);
    const deps = {
      ...baseDeps,
      settingsService: {
        ...baseDeps.settingsService,
        get: vi.fn((key: string) => {
          if (key === "marketplace") return {};
          llmReads += 1;
          return llmReads === 1 ? prevLlm : nextLlm;
        }),
        patch: vi.fn(async (p: unknown) => p),
        replaceLlm,
      },
      rewireReviewerAgent: rewire,
    };

    const { registerSettingsHandlers } = await import("../settings.js");
    registerSettingsHandlers(deps as never);

    const result = await invoke("ave:settings:update", {
      llm: {
        vendors: {
          openai: {
            baseUrl: "https://proxy.example/v1",
            vertexProject: "bad-project",
            vertexLocation: "us-central1",
          },
        },
      },
    });

    expect(result).toMatchObject({ ok: false, error: "reviewer-rewire-failed" });
    expect(replaceLlm).toHaveBeenCalledWith(prevLlm);
  });

  it("calls rewireReviewerAgent when baseUrl changes from null to a new value", async () => {
    const windows: ReturnType<typeof makeWindow>[] = [];
    const rewire = vi.fn();
    const baseDeps = makeDeps(windows, undefined);
    // Key-based mock (robust to call order; the handler reads several keys including E4's shortcuts/system).
    // `llm` flips from null baseUrl to the new one once `patched` is set, reproducing the prev→new transition.
    let patched = false;
    const deps = {
      ...baseDeps,
      settingsService: {
        ...baseDeps.settingsService,
        get: vi.fn((key: string) => {
          if (key === "llm") {
            return {
              provider: "openai",
              activeChatRuntime: { kind: "api" },
              vendors: {
                "azure-foundry": {
                  baseUrl: patched ? "https://proj.services.ai.azure.com" : null,
                },
              },
            };
          }
          if (key === "marketplace") return {};
          if (key === "shortcuts") return { toggleWindow: null, enabled: false };
          if (key === "system") return { launchAtStartup: false, launchMinimized: false };
          return {};
        }),
        patch: vi.fn(async (p: unknown) => {
          patched = true;
          return p;
        }),
      },
      rewireReviewerAgent: rewire,
    };

    const { registerSettingsHandlers } = await import("../settings.js");
    registerSettingsHandlers(deps as never);

    await invoke("ave:settings:update", {
      llm: { vendors: { "azure-foundry": { baseUrl: "https://proj.services.ai.azure.com" } } },
    });

    expect(rewire).toHaveBeenCalledOnce();
  });

  it("does NOT call rewireReviewerAgent when baseUrl stays the same", async () => {
    const windows: ReturnType<typeof makeWindow>[] = [];
    const rewire = vi.fn();
    const sameUrl = "https://proj.services.ai.azure.com";
    const baseDeps = makeDeps(windows, sameUrl);
    const deps = {
      ...baseDeps,
      settingsService: {
        ...baseDeps.settingsService,
        get: vi.fn(() => ({ provider: "openai", activeChatRuntime: { kind: "api" }, vendors: { "azure-foundry": { baseUrl: sameUrl } } })),
        patch: vi.fn(async (p: unknown) => p),
      },
      rewireReviewerAgent: rewire,
    };

    const { registerSettingsHandlers } = await import("../settings.js");
    registerSettingsHandlers(deps as never);

    await invoke("ave:settings:update", { llm: { provider: "openai" } });

    expect(rewire).not.toHaveBeenCalled();
  });

  it("calls rewireReviewerAgent on set-api-key so cacheScope refreshes", async () => {
    const windows: ReturnType<typeof makeWindow>[] = [];
    const rewire = vi.fn();
    const deps = { ...makeDeps(windows), rewireReviewerAgent: rewire };

    const { registerSettingsHandlers } = await import("../settings.js");
    registerSettingsHandlers(deps as never);

    await invoke("ave:settings:set-api-key", "openai", "az-key");

    expect(rewire).toHaveBeenCalledOnce();
  });

  it("calls rewireReviewerAgent on delete-api-key so cacheScope refreshes", async () => {
    const windows: ReturnType<typeof makeWindow>[] = [];
    const rewire = vi.fn();
    const deps = { ...makeDeps(windows), rewireReviewerAgent: rewire };

    const { registerSettingsHandlers } = await import("../settings.js");
    registerSettingsHandlers(deps as never);

    await invoke("ave:settings:delete-api-key", "azure-foundry");

    expect(rewire).toHaveBeenCalledOnce();
  });
});

describe("Minor-1: broadcastSettingsSnapshot helper — all mutation handlers call it", () => {
  it("set-api-key broadcasts snapshot via helper (not stale inline copy)", async () => {
    const win = makeWindow();
    const snapshot = { llm: { provider: "anthropic", activeChatRuntime: { kind: "api" }, version: 2 } };
    const deps = {
      ...makeDeps([win]),
      settingsService: {
        ...makeDeps([win]).settingsService,
        getAll: vi.fn(() => snapshot),
        setSecret: vi.fn(async () => undefined),
      },
    };

    const { registerSettingsHandlers } = await import("../settings.js");
    registerSettingsHandlers(deps as never);

    await invoke("ave:settings:set-api-key", "openai", "sk-test");

    expect(win.webContents.send).toHaveBeenCalledWith(SETTINGS.updated, { ...snapshot, activeChatModel: NO_CONNECTED_PROVIDER });
  });

  it("suppresses a stale generic settings:update locale side effect and snapshot", async () => {
    const win = makeWindow();
    const initialLlm = {
      provider: "openai",
      activeChatRuntime: { kind: "api" },
      vendors: { "azure-foundry": { baseUrl: null } },
    };
    let settings = {
      appearance: { language: "en" },
      llm: initialLlm,
      marketplace: {},
      shortcuts: { toggleWindow: null, enabled: false },
      system: { launchAtStartup: false, launchMinimized: false },
    };
    let resolveKo!: (messages: Record<string, string>) => void;
    let signalKoRequested!: () => void;
    const koLoading = new Promise<Record<string, string>>((resolve) => {
      resolveKo = resolve;
    });
    const koRequested = new Promise<void>((resolve) => {
      signalKoRequested = resolve;
    });
    const { __setLocaleLoaderForTest } = await import("../../../i18n/messages/index.js");
    const restoreKo = __setLocaleLoaderForTest("ko", () => {
      signalKoRequested();
      return koLoading;
    });
    const { getLocale, setLocale } = await import("../../../i18n/index.js");
    setLocale("en");
    const baseDeps = makeDeps([win]);
    const deps = {
      ...baseDeps,
      settingsService: {
        ...baseDeps.settingsService,
        getAll: vi.fn(() => structuredClone(settings)),
        get: vi.fn((key: string) => {
          if (key === "llm") return settings.llm;
          if (key === "marketplace") return settings.marketplace;
          if (key === "shortcuts") return settings.shortcuts;
          if (key === "system") return settings.system;
          return {};
        }),
        patch: vi.fn(async (partial: unknown) => {
          const language = (partial as { appearance?: { language?: unknown } }).appearance?.language;
          if (typeof language === "string") {
            settings = {
              ...settings,
              appearance: { ...settings.appearance, language },
            };
          }
          return structuredClone(settings);
        }),
      },
    };

    try {
      const { registerSettingsHandlers } = await import("../settings.js");
      registerSettingsHandlers(deps as never);

      // The older update targets the lazy Korean catalog and stalls on its loader; the newer one targets the eager English catalog and lands first.
      const older = invoke("ave:settings:update", { appearance: { language: "ko" } });
      await koRequested;
      await expect(invoke("ave:settings:update", { appearance: { language: "en" } }))
        .resolves.toMatchObject({ appearance: { language: "en" } });
      expect(getLocale()).toBe("en");
      resolveKo({});
      await expect(older).resolves.toMatchObject({ appearance: { language: "ko" } });

      expect(getLocale()).toBe("en");
      const snapshots = win.webContents.send.mock.calls
        .filter(([channel]) => channel === SETTINGS.updated)
        .map(([, snapshot]) => snapshot as { appearance?: { language?: string } });
      expect(snapshots).toEqual([
        expect.objectContaining({ appearance: { language: "en" } }),
      ]);
    } finally {
      restoreKo();
      setLocale("en");
    }
  });
  it("loads and applies a lazy main-process locale before broadcasting settings:update", async () => {
    const win = makeWindow();
    const snapshot = {
      appearance: { language: "ko" },
      llm: { provider: "openai", activeChatRuntime: { kind: "api" }, vendors: { "azure-foundry": { baseUrl: null } } },
      marketplace: {},
    };
    const baseDeps = makeDeps([win]);
    const deps = {
      ...baseDeps,
      settingsService: {
        ...baseDeps.settingsService,
        getAll: vi.fn(() => snapshot),
        get: vi.fn((key: string) =>
          key === "marketplace"
            ? snapshot.marketplace
            : snapshot.llm,
        ),
        patch: vi.fn(async (p: unknown) => p),
      },
    };
    const { setLocale, getLocale, translate } = await import("../../../i18n/index.js");
    setLocale("en");

    const { registerSettingsHandlers } = await import("../settings.js");
    registerSettingsHandlers(deps as never);

    await invoke("ave:settings:update", { appearance: { language: "ko" } });

    expect(getLocale()).toBe("ko");
    expect(translate("ko", "settings.appearance.language.title")).toBe("언어");
    expect(win.webContents.send).toHaveBeenCalledWith(SETTINGS.updated, { ...snapshot, activeChatModel: NO_CONNECTED_PROVIDER });
  });

  it("keeps the current main-process locale and still broadcasts when lazy locale loading fails", async () => {
    const win = makeWindow();
    const snapshot = {
      appearance: { language: "ko" },
      llm: { provider: "openai", activeChatRuntime: { kind: "api" }, vendors: { "azure-foundry": { baseUrl: null } } },
      marketplace: {},
    };
    const baseDeps = makeDeps([win]);
    const deps = {
      ...baseDeps,
      settingsService: {
        ...baseDeps.settingsService,
        getAll: vi.fn(() => snapshot),
        get: vi.fn((key: string) =>
          key === "marketplace"
            ? snapshot.marketplace
            : snapshot.llm,
        ),
        patch: vi.fn(async (p: unknown) => p),
      },
    };
    const { setLocale, getLocale } = await import("../../../i18n/index.js");
    const { __setLocaleLoaderForTest } = await import("../../../i18n/messages/index.js");
    const restore = __setLocaleLoaderForTest("ko", () => Promise.reject(new Error("missing chunk")));
    setLocale("en");

    try {
      const { registerSettingsHandlers } = await import("../settings.js");
      registerSettingsHandlers(deps as never);

      await invoke("ave:settings:update", { appearance: { language: "ko" } });

      expect(getLocale()).toBe("en");
      expect(win.webContents.send).toHaveBeenCalledWith(SETTINGS.updated, { ...snapshot, activeChatModel: NO_CONNECTED_PROVIDER });
    } finally {
      restore();
    }
  });
});

describe("Minor-4: settings:update rejects non-string baseUrl", () => {
  it("returns invalid-foundry-endpoint when baseUrl is a number", async () => {
    const deps = makeDeps([]);

    const { registerSettingsHandlers } = await import("../settings.js");
    registerSettingsHandlers(deps as never);

    const result = await invoke("ave:settings:update", {
      llm: { vendors: { "azure-foundry": { baseUrl: 12345 } } },
    });

    expect(result).toMatchObject({ ok: false, error: "invalid-foundry-endpoint", message: "baseUrl must be a string" });
    expect(deps.settingsService.patch).not.toHaveBeenCalled();
  });

  it("returns invalid-foundry-endpoint when baseUrl is an object", async () => {
    const deps = makeDeps([]);

    const { registerSettingsHandlers } = await import("../settings.js");
    registerSettingsHandlers(deps as never);

    const result = await invoke("ave:settings:update", {
      llm: { vendors: { "azure-foundry": { baseUrl: { toString: () => "evil" } } } },
    });

    expect(result).toMatchObject({ ok: false, error: "invalid-foundry-endpoint", message: "baseUrl must be a string" });
  });

  it("accepts valid string baseUrl", async () => {
    const deps = makeDeps([]);
    deps.settingsService.patch.mockResolvedValue({ ok: true });
    deps.settingsService.get = vi.fn(() => ({ provider: "openai", activeChatRuntime: { kind: "api" }, vendors: { "azure-foundry": { baseUrl: "https://proj.services.ai.azure.com" } } }));

    const { registerSettingsHandlers } = await import("../settings.js");
    registerSettingsHandlers(deps as never);

    await invoke("ave:settings:update", {
      llm: { vendors: { "azure-foundry": { baseUrl: "https://proj.services.ai.azure.com" } } },
    });

    expect(deps.settingsService.patch).toHaveBeenCalled();
  });
});

describe("LOW-2: settings:update validates azure-foundry baseUrl at write time", () => {
  it("returns invalid-foundry-endpoint when baseUrl is HTTP (not HTTPS)", async () => {
    const windows: ReturnType<typeof makeWindow>[] = [];
    const deps = makeDeps(windows);

    const { registerSettingsHandlers } = await import("../settings.js");
    registerSettingsHandlers(deps as never);

    const result = await invoke("ave:settings:update", {
      llm: { vendors: { "azure-foundry": { baseUrl: "http://proj.services.ai.azure.com" } } },
    });

    expect(result).toMatchObject({ ok: false, error: "invalid-foundry-endpoint" });
    // Must NOT have called settingsService.patch with invalid endpoint
    expect(deps.settingsService.patch).not.toHaveBeenCalled();
  });

  it("returns invalid-foundry-endpoint when baseUrl has non-azure hostname", async () => {
    const windows: ReturnType<typeof makeWindow>[] = [];
    const deps = makeDeps(windows);

    const { registerSettingsHandlers } = await import("../settings.js");
    registerSettingsHandlers(deps as never);

    const result = await invoke("ave:settings:update", {
      llm: { vendors: { "azure-foundry": { baseUrl: "https://evil.example.com" } } },
    });

    expect(result).toMatchObject({ ok: false, error: "invalid-foundry-endpoint" });
    expect(deps.settingsService.patch).not.toHaveBeenCalled();
  });

  it("passes through and patches when baseUrl is a valid Foundry endpoint", async () => {
    const windows: ReturnType<typeof makeWindow>[] = [];
    const deps = makeDeps(windows);
    deps.settingsService.patch.mockResolvedValue({ ok: true });

    const { registerSettingsHandlers } = await import("../settings.js");
    registerSettingsHandlers(deps as never);

    const patch = {
      llm: { vendors: { "azure-foundry": { baseUrl: "https://proj.services.ai.azure.com" } } },
    };
    await invoke("ave:settings:update", patch);

    expect(deps.settingsService.patch).toHaveBeenCalledWith(patch);
  });

  it("passes through updates that don't touch azure-foundry baseUrl", async () => {
    const windows: ReturnType<typeof makeWindow>[] = [];
    const deps = makeDeps(windows);
    deps.settingsService.patch.mockResolvedValue({ ok: true });

    const { registerSettingsHandlers } = await import("../settings.js");
    registerSettingsHandlers(deps as never);

    const patch = { llm: { provider: "openai" } };
    await invoke("ave:settings:update", patch);

    expect(deps.settingsService.patch).toHaveBeenCalledWith(patch);
  });
});

describe("main-owned settings fields on ave:settings:update", () => {
  it.each([
    ["a2aRemote", "a2a-remote-settings-main-owned"],
    ["appliedMigrations", "applied-migrations-main-owned"],
    // Where sandbox egress goes next: only the permissions upstreamProxySet channel (validated, credentials to the secret store) writes it.
    ["upstreamProxy", "upstream-proxy-settings-main-owned"],
  ])("refuses a patch that names %s and writes nothing", async (field, error) => {
    const deps = makeDeps([makeWindow()]);
    const { registerSettingsHandlers } = await import("../settings.js");
    registerSettingsHandlers(deps as never);

    const result = await invoke("ave:settings:update", { [field]: [], chat: { autoCompact: false } });

    expect(result).toEqual({ ok: false, error });
    expect(deps.settingsService.patch).not.toHaveBeenCalled();
  });
});

describe("the server marketplace's theme and language lists", () => {
  it.each(["installedThemeBundleIds", "installedLanguagePacks"])(
    "refuses a patch that names marketplace.%s and writes nothing",
    async (field) => {
      const deps = makeDeps([makeWindow()]);
      const { registerSettingsHandlers } = await import("../settings.js");
      registerSettingsHandlers(deps as never);

      const result = await invoke("ave:settings:update", { marketplace: { [field]: [], updateCheckEnabled: false } });

      expect(result).toEqual({ ok: false, error: "legacy-marketplace-lists-main-owned" });
      expect(deps.settingsService.patch).not.toHaveBeenCalled();
    },
  );
});

describe("the renderer settings snapshot", () => {
  it("leaves out the upstream proxy, which crosses only through its own permissions channels", async () => {
    const deps = makeDeps([makeWindow()]);
    deps.settingsService.getAll.mockReturnValue({
      llm: { provider: "openai" },
      upstreamProxy: { mode: "manual", manualUrl: "http://proxy.test:3128", bypass: "", resolvesNames: true },
    } as never);
    const { registerSettingsHandlers } = await import("../settings.js");
    registerSettingsHandlers(deps as never);

    const snapshot = await invoke("ave:settings:get") as Record<string, unknown>;

    expect(snapshot).toEqual({ llm: { provider: "openai" }, activeChatModel: NO_CONNECTED_PROVIDER });
  });
});
