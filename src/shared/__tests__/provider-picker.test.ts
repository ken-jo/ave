import { describe, expect, it } from "vitest";
import { LLM_VENDORS } from "../llm-vendor-defaults.js";
import { SUBSCRIPTION_RUNTIME_DESCRIPTORS } from "../subscription-runtime.js";
import { providerPickerEntries, providerPickerGroup } from "../provider-picker.js";
import { visibleVendorsFor } from "../../ui/renderer/constants.js";

describe("bundled provider picker", () => {
  it("offers every vendor without an installation", () => {
    expect(visibleVendorsFor().map((entry) => entry.id)).toEqual([...LLM_VENDORS]);
  });

  it("assigns every route exactly once and keeps the custom entry last", () => {
    const entries = providerPickerEntries([]);
    const expected = [...LLM_VENDORS, ...SUBSCRIPTION_RUNTIME_DESCRIPTORS.map((entry) => entry.id)];
    expect(entries.map((entry) => entry.id).sort()).toEqual(expected.sort());
    expect(new Set(entries.map((entry) => entry.id)).size).toBe(entries.length);
    expect(entries.at(-1)).toMatchObject({ id: "openai-compatible", group: "custom" });
    for (const runtime of SUBSCRIPTION_RUNTIME_DESCRIPTORS) {
      expect(providerPickerGroup(runtime.id)).toBe("subscription");
    }
    for (const vendor of LLM_VENDORS) {
      expect(["api", "local", "custom"]).toContain(providerPickerGroup(vendor));
    }
  });

  it("derives local routes from loopback preset addresses", () => {
    for (const id of ["ollama", "lmstudio", "litellm"]) expect(providerPickerGroup(id)).toBe("local");
    for (const id of ["openai", "claude", "gemini", "azure-foundry", "vertex-ai", "openrouter", "deepseek"]) {
      expect(providerPickerGroup(id)).toBe("api");
    }
    expect(providerPickerEntries([{
      providerId: "private-gateway", label: "Private gateway", baseUrl: "http://localhost:9000/v1",
      defaultModel: "model", modelOptions: ["model"], requiresApiKey: false,
    }]).find((entry) => entry.id === "marketplace-provider:private-gateway")).toMatchObject({ group: "api" });
  });
});
