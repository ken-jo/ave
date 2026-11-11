import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../../data/settings-defaults.js";
import { compactionModelSelection } from "../compaction-model.js";
import { getLlmVendorSettings } from "../llm-vendor-defaults.js";
import { llmRouteCatalogAddress } from "../context-budget.js";
import { llmModelListCacheKey } from "../llm-model-list.js";
import { marketplaceProviderPresetSecretKey } from "../marketplace-package-assets.js";
import { systemSubagentRouteIdentity } from "../system-subagent-model.js";

function legacySettings() {
  const llm = structuredClone(DEFAULT_SETTINGS.llm);
  llm.provider = "ollama";
  llm.vendors.ollama = { ...getLlmVendorSettings(llm.vendors, "ollama"), baseUrl: "http://localhost:11434" };
  delete llm.compactionModelSelection;
  llm.compactionModel = "summary-model";
  const address = llmRouteCatalogAddress(llm);
  llm.compactionModelRoute = JSON.stringify(["api", llmModelListCacheKey(address.vendor, address.baseUrl, address.credentialScope), "", ""]);
  return llm;
}

describe("compaction model selection", () => {
  it("preserves an explicit destination independently of the active runtime", () => {
    const llm = legacySettings();
    const route = systemSubagentRouteIdentity(llm, "ollama");
    if (!route) throw new Error("Expected configured route");
    llm.compactionModelSelection = { vendor: "ollama", model: "summary-model", route };
    llm.activeChatRuntime = { kind: "subscription", provider: "claude-code" };
    expect(compactionModelSelection(llm)).toEqual({ model: llm.compactionModelSelection });
    llm.activeChatRuntime = { kind: "subscription", provider: "chatgpt-plan" };
    expect(compactionModelSelection(llm)).toEqual({ model: llm.compactionModelSelection });
    llm.compactionModelSelection = null;
    expect(compactionModelSelection(llm)).toEqual({ model: null });
  });

  it("keeps a bare legacy model without inventing its destination", () => {
    const llm = legacySettings();
    llm.compactionModelSelection = { vendor: "ollama", model: "summary-model" };
    expect(compactionModelSelection(llm)).toEqual({ model: { vendor: "ollama", model: "summary-model" } });
    expect(compactionModelSelection(llm).model?.route).toBeUndefined();
  });

  it("retains the historical endpoint and credential scope when configuration changes", () => {
    const llm = legacySettings();
    const expected = { model: { vendor: "ollama", model: "summary-model", route: {
      vendor: "ollama", baseUrl: "http://localhost:11434", credentialScope: "llm.apiKey.ollama",
    } } };
    expect(compactionModelSelection(llm)).toEqual(expected);
    llm.vendors.ollama = { ...getLlmVendorSettings(llm.vendors, "ollama"), baseUrl: "https://another.example.test/v1" };
    llm.provider = "openai";
    expect(compactionModelSelection(llm)).toEqual(expected);
  });

  it("keeps ambiguous and missing legacy routes unavailable", () => {
    const llm = legacySettings();
    for (const route of ["", "invalid-route", JSON.stringify(["subscription", "codex"])]) {
      llm.compactionModelRoute = route;
      expect(compactionModelSelection(llm)).toEqual({ model: null, unavailableLabel: "summary-model" });
    }
  });

  it("preserves the historical project and location during migration", () => {
    const llm = legacySettings();
    llm.compactionModelRoute = JSON.stringify(["api", llmModelListCacheKey("vertex-ai"), "first-project", "first-region"]);
    llm.vendors["vertex-ai"] = { ...getLlmVendorSettings(llm.vendors, "vertex-ai"), vertexProject: "second-project", vertexLocation: "second-region" };
    expect(compactionModelSelection(llm)).toEqual({ model: { vendor: "vertex-ai", model: "summary-model", route: {
      vendor: "vertex-ai", baseUrl: "", credentialScope: "llm.apiKey.vertex-ai", vertexProject: "first-project", vertexLocation: "first-region",
    } } });
  });

  it("retains a historical preset even when it is absent or its endpoint changes", () => {
    const llm = legacySettings();
    llm.compactionModelRoute = JSON.stringify(["api", llmModelListCacheKey("openai-compatible", "https://summary.example.test/v1", "summary-provider"), "", ""]);
    const expected = { model: { vendor: "openai-compatible", model: "summary-model", route: {
      vendor: "openai-compatible", baseUrl: "https://summary.example.test/v1",
      credentialScope: marketplaceProviderPresetSecretKey("summary-provider"), marketplaceProviderPresetId: "summary-provider",
    } } };
    expect(compactionModelSelection(llm)).toEqual(expected);
    expect(compactionModelSelection(llm, [{ providerId: "summary-provider", baseUrl: "https://replacement.example.test/v1" }])).toEqual(expected);
  });
});
