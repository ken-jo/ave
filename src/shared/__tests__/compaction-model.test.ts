import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../../data/settings-defaults.js";
import { compactionModelRouteKey, selectedCompactionModel } from "../compaction-model.js";
import { getLlmVendorSettings } from "../llm-vendor-defaults.js";

describe("compaction model route binding", () => {
  it("keeps model changes on one route but deactivates a selection after provider, endpoint or preset changes", () => {
    const llm = structuredClone(DEFAULT_SETTINGS.llm);
    llm.compactionModel = "summary-model";
    llm.compactionModelRoute = compactionModelRouteKey(llm);
    expect(selectedCompactionModel(llm)).toBe("summary-model");
    const vendor = llm.provider;
    llm.vendors[vendor] = { ...getLlmVendorSettings(llm.vendors, vendor), model: "another-chat-model" };
    expect(selectedCompactionModel(llm)).toBe("summary-model");
    llm.vendors[vendor]!.baseUrl = "https://another.example.test/v1";
    expect(selectedCompactionModel(llm)).toBeUndefined();
    llm.provider = "openai-compatible";
    llm.marketplaceProviderPresetId = "first-provider";
    llm.compactionModelRoute = compactionModelRouteKey(llm);
    llm.marketplaceProviderPresetId = "second-provider";
    expect(selectedCompactionModel(llm)).toBeUndefined();
  });

  it("keeps unbound saved ids inactive and distinguishes project authentication boundaries", () => {
    const llm = structuredClone(DEFAULT_SETTINGS.llm);
    llm.compactionModel = "old-unbound-model";
    expect(selectedCompactionModel(llm)).toBeUndefined();
    llm.provider = "vertex-ai";
    llm.vendors["vertex-ai"] = { ...getLlmVendorSettings(llm.vendors, "vertex-ai"), vertexProject: "first-project" };
    llm.compactionModelRoute = compactionModelRouteKey(llm);
    llm.vendors["vertex-ai"]!.vertexProject = "second-project";
    expect(selectedCompactionModel(llm)).toBeUndefined();
  });
});
