import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../settings-defaults.js";
import { mergeLlmPatch } from "../settings-normalization.js";
import type { LLMSettings } from "../settings-store.js";
import { compactionModelSelection } from "../../shared/compaction-model.js";
import { llmRouteCatalogAddress } from "../../shared/context-budget.js";
import { llmModelListCacheKey } from "../../shared/llm-model-list.js";
import { getLlmVendorSettings } from "../../shared/llm-vendor-defaults.js";

describe("compaction model settings", () => {
  it("preserves a provider/model selection and clears it explicitly", () => {
    expect(DEFAULT_SETTINGS.llm.compactionModelSelection).toBeNull();
    const chosen = mergeLlmPatch(DEFAULT_SETTINGS.llm, { compactionModelSelection: { vendor: "openai-compatible", model: " recap-model " } }, []);
    expect(chosen.compactionModelSelection).toEqual({ vendor: "openai-compatible", model: "recap-model" });
    expect(mergeLlmPatch(chosen, { pinnedModels: [] }, []).compactionModelSelection).toEqual(chosen.compactionModelSelection);
    expect(mergeLlmPatch(chosen, { compactionModelSelection: null }, []).compactionModelSelection).toBeNull();
  });

  it("migrates a legacy API selection once and retains it across chat route changes", () => {
    const base = DEFAULT_SETTINGS.llm;
    const address = llmRouteCatalogAddress(base);
    const block = getLlmVendorSettings(base.vendors, base.provider);
    const route = JSON.stringify(["api", llmModelListCacheKey(address.vendor, address.baseUrl, address.credentialScope), block.vertexProject ?? "", block.vertexLocation ?? ""]);
    const migrated = mergeLlmPatch(base, { compactionModel: "recap-model", compactionModelRoute: route }, []);
    expect(migrated.compactionModelSelection).toEqual({ vendor: base.provider, model: "recap-model" });
    expect(migrated.compactionModel).toBe("");
    expect(migrated.compactionModelRoute).toBe("");
    const changed = mergeLlmPatch(migrated, { activeChatRuntime: { kind: "subscription", provider: "claude-code" }, provider: "ollama" }, []);
    expect(changed.compactionModelSelection).toEqual(migrated.compactionModelSelection);
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
