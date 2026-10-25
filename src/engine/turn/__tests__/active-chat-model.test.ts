import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_SETTINGS } from "../../../data/settings-defaults.js";
import type { AppSettings, LLMSettings, SettingsService } from "../../../data/settings-store.js";
import {
  marketplaceProviderPresetSecretKey,
  type MarketplaceInstalledProviderPreset,
} from "../../../shared/marketplace-package-assets.js";
import { rendererSettingsSnapshot } from "../../../ipc/domains/settings.js";
import { resolveMainActiveChatModel } from "../active-chat-model.js";
import { buildProvider, generateText, pingProvider } from "../provider.js";
import type { ConversationLoopDeps } from "../types.js";

vi.mock("electron", () => ({
  dialog: {},
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  shell: {},
  BrowserWindow: { getAllWindows: () => [] },
}));

const PRESET: MarketplaceInstalledProviderPreset = {
  providerId: "example-gateway",
  label: "Example Gateway",
  baseUrl: "https://gateway.example.test/v1",
  defaultModel: "example-model",
  modelOptions: ["example-model"],
  requiresApiKey: true,
};

interface FakeSettingsInput {
  llm?: Partial<LLMSettings>;
  secrets?: Record<string, string>;
  presets?: MarketplaceInstalledProviderPreset[];
}

function fakeSettings(input: FakeSettingsInput) {
  const settings: AppSettings = structuredClone(DEFAULT_SETTINGS);
  settings.llm = { ...settings.llm, ...input.llm };
  settings.marketplace = { ...settings.marketplace, installedProviderPresets: input.presets ?? [] };
  const secrets = new Map(Object.entries(input.secrets ?? {}));
  return {
    get: vi.fn(<K extends keyof AppSettings>(key: K) => settings[key]),
    getAll: vi.fn(() => settings),
    getSecret: vi.fn((key: string) => secrets.get(key) ?? null),
    hasStoredSecret: vi.fn((key: string) => secrets.has(key)),
  } as unknown as SettingsService;
}

function providerFor(settingsService: SettingsService) {
  return buildProvider({ settingsService } as unknown as ConversationLoopDeps);
}

describe("main's active chat model", () => {
  beforeEach(() => {
    vi.stubEnv("GOOGLE_CLOUD_PROJECT", "");
    vi.stubEnv("GCLOUD_PROJECT", "");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is none on a fresh profile with no selected model", () => {
    const settingsService = fakeSettings({});
    expect(DEFAULT_SETTINGS.llm.vendors.openai?.model).toBe("");
    expect(resolveMainActiveChatModel(settingsService)).toEqual({
      kind: "none",
      reason: "no-connected-provider",
    });
  });

  it("projects the typed none into the renderer snapshot instead of the vendor default", () => {
    const snapshot = rendererSettingsSnapshot(fakeSettings({}));
    expect(snapshot.activeChatModel).toEqual({ kind: "none", reason: "no-connected-provider" });
    expect("a2aRemote" in snapshot).toBe(false);
  });

  it("requires a model choice after connecting a fresh route", () => {
    const settingsService = fakeSettings({ secrets: { "llm.apiKey.openai": "sk-test" } });
    expect(rendererSettingsSnapshot(settingsService).activeChatModel).toEqual({
      kind: "none",
      reason: "no-model-selected",
    });
  });

  it("reports ping as unconfigured if the selection was cleared after provider construction", async () => {
    const settingsService = fakeSettings({ secrets: { "llm.apiKey.openai": "fixture-key" } });
    const streamTurn = vi.fn(async function* () { yield { type: "message_complete" as const, stopReason: "end_turn" as const }; });
    expect(await pingProvider({ vendor: "openai", streamTurn }, settingsService)).toMatchObject({ configured: false, error: "not-configured" });
    expect(streamTurn).not.toHaveBeenCalled();
  });

  it("reports generation as unconfigured if the selection was cleared after provider construction", async () => {
    const settingsService = fakeSettings({ secrets: { "llm.apiKey.openai": "fixture-key" } });
    const streamTurn = vi.fn(async function* () { yield { type: "message_complete" as const, stopReason: "end_turn" as const }; });
    await expect(generateText({ vendor: "openai", streamTurn }, settingsService, "hello")).rejects.toThrow("LLM provider not configured");
    expect(streamTurn).not.toHaveBeenCalled();
  });

  it.each(["claude", "openai", "gemini", "azure-foundry", "vertex-ai"] as const)(
    "leaves an empty %s route unconfigured even with credentials",
    (provider) => {
      const settingsService = fakeSettings({
        llm: {
          provider,
          vendors: { [provider]: { ...DEFAULT_SETTINGS.llm.vendors.openai!, model: "", vertexProject: "example-project" } },
        },
        secrets: { [`llm.apiKey.${provider}`]: "fixture-key" },
      });
      expect(resolveMainActiveChatModel(settingsService)).toEqual({ kind: "none", reason: "no-model-selected" });
      expect(providerFor(settingsService)).toBeNull();
    },
  );

  it("does not adopt a credential saved for a vendor that is not active", () => {
    const settingsService = fakeSettings({ secrets: { "llm.apiKey.claude": "sk-ant-test" } });
    expect(resolveMainActiveChatModel(settingsService)).toEqual({
      kind: "none",
      reason: "no-connected-provider",
    });
  });

  it("reports a connected handshake-only route with no model as no-model-selected", () => {
    const settingsService = fakeSettings({
      llm: {
        provider: "openai-compatible",
        vendors: { "openai-compatible": { ...DEFAULT_SETTINGS.llm.vendors.openai!, model: "", baseUrl: "http://127.0.0.1:8000/v1" } },
      },
      secrets: { "llm.apiKey.openai-compatible": "sk-local" },
    });
    expect(resolveMainActiveChatModel(settingsService)).toEqual({ kind: "none", reason: "no-model-selected" });
  });

  it("treats a selected preset that is no longer installed as not connected", () => {
    const settingsService = fakeSettings({
      llm: { provider: "openai-compatible", marketplaceProviderPresetId: PRESET.providerId },
    });
    expect(resolveMainActiveChatModel(settingsService)).toEqual({
      kind: "none",
      reason: "no-connected-provider",
    });
  });

  it("reports a selected subscription runtime without consulting the secret store", () => {
    const settingsService = fakeSettings({
      llm: { activeChatRuntime: { kind: "subscription", provider: "codex", model: "gpt-6.1-sol" } },
    });
    expect(resolveMainActiveChatModel(settingsService)).toEqual({
      kind: "subscription",
      provider: "codex",
      model: "gpt-6.1-sol",
    });
    expect(settingsService.hasStoredSecret).not.toHaveBeenCalled();
  });

  it("reports a retired provider as its own reason", () => {
    const settingsService = fakeSettings({
      llm: { retiredProvider: "copilot" },
      secrets: { "llm.apiKey.openai": "sk-test" },
    });
    expect(resolveMainActiveChatModel(settingsService)).toEqual({ kind: "none", reason: "retired-provider" });
  });

  // Composer model selection must agree with the model the transport can reach.
  it.each<[string, "none" | "api", FakeSettingsInput]>([
    ["fresh profile", "none", {}],
    ["active vendor with a key and no model", "none", { secrets: { "llm.apiKey.openai": "sk-test" } }],
    ["saved model with a key", "api", { secrets: { "llm.apiKey.openai": "sk-test" }, llm: { vendors: { openai: { ...DEFAULT_SETTINGS.llm.vendors.openai!, model: "saved-model" } } } }],
    ["key for an inactive vendor", "none", { secrets: { "llm.apiKey.claude": "sk-ant-test" } }],
    ["vertex without a project", "none", { llm: { provider: "vertex-ai" } }],
    ["vertex with a project", "api", {
      llm: {
        provider: "vertex-ai",
        vendors: { "vertex-ai": { ...DEFAULT_SETTINGS.llm.vendors.openai!, model: "gemini-3.5-flash", vertexProject: "example-project" } },
      },
    }],
    ["installed preset with a key", "api", {
      llm: {
        provider: "openai-compatible",
        marketplaceProviderPresetId: PRESET.providerId,
        vendors: {
          "openai-compatible": {
            ...DEFAULT_SETTINGS.llm.vendors.openai!,
            model: "",
            presetModels: { [PRESET.providerId]: PRESET.defaultModel },
          },
        },
      },
      presets: [PRESET],
      secrets: { [marketplaceProviderPresetSecretKey(PRESET.providerId)]: "sk-gw" },
    }],
    ["installed preset without a key", "none", {
      llm: { provider: "openai-compatible", marketplaceProviderPresetId: PRESET.providerId },
      presets: [PRESET],
    }],
  ])("agrees with buildProvider: %s", (_label, expectedKind, input) => {
    const settingsService = fakeSettings(input);
    const active = resolveMainActiveChatModel(settingsService);
    const provider = providerFor(settingsService);
    expect(active.kind).toBe(expectedKind);
    expect(provider === null).toBe(expectedKind === "none");
  });
});
