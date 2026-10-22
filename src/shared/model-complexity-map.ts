/** Resolve profile complexity tiers from the active catalog's model families. */
import {
  LLM_VENDORS,
  llmVendorModelOptions,
  type LLMVendor,
} from "./llm-vendor-defaults.js";
import { activeModelCatalog } from "./model-catalog/active.js";
import { resolveCatalogKey } from "./model-catalog/resolve.js";

/**
 * Complexity tiers an agent profile may declare in its `model:`
 * frontmatter. Anything outside this union is treated as an explicit
 * vendor-specific model ID and passed through unchanged.
 */
export const MODEL_COMPLEXITY_LEVELS = ["low", "mid", "high"] as const;
export type ModelComplexityLevel = (typeof MODEL_COMPLEXITY_LEVELS)[number];

/**
 * Runtime guard for `unknown` inputs (e.g. profile frontmatter parsed
 * from disk). Strings outside the union return false; callers should
 * treat such values as a vendor-specific model ID, not a tier.
 */
export function isModelComplexityLevel(
  value: unknown,
): value is ModelComplexityLevel {
  return (
    typeof value === "string" &&
    (MODEL_COMPLEXITY_LEVELS as readonly string[]).includes(value)
  );
}

/** Family choices are host policy; the catalog supplies each family's current id. */
const COMPLEXITY_FAMILIES: Partial<Record<LLMVendor, Readonly<Record<ModelComplexityLevel, string>>>> = {
  claude: { low: "claude-haiku", mid: "claude-sonnet", high: "claude-opus" },
  openai: { low: "gpt-luna", mid: "gpt-sol", high: "gpt-astra" },
  gemini: { low: "gemini-flash-lite", mid: "gemini-flash", high: "gemini-pro" },
  "vertex-ai": { low: "gemini-flash-lite", mid: "gemini-flash", high: "gemini-pro" },
};

function complexityMapForVendor(vendor: LLMVendor): Readonly<Record<ModelComplexityLevel, string>> {
  const options = llmVendorModelOptions(vendor);
  const families = COMPLEXITY_FAMILIES[vendor];
  const select = (level: ModelComplexityLevel): string => {
    // Deployment aliases and gateways retain the parent route: a public
    // catalog cannot name the account-specific target to send a tier to.
    if (!families) return "";
    return options.find((id) => {
      const model = resolveCatalogKey(activeModelCatalog(), vendor, id)?.model;
      return model?.family === families[level] && model.structuredOutput === true;
    }) ?? "";
  };
  return Object.freeze({ low: select("low"), mid: select("mid"), high: select("high") });
}

/** Read lazily so catalog installation and refresh cannot leave stale tier ids. */
export const MODEL_COMPLEXITY_MAP = Object.freeze(Object.defineProperties(
  {} as Record<LLMVendor, Readonly<Record<ModelComplexityLevel, string>>>,
  Object.fromEntries(LLM_VENDORS.map((vendor) => [vendor, {
    enumerable: true,
    get: () => complexityMapForVendor(vendor),
  }])),
));

/**
 * Resolve `(vendor, level)` to a concrete model ID. Returns `null` when
 * either argument is missing, the tier is undefined for that vendor, or the
 * vendor is handshake-only (empty catalog → empty mapped model) — in every
 * case the caller must apply the design-intent parent-model fallback.
 */
export function resolveModelForComplexity(
  vendor: LLMVendor | null | undefined,
  level: ModelComplexityLevel | null | undefined,
): string | null {
  if (!vendor || !level) return null;
  const vendorMap = MODEL_COMPLEXITY_MAP[vendor];
  if (!vendorMap) return null;
  // `|| null` (not `?? null`): handshake-only vendors (openai-compatible) map
  // every tier to the empty default model, which must resolve to the
  // parent-model fallback, not an empty-string model id.
  return vendorMap[level] || null;
}

/**
 * Verify every tier in the map points at a model also listed in
 * `llmVendorModelOptions(vendor)`. Called from the unit test; kept
 * in the source file so a future contributor adding a new vendor or
 * tier can quickly assert their addition stays self-consistent.
 *
 * Returns the list of `(vendor, tier, model)` triples that DO NOT
 * appear in the vendor's option list. An empty array means the map
 * is self-consistent.
 */
export function findOrphanedComplexityModels(): Array<{
  vendor: LLMVendor;
  level: ModelComplexityLevel;
  model: string;
}> {
  const orphans: Array<{
    vendor: LLMVendor;
    level: ModelComplexityLevel;
    model: string;
  }> = [];
  for (const [vendor, tiers] of Object.entries(MODEL_COMPLEXITY_MAP) as Array<
    [LLMVendor, Record<ModelComplexityLevel, string>]
  >) {
    const options = llmVendorModelOptions(vendor);
    for (const level of MODEL_COMPLEXITY_LEVELS) {
      const model = tiers[level];
      // Handshake-only vendors (openai-compatible) have no static catalog and
      // map every tier to the empty model → parent-model fallback. There is no
      // catalog entry to verify, so they are not orphans.
      if (!model) continue;
      if (!options.includes(model)) {
        orphans.push({ vendor, level, model });
      }
    }
  }
  return orphans;
}
