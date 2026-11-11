import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../settings-defaults.js";
import { mergeLlmPatch } from "../settings-normalization.js";
import type { LLMSettings } from "../settings-store.js";
import { compactionModelSelection } from "../../shared/compaction-model.js";
import { llmModelListCacheKey } from "../../shared/llm-model-list.js";
import { getLlmVendorSettings } from "../../shared/llm-vendor-defaults.js";
import { marketplaceProviderPresetSecretKey, type MarketplaceInstalledProviderPreset } from "../../shared/marketplace-package-assets.js";
import { systemSubagentRouteIdentity } from "../../shared/system-subagent-model.js";

describe("compaction model settings", () => {
  it("preserves a complete destination selection and clears it explicitly", () => {
    expect(DEFAULT_SETTINGS.llm.compactionModelSelection).toBeNull();
    const route = systemSubagentRouteIdentity(DEFAULT_SETTINGS.llm, "ollama");
    if (!route) throw new Error("Expected configured route");
    const chosen = mergeLlmPatch(DEFAULT_SETTINGS.llm, { compactionModelSelection: { vendor: "ollama", model: " recap-model ", route } }, []);
    expect(chosen.compactionModelSelection).toEqual({ vendor: "ollama", model: "recap-model", route });
    expect(mergeLlmPatch(chosen, { pinnedModels: [] }, []).compactionModelSelection).toEqual(chosen.compactionModelSelection);
    expect(mergeLlmPatch(chosen, { compactionModelSelection: null }, []).compactionModelSelection).toBeNull();
  });

  it("migrates the historical API destination and retains it across chat changes", () => {
    const base = structuredClone(DEFAULT_SETTINGS.llm);
    base.provider = "ollama";
    base.vendors.ollama = { ...getLlmVendorSettings(base.vendors, "ollama"), baseUrl: "https://current.example.test/v1" };
    const route = JSON.stringify(["api", llmModelListCacheKey("ollama", "http://localhost:11434"), "", ""]);
    const migrated = mergeLlmPatch(base, { compactionModel: "recap-model", compactionModelRoute: route }, []);
    expect(migrated.compactionModelSelection).toEqual({ vendor: "ollama", model: "recap-model", route: {
      vendor: "ollama", baseUrl: "http://localhost:11434", credentialScope: "llm.apiKey.ollama",
    } });
    expect(migrated.compactionModel).toBe("");
    expect(migrated.compactionModelRoute).toBe("");
    const changed = mergeLlmPatch(migrated, { activeChatRuntime: { kind: "subscription", provider: "claude-code" }, provider: "openai" }, []);
    expect(changed.compactionModelSelection).toEqual(migrated.compactionModelSelection);
  });

  it("retains a preset's full identity when only the chat provider or preset changes", () => {
    const presets: MarketplaceInstalledProviderPreset[] = [
      { providerId: "summary-a", label: "Summary A", baseUrl: "https://summary-a.example.test/v1", defaultModel: "summary", modelOptions: ["summary"], requiresApiKey: true },
      { providerId: "summary-b", label: "Summary B", baseUrl: "https://summary-b.example.test/v1", defaultModel: "summary", modelOptions: ["summary"], requiresApiKey: true },
    ];
    const legacyRoute = JSON.stringify(["api", llmModelListCacheKey("openai-compatible", "https://summary-a.example.test/v1", "summary-a"), "", ""]);
    const selected = mergeLlmPatch(DEFAULT_SETTINGS.llm, {
      provider: "openai-compatible", marketplaceProviderPresetId: "summary-a", compactionModel: "summary", compactionModelRoute: legacyRoute,
    }, presets);
    const expected = { vendor: "openai-compatible", model: "summary", route: {
      vendor: "openai-compatible", baseUrl: "https://summary-a.example.test/v1", marketplaceProviderPresetId: "summary-a",
      credentialScope: marketplaceProviderPresetSecretKey("summary-a"),
    } };
    expect(selected.compactionModelSelection).toEqual(expected);
    const otherPreset = mergeLlmPatch(selected, { marketplaceProviderPresetId: "summary-b" }, presets);
    expect(otherPreset.compactionModelSelection).toEqual(expected);
    const otherVendor = mergeLlmPatch(otherPreset, { provider: "ollama" }, presets);
    expect(otherVendor.compactionModelSelection).toEqual(expected);
  });

  it("preserves a bare canonical legacy model without pinning the current endpoint", () => {
    const legacy = { vendor: "openai-compatible" as const, model: "recap-model" };
    const stored = { ...DEFAULT_SETTINGS.llm, compactionModelSelection: legacy };
    const normalized = mergeLlmPatch(stored, {}, []);
    expect(normalized.compactionModelSelection).toEqual(legacy);
    expect(normalized.compactionModelSelection?.route).toBeUndefined();
  });

  it("preserves an unmappable legacy selection until an explicit replacement", () => {
    const saved = mergeLlmPatch(DEFAULT_SETTINGS.llm, { compactionModel: "recap-model", compactionModelRoute: JSON.stringify(["subscription", "codex"]) }, []);
    expect(compactionModelSelection(saved)).toEqual({ model: null, unavailableLabel: "recap-model" });
    const unchanged = mergeLlmPatch(saved, { pinnedModels: [] }, []);
    expect(compactionModelSelection(unchanged)).toEqual(compactionModelSelection(saved));
    const cleared = mergeLlmPatch(unchanged, { compactionModelSelection: null }, []);
    expect(compactionModelSelection(cleared)).toEqual({ model: null });
    expect(cleared.compactionModel).toBe("");
  });

  it("keeps malformed canonical selections unavailable", () => {
    const stored = { ...DEFAULT_SETTINGS.llm, compactionModelSelection: { vendor: "removed-provider", model: "recap-model" } } as unknown as LLMSettings;
    const normalized = mergeLlmPatch(stored, {}, []);
    expect(compactionModelSelection(normalized).unavailableLabel).toContain("removed-provider");
  });
});
