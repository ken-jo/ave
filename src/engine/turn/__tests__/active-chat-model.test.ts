import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_SETTINGS } from "../../../data/settings-defaults.js";
import type { AppSettings, LLMSettings, SettingsService } from "../../../data/settings-store.js";
import {
  marketplaceProviderPresetSecretKey,
  type MarketplaceInstalledProviderPreset,
} from "../../../shared/marketplace-package-assets.js";
import { rendererSettingsSnapshot } from "../../../ipc/domains/settings.js";
import { resolveMainActiveChatModel } from "../active-chat-model.js";
import { buildProvider } from "../provider.js";
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

  it("is none on a fresh profile, although the default vendor block names a model", () => {
    const settingsService = fakeSettings({});
    expect(DEFAULT_SETTINGS.llm.vendors.openai?.model).toBeTruthy();
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

  it("names the route's model once the active vendor holds a credential", () => {
    const settingsService = fakeSettings({ secrets: { "llm.apiKey.openai": "sk-test" } });
    expect(rendererSettingsSnapshot(settingsService).activeChatModel).toEqual({
      kind: "api",
      vendor: "openai",
      model: DEFAULT_SETTINGS.llm.vendors.openai?.model,
    });
  });

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

  // The snapshot's answer and the transport's must agree, or the composer
  // could name a model the next turn cannot reach (or hide one it can).
  it.each<[string, "none" | "api", FakeSettingsInput]>([
    ["fresh profile", "none", {}],
    ["active vendor with a key", "api", { secrets: { "llm.apiKey.openai": "sk-test" } }],
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
