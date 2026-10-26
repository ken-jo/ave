import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../settings-defaults.js";
import { mergeLlmPatch, pruneLazyLlmVendorBlocks } from "../settings-normalization.js";
import type { LLMSettings } from "../settings-store.js";

describe("compaction model selection", () => {
  it("uses the current model by default and after clearing the selection", () => {
    expect(DEFAULT_SETTINGS.llm.compactionModel).toBe("");
    const chosen = mergeLlmPatch(DEFAULT_SETTINGS.llm, { compactionModel: " recap-model " }, [], []);
    expect(chosen.compactionModel).toBe("recap-model");
    expect(mergeLlmPatch(chosen, { pinnedModels: [] }, [], []).compactionModel).toBe("recap-model");
    expect(mergeLlmPatch(chosen, { compactionModel: "" }, [], []).compactionModel).toBe("");
  });

  it("drops malformed stored model ids without changing the chat route", () => {
    for (const compactionModel of [42, "bad\nmodel", "x".repeat(1_025), null]) {
      const stored = { ...DEFAULT_SETTINGS.llm, compactionModel } as unknown as LLMSettings;
      const { llm } = pruneLazyLlmVendorBlocks(stored, [], [], { inferInstalledFromCustom: false });
      expect(llm.compactionModel).toBe("");
      expect(llm.provider).toBe(DEFAULT_SETTINGS.llm.provider);
    }
  });
});
