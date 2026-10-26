import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../settings-defaults.js";
import { mergeLlmPatch } from "../settings-normalization.js";
import type { LLMSettings } from "../settings-store.js";

const base = (): LLMSettings => structuredClone(DEFAULT_SETTINGS.llm);

describe("llm.subscriptionReasoningSpeed", () => {
  it("defaults to Medium, the speed the provider's own app opens on", () => {
    expect(DEFAULT_SETTINGS.llm.subscriptionReasoningSpeed).toBe("medium");
  });

  it("keeps a chosen speed and leaves it alone on unrelated patches", () => {
    const chosen = mergeLlmPatch(base(), { subscriptionReasoningSpeed: "high" }, []);
    expect(chosen.subscriptionReasoningSpeed).toBe("high");
    expect(mergeLlmPatch(chosen, { pinnedModels: ["gpt-6.1-sol"] }, []).subscriptionReasoningSpeed).toBe("high");
  });

  it("reads a stored value outside the menu as the default, never as an effort", () => {
    const stored = { ...base(), subscriptionReasoningSpeed: "xhigh" } as unknown as LLMSettings;
    expect(mergeLlmPatch(stored, {}, []).subscriptionReasoningSpeed)
      .toBe("medium");
    const { subscriptionReasoningSpeed: _absent, ...legacy } = base();
    expect(mergeLlmPatch(legacy as LLMSettings, {}, []).subscriptionReasoningSpeed)
      .toBe("medium");
  });
});
