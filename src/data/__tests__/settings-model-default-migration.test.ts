import { useConfigurationOwner } from "../../__tests__/support/configuration-owner.js";

useConfigurationOwner();

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettingsService } from "../settings-store.js";
import { getLlmVendorSettings, type LLMVendor } from "../../shared/llm-vendor-defaults.js";
import { buildProvider, generateText } from "../../engine/turn/provider.js";
import type { ConversationLoopDeps } from "../../engine/turn/types.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import type { MarketplaceInstalledProviderPreset } from "../../shared/marketplace-package-assets.js";

const { createProvider, streamTurn } = vi.hoisted(() => ({
  createProvider: vi.fn(),
  streamTurn: vi.fn(),
}));
vi.mock("../../engine/llm/provider-factory.js", () => ({
  createProvider,
  secretKeyFor: (vendor: string) => `llm.apiKey.${vendor}`,
}));

// Keep migration fixtures independent of live defaults.
const REMOVED_DEFAULTS: readonly (readonly [LLMVendor, string])[] = [
  ["claude", "claude-sonnet-4-6"],
  ["openai", "gpt-5.4-mini"],
  ["gemini", "gemini-3.8-flash"],
  ["azure-foundry", "gpt-5.4-mini"],
  ["vertex-ai", "gemini-3.5-flash"],
  ["openrouter", "anthropic/claude-sonnet-4.6"],
  ["deepseek", "deepseek-flash"],
  ["xai", "grok-4.20-0309-non-reasoning"],
  ["together", "Qwen/Qwen3.6-Plus"],
  ["fireworks", "accounts/fireworks/models/glm-5p3-flash"],
  ["groq", "openai/gpt-oss-120b"],
  ["poolside", "poolside/laguna-m.1"],
  ["cerebras", "gpt-oss-120b"],
  ["sambanova", "Meta-Llama-3.3-70B-Instruct"],
  ["nebius", "nvidia/nemotron-3-super-120b-a12b"],
  ["baseten", "deepseek-ai/DeepSeek-V4.1-Flash"],
  ["requesty", "openai/gpt-6-luna"],
  ["litellm", "gpt-5.4"],
  ["huggingface", "MiniMaxAI/MiniMax-M2.5"],
  ["vercel-ai-gateway", "alibaba/qwen3.6-plus"],
  ["vercel-v0", "v0-1.5-md"],
  ["aihubmix", "gpt-5.4-mini"],
  ["hicap", "hicap-pro"],
  ["nous-research", "DeepHermes-3-Llama-3-3-70B-Preview"],
  ["huawei-cloud-maas", "DeepSeek-R1"],
  ["wandb", "deepseek-ai/DeepSeek-V4.1-Flash"],
  ["xiaomi", "mimo-v2.6-flash"],
  ["kilo", "openai/gpt-5.4"],
  ["zai", "glm-5v-turbo"],
  ["zai-coding-plan", "glm-5.2"],
  ["qwen", "qwen3.7-plus"],
  ["qwen-code", "qwen3-coder-plus"],
  ["doubao", "doubao-1-5-pro-256k-250115"],
  ["mistral", "mistral-medium-latest"],
  ["moonshot", "kimi-k3"],
  ["asksage", "gpt-5.4-mini"],
  ["ollama", "llama3.3"],
  ["lmstudio", "local-model"],
  ["oca", "anthropic/claude-3-7-sonnet-20250219"],
];
const MIGRATION = "built-in-default-models-cleared";
const encryption = {
  isEncryptionAvailable: () => false,
  getSelectedStorageBackend: () => "gnome_libsecret" as const,
  encryptString: (value: string) => Buffer.from(value),
  decryptString: (value: Buffer) => value.toString(),
};

describe("stored built-in default model migration", () => {
  let userDataPath: string;
  let path: string;

  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), "settings-model-defaults-"));
    path = join(userDataPath, "ave-settings.json");
    createProvider.mockReset().mockImplementation((config) => ({ vendor: config.vendor, streamTurn }));
    streamTurn.mockReset().mockImplementation(async function* () { throw new Error("503 unavailable"); });
  });
  afterEach(async () => {
    vi.useRealTimers();
    await cleanupTmpDir(userDataPath);
  });

  function load(contents?: Record<string, unknown>): SettingsService {
    if (contents) writeFileSync(path, JSON.stringify(contents));
    return new SettingsService({ encryption, userDataPath });
  }

  const marketPreset: MarketplaceInstalledProviderPreset = {
    providerId: "fixture-market-router",
    label: "Fixture Market Router",
    baseUrl: "https://fixture.example/v1",
    defaultModel: "market-default",
    modelOptions: ["market-default"],
    requiresApiKey: true,
  };
  const marketMarker = (id: string) => `marketplace-default-model-cleared:${id}`;
  function marketProfile(
    presets: MarketplaceInstalledProviderPreset[] = [marketPreset],
    model = marketPreset.defaultModel,
  ): Record<string, unknown> {
    return {
      appliedMigrations: [MIGRATION],
      marketplace: { installedProviderPresets: presets },
      llm: {
        provider: "openai-compatible",
        marketplaceProviderPresetId: marketPreset.providerId,
        vendors: { "openai-compatible": {
          model: "generic-choice",
          presetModels: { [marketPreset.providerId]: model },
        } },
      },
    };
  }
  function marketModel(service: SettingsService): string | undefined {
    return service.get("llm").vendors["openai-compatible"]?.presetModels?.[marketPreset.providerId];
  }

  it("clears an exact known market default and writes its per-preset marker", async () => {
    const service = load(marketProfile());
    expect(marketModel(service)).toBe("");
    expect(service.get("llm").vendors["openai-compatible"]?.model).toBe("generic-choice");
    await vi.waitFor(() => {
      expect(JSON.parse(readFileSync(path, "utf8")).appliedMigrations).toContain(marketMarker(marketPreset.providerId));
    });
    const saved = JSON.parse(readFileSync(path, "utf8"));
    expect(saved.llm.vendors["openai-compatible"].presetModels[marketPreset.providerId]).toBe("");
    expect(saved.appliedMigrations).toContain(marketMarker(marketPreset.providerId));
  });

  it.each(["user-choice", " market-default "])("keeps a different stored market value %s and marks the preset", async (model) => {
    const service = load(marketProfile([marketPreset], model));
    // Compare stored model ids before normalization trims them.
    expect(marketModel(service)).toBe(model.trim());
    await service.patch({});
    expect(JSON.parse(readFileSync(path, "utf8")).appliedMigrations).toContain(marketMarker(marketPreset.providerId));
    expect(marketModel(load())).toBe(model.trim());
  });

  it("leaves unknown market defaults pending independently of known presets", async () => {
    const service = load(marketProfile([]));
    const before = marketModel(service);
    await service.patch({});
    expect(marketModel(service)).toBe(before);
    expect(service.get("appliedMigrations")).not.toContain(marketMarker(marketPreset.providerId));
    await service.installMarketplaceProviderPreset({ ...marketPreset, providerId: "other-market-router" });
    expect(marketModel(load())).toBe(before);
    const markers = JSON.parse(readFileSync(path, "utf8")).appliedMigrations;
    expect(markers).not.toContain(marketMarker(marketPreset.providerId));
    expect(markers).toContain(marketMarker("other-market-router"));
  });

  it("clears a pending market default once registration makes it known", async () => {
    const service = load(marketProfile([]));
    expect(marketModel(service)).toBe(marketPreset.defaultModel);
    await service.installMarketplaceProviderPreset(marketPreset);
    expect(marketModel(service)).toBe("");
    await service.installMarketplaceProviderPreset(marketPreset);
    const reloaded = load();
    await reloaded.installMarketplaceProviderPreset(marketPreset);
    expect(marketModel(reloaded) ?? "").toBe("");
    expect(reloaded.get("appliedMigrations")?.filter((id) => id === marketMarker(marketPreset.providerId))).toHaveLength(1);
  });

  it("keeps a market default re-picked after processing across reload and repeated registration", async () => {
    const service = load(marketProfile());
    expect(marketModel(service)).toBe("");
    await service.patch({ llm: { vendors: { "openai-compatible": {
      presetModels: { [marketPreset.providerId]: marketPreset.defaultModel },
    } } } });
    const reloaded = load();
    await reloaded.installMarketplaceProviderPreset(marketPreset);
    await reloaded.installMarketplaceProviderPreset({ ...marketPreset, defaultModel: "new-default" });
    await reloaded.installMarketplaceProviderPreset(marketPreset);
    expect(marketModel(load())).toBe(marketPreset.defaultModel);
  });

  it("clears a market default moved from the legacy shared model slot", async () => {
    const profile = marketProfile();
    profile.llm = { provider: "openai-compatible", marketplaceProviderPresetId: marketPreset.providerId,
      vendors: { "openai-compatible": { model: marketPreset.defaultModel } } };
    const service = load(profile);
    expect(marketModel(service)).toBe("");
    await service.patch({});
    expect(service.get("appliedMigrations")).toContain(marketMarker(marketPreset.providerId));
  });

  it("makes a cleared market route unconfigured without dispatching an empty model", async () => {
    const service = load(marketProfile());
    const deps = { settingsService: { get: service.get.bind(service), getSecret: () => "test-key" } } as unknown as ConversationLoopDeps;
    const provider = buildProvider(deps);
    expect(provider).toBeNull();
    await expect(generateText(provider, service, "hello")).rejects.toThrow("not configured");
    expect(createProvider).not.toHaveBeenCalled();
    expect(streamTurn).not.toHaveBeenCalled();
    await service.patch({});
  });

  it.each(REMOVED_DEFAULTS)("clears only %s's removed default %s and persists the marker", async (vendor, model) => {
    const service = load({ llm: { provider: vendor, vendors: { [vendor]: { model } } } });
    expect(getLlmVendorSettings(service.get("llm").vendors, vendor).model).toBe("");
    expect(service.get("appliedMigrations")).toContain(MIGRATION);
    await service.patch({});
    const saved = JSON.parse(readFileSync(path, "utf8"));
    expect(saved.appliedMigrations).toContain(MIGRATION);
    expect(getLlmVendorSettings(load().get("llm").vendors, vendor).model).toBe("");
  });

  it("clears exact matches while preserving other models, foreign ids and whitespace", async () => {
    const service = load({ llm: { provider: "openai", vendors: {
      openai: { model: "gpt-5.4-mini" },
      claude: { model: "gpt-5.4-mini" },
      gemini: { model: "chosen-model" },
      deepseek: { model: "deepseek-flash" },
      "azure-foundry": { model: " gpt-5.4-mini " },
      "openai-compatible": { model: "gpt-5.4-mini", presetModels: { "custom-route": "gpt-5.4-mini" } },
    } } });
    expect(service.get("llm").vendors.openai?.model).toBe("");
    expect(service.get("llm").vendors.claude?.model).toBe("gpt-5.4-mini");
    expect(service.get("llm").vendors.gemini?.model).toBe("chosen-model");
    expect(service.get("llm").vendors.deepseek?.model).toBe("");
    expect(service.get("marketplace").installedProviderIds).not.toContain("deepseek");
    expect(service.get("llm").vendors["azure-foundry"]?.model).toBe(" gpt-5.4-mini ");
    expect(service.get("llm").vendors["openai-compatible"]?.model).toBe("gpt-5.4-mini");
    expect(service.get("llm").vendors["openai-compatible"]?.presetModels).toEqual({ "custom-route": "gpt-5.4-mini" });
    await service.patch({});
  });

  it("clears the old fallback seeds by vendor while preserving explicit alternatives", async () => {
    const service = load({ llm: { provider: "openai", fallbackChain: [
      { provider: "openai", model: "gpt-5.4-mini" },
      { provider: "claude", model: "gpt-5.4-mini" },
      { provider: "gemini", model: "chosen-model" },
    ] } });
    expect(service.get("llm").fallbackChain).toEqual([
      { provider: "openai", model: "" },
      { provider: "claude", model: "gpt-5.4-mini" },
      { provider: "gemini", model: "chosen-model" },
    ]);
    await service.patch({});
  });

  it("runs once, preserves later reselection and respects already migrated profiles", async () => {
    const service = load({ llm: { provider: "openai", vendors: { openai: { model: "gpt-5.4-mini" } } } });
    expect(service.get("llm").vendors.openai?.model).toBe("");
    await service.patch({});
    const migrated = load();
    expect(migrated.get("llm")).toEqual(service.get("llm"));
    await migrated.patch({ llm: { vendors: { openai: { model: "gpt-5.4-mini" } } } });
    expect(load().get("llm").vendors.openai?.model).toBe("gpt-5.4-mini");
    const marked = load({ appliedMigrations: [MIGRATION], llm: {
      provider: "openai", vendors: { openai: { model: "gpt-5.4-mini" } },
      fallbackChain: [{ provider: "openai", model: "gpt-5.4-mini" }],
    } });
    expect(marked.get("llm").vendors.openai?.model).toBe("gpt-5.4-mini");
    expect(marked.get("llm").fallbackChain[0]?.model).toBe("gpt-5.4-mini");
    await marked.patch({});
    expect(load().get("appliedMigrations")?.filter((id) => id === MIGRATION)).toHaveLength(1);
  });

  it("starts fresh and recovered profiles migrated so a first-session choice survives", async () => {
    for (const contents of [undefined, "invalid-json"]) {
      if (contents) writeFileSync(path, contents);
      const service = load();
      expect(service.get("appliedMigrations")).toContain(MIGRATION);
      await service.patch({ llm: { vendors: { openai: { model: "gpt-5.4-mini" } } } });
      expect(load().get("llm").vendors.openai?.model).toBe("gpt-5.4-mini");
    }
  });

  it("makes a cleared active route unconfigured and never dispatches an empty model", async () => {
    const service = load({ llm: { provider: "openai", vendors: { openai: { model: "gpt-5.4-mini" } },
      fallbackChain: [{ provider: "claude", model: "claude-sonnet-4-6" }],
    } });
    const deps = { settingsService: { get: service.get.bind(service), getSecret: () => "test-key" } } as unknown as ConversationLoopDeps;
    const provider = buildProvider(deps);
    expect(provider).toBeNull();
    await expect(generateText(provider, service, "hello")).rejects.toThrow("not configured");
    expect(createProvider).not.toHaveBeenCalled();
    expect(streamTurn).not.toHaveBeenCalled();
    await service.patch({ llm: { vendors: { openai: { model: "chosen-model" } } } });
    const configured = buildProvider(deps)!;
    vi.useFakeTimers();
    const request = (async () => {
      for await (const _event of configured.streamTurn({ model: "chosen-model", systemPrompt: "system", messages: [], tools: [] })) {  }
    })();
    const rejected = expect(request).rejects.toThrow("503 unavailable");
    await vi.runAllTimersAsync();
    await rejected;
    expect(createProvider).toHaveBeenCalledTimes(1);
    expect(createProvider).toHaveBeenCalledWith(expect.objectContaining({ model: "chosen-model" }));
    expect(streamTurn).toHaveBeenCalled();
    for (const [params] of streamTurn.mock.calls) expect(params.model).toBe("chosen-model");
  });
});
