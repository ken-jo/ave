import { describe, expect, it } from "vitest";
import {
  MODEL_COMPLEXITY_LEVELS,
  MODEL_COMPLEXITY_MAP,
  findOrphanedComplexityModels,
  isModelComplexityLevel,
  resolveModelForComplexity,
} from "../model-complexity-map.js";
import {
  LLM_VENDORS,
  type LLMVendor,
} from "../llm-vendor-defaults.js";

import { activeModelCatalog, installModelCatalog } from "../model-catalog/active.js";

describe("model-complexity-map", () => {
  it("leaves unresolved tiers to the parent without inventing a default", () => {
    const original = activeModelCatalog();
    try {
      installModelCatalog({ ...original, providers: {} });
      for (const vendor of LLM_VENDORS) {
        for (const level of MODEL_COMPLEXITY_LEVELS) {
          expect(resolveModelForComplexity(vendor, level)).toBeNull();
        }
      }
    } finally {
      installModelCatalog(original);
    }
  });
  it("resolves a newly installed family entry without retaining an imported id", () => {
    const original = activeModelCatalog();
    const model = original.providers.openai!.models[resolveModelForComplexity("openai", "mid")!]!;
    try {
      installModelCatalog({ ...original, providers: { ...original.providers, openai: {
        models: { ...original.providers.openai!.models,
          "future-workhorse": { ...model, id: "future-workhorse", releaseDate: "2099-01-01" },
        },
      } } });
      expect(resolveModelForComplexity("openai", "mid")).toBe("future-workhorse");
    } finally {
      installModelCatalog(original);
    }
    expect(resolveModelForComplexity("openai", "mid")).toBe(model.id);
  });

  describe("MODEL_COMPLEXITY_MAP coverage", () => {
    it("declares every LLM vendor", () => {
      for (const vendor of LLM_VENDORS) {
        expect(
          MODEL_COMPLEXITY_MAP[vendor],
          `vendor "${vendor}" missing from MODEL_COMPLEXITY_MAP`,
        ).toBeDefined();
      }
    });

    it("declares every complexity tier per vendor", () => {
      for (const vendor of LLM_VENDORS) {
        // Only routes with a declared family policy may change the parent model.
        const usesParent = !["claude", "openai", "gemini", "vertex-ai"].includes(vendor);
        for (const level of MODEL_COMPLEXITY_LEVELS) {
          const model = MODEL_COMPLEXITY_MAP[vendor][level];
          expect(
            typeof model,
            `${vendor}/${level} must be a string`,
          ).toBe("string");
          if (usesParent) {
            expect(model, `${vendor}/${level} handshake-only tier must be empty`).toBe("");
          } else {
            expect(model.length).toBeGreaterThan(0);
          }
        }
      }
    });

    it("every (vendor, tier, model) triple appears in the vendor's model options", () => {
      const orphans = findOrphanedComplexityModels();
      expect(
        orphans,
        `complexity map references models the vendor catalog does not list: ${JSON.stringify(orphans, null, 2)}`,
      ).toEqual([]);
    });
  });

  describe("isModelComplexityLevel", () => {
    it("accepts the three tier strings", () => {
      expect(isModelComplexityLevel("low")).toBe(true);
      expect(isModelComplexityLevel("mid")).toBe(true);
      expect(isModelComplexityLevel("high")).toBe(true);
    });

    it("rejects vendor-specific model IDs (treated as explicit overrides)", () => {
      expect(isModelComplexityLevel("gpt-5.4-mini")).toBe(false);
      expect(isModelComplexityLevel("claude-sonnet-4-6")).toBe(false);
      expect(isModelComplexityLevel("gemini-2.5-pro")).toBe(false);
    });

    it("rejects non-string and empty values", () => {
      expect(isModelComplexityLevel(undefined)).toBe(false);
      expect(isModelComplexityLevel(null)).toBe(false);
      expect(isModelComplexityLevel("")).toBe(false);
      expect(isModelComplexityLevel(42)).toBe(false);
      expect(isModelComplexityLevel({})).toBe(false);
      // Adjacent-but-wrong strings: case-sensitive, no aliases.
      expect(isModelComplexityLevel("LOW")).toBe(false);
      expect(isModelComplexityLevel("medium")).toBe(false);
    });
  });

  describe("resolveModelForComplexity", () => {
    it("returns the mapped model for every (vendor, tier) pair", () => {
      for (const vendor of LLM_VENDORS) {
        for (const level of MODEL_COMPLEXITY_LEVELS) {
          const resolved = resolveModelForComplexity(vendor, level);
          // Handshake-only vendors resolve to parent-model fallback, never an empty model id.
          expect(resolved).toBe(MODEL_COMPLEXITY_MAP[vendor][level] || null);
        }
      }
    });

    it("openai-compatible resolves every tier to null (handshake-only → parent model)", () => {
      for (const level of MODEL_COMPLEXITY_LEVELS) {
        expect(resolveModelForComplexity("openai-compatible", level)).toBeNull();
      }
    });

    it("returns null when vendor is missing — caller falls back to parent model", () => {
      expect(resolveModelForComplexity(null, "mid")).toBeNull();
      expect(resolveModelForComplexity(undefined, "mid")).toBeNull();
    });

    it("returns null when level is missing — caller falls back to parent model", () => {
      expect(resolveModelForComplexity("claude", null)).toBeNull();
      expect(resolveModelForComplexity("claude", undefined)).toBeNull();
    });

    it("returns null for an unknown vendor (string passed through boundary)", () => {
      expect(
        resolveModelForComplexity("totally-fake-vendor" as LLMVendor, "mid"),
      ).toBeNull();
    });
  });

  describe("per-vendor sanity (concrete pinned tiers)", () => {
    // Tier changes alter sub-agent model choice; update expectations deliberately.
    it("claude tiers: haiku=low, sonnet=mid, opus=high", () => {
      expect(MODEL_COMPLEXITY_MAP.claude).toEqual({
        low: "claude-haiku-5-5",
        mid: "claude-sonnet-5-5",
        high: "claude-opus-5-5",
      });
    });

    it("native reasoning tiers select the efficient, balanced and flagship families", () => {
      const tiers = { low: "gpt-6-luna", mid: "gpt-6.1-sol", high: "gpt-6-astra" };
      expect(MODEL_COMPLEXITY_MAP.openai).toEqual(tiers);
      expect(MODEL_COMPLEXITY_MAP["azure-foundry"]).toEqual({ low: "", mid: "", high: "" });
    });

    it("mapped tiers preserve distinct efficient, balanced and deep-reasoning families", () => {
      const tiers = { low: "gemini-3.5-flash-lite", mid: "gemini-3.8-flash", high: "gemini-3.1-pro-preview" };
      expect(MODEL_COMPLEXITY_MAP.gemini).toEqual(tiers);
      expect(MODEL_COMPLEXITY_MAP["vertex-ai"]).toEqual(tiers);
    });
  });
});
