import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../../data/settings-defaults.js";
import { compactionModelSelection } from "../compaction-model.js";
import { getLlmVendorSettings } from "../llm-vendor-defaults.js";
import { llmRouteCatalogAddress } from "../context-budget.js";
import { llmModelListCacheKey } from "../llm-model-list.js";

function legacySettings() {
  const llm = structuredClone(DEFAULT_SETTINGS.llm);
  delete llm.compactionModelSelection;
  llm.compactionModel = "summary-model";
  const address = llmRouteCatalogAddress(llm);
  const block = getLlmVendorSettings(llm.vendors, llm.provider);
  llm.compactionModelRoute = JSON.stringify(["api", llmModelListCacheKey(address.vendor, address.baseUrl, address.credentialScope), block.vertexProject ?? "", block.vertexLocation ?? ""]);
  return llm;
}

describe("compaction model selection", () => {
  it("uses an explicit provider independently of the active runtime", () => {
    const llm = structuredClone(DEFAULT_SETTINGS.llm);
    llm.compactionModelSelection = { vendor: "openai-compatible", model: "summary-model" };
    llm.activeChatRuntime = { kind: "subscription", provider: "claude-code" };
    expect(compactionModelSelection(llm)).toEqual({ model: llm.compactionModelSelection });
    llm.activeChatRuntime = { kind: "subscription", provider: "chatgpt-plan" };
    expect(compactionModelSelection(llm)).toEqual({ model: llm.compactionModelSelection });
    llm.compactionModelSelection = null;
    expect(compactionModelSelection(llm)).toEqual({ model: null });
  });

  it("maps a legacy API selection only to the same configured authentication route", () => {
    const llm = legacySettings();
    expect(compactionModelSelection(llm)).toEqual({ model: { vendor: llm.provider, model: "summary-model" } });
    llm.vendors[llm.provider] = { ...getLlmVendorSettings(llm.vendors, llm.provider), baseUrl: "https://another.example.test/v1" };
    expect(compactionModelSelection(llm)).toEqual({ model: null, unavailableLabel: "summary-model" });
  });

  it("keeps ambiguous and missing legacy routes unavailable", () => {
    const llm = legacySettings();
    for (const route of ["", "invalid-route", JSON.stringify(["subscription", "codex"])]) {
      llm.compactionModelRoute = route;
      expect(compactionModelSelection(llm)).toEqual({ model: null, unavailableLabel: "summary-model" });
    }
  });

  it("preserves project routing during legacy migration", () => {
    const llm = legacySettings();
    llm.compactionModelRoute = JSON.stringify(["api", llmModelListCacheKey("vertex-ai"), "first-project", "first-region"]);
    llm.vendors["vertex-ai"] = { ...getLlmVendorSettings(llm.vendors, "vertex-ai"), vertexProject: "first-project", vertexLocation: "first-region" };
    expect(compactionModelSelection(llm)).toEqual({ model: { vendor: "vertex-ai", model: "summary-model" } });
    llm.vendors["vertex-ai"]!.vertexProject = "second-project";
    expect(compactionModelSelection(llm)).toEqual({ model: null, unavailableLabel: "summary-model" });
  });

  it("requires the legacy preset to remain installed before mapping its credential scope", () => {
    const llm = legacySettings();
    llm.provider = "openai-compatible";
    llm.marketplaceProviderPresetId = "summary-provider";
    llm.vendors["openai-compatible"] = { ...getLlmVendorSettings(llm.vendors, "openai-compatible"), baseUrl: "https://summary.example.test/v1" };
    llm.compactionModelRoute = JSON.stringify(["api", llmModelListCacheKey("openai-compatible", "https://summary.example.test/v1", "summary-provider"), "", ""]);
    expect(compactionModelSelection(llm)).toEqual({ model: null, unavailableLabel: "summary-model" });
    expect(compactionModelSelection(llm, [{ providerId: "summary-provider", baseUrl: "https://summary.example.test/v1" }]))
      .toEqual({ model: { vendor: "openai-compatible", model: "summary-model" } });
  });
});
