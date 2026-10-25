import {
  LLM_VENDORS,
  llmVendorModelOptions,
  type LLMVendor,
} from "./llm-vendor-defaults.js";
import { activeModelCatalog } from "./model-catalog/active.js";
import { resolveCatalogKey } from "./model-catalog/resolve.js";

/** Unknown complexity strings remain explicit model ids rather than tiers. */
export const MODEL_COMPLEXITY_LEVELS = ["low", "mid", "high"] as const;
export type ModelComplexityLevel = (typeof MODEL_COMPLEXITY_LEVELS)[number];

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
    // Account-scoped aliases and gateways retain the parent route because public catalogs cannot name their target.
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

/** Missing or unsupported tiers return null; callers must inherit the parent model. */
export function resolveModelForComplexity(
  vendor: LLMVendor | null | undefined,
  level: ModelComplexityLevel | null | undefined,
): string | null {
  if (!vendor || !level) return null;
  const vendorMap = MODEL_COMPLEXITY_MAP[vendor];
  if (!vendorMap) return null;
  // Empty ids mean parent fallback, not a sendable model id.
  return vendorMap[level] || null;
}

/** Report tier models absent from the vendor’s options so policy choices remain self-consistent. */
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
      // Handshake-only empty mappings are intentional parent fallbacks, not orphaned models.
      if (!model) continue;
      if (!options.includes(model)) {
        orphans.push({ vendor, level, model });
      }
    }
  }
  return orphans;
}
