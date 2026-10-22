/**
 * The models a permission judge may run on, derived from the live `llm`
 * settings the chat model picker reads.
 *
 * Kept apart from `judge-settings.ts` on purpose: the settings schema is read
 * by the permission settings store, which most of the app imports, while this
 * catalog needs the model-list endpoint resolver from the LLM engine. Folding
 * the two together pulled the provider stack into every importer of the store.
 */
import { llmRouteModel, LLM_VENDOR_DEFAULTS, LLM_VENDOR_MODEL_OPTIONS, type LLMVendor } from "../../shared/llm-vendor-defaults.js";
import { chatRouteModelOptions, type LlmModelListCache } from "../../shared/llm-model-list.js";
import { isDefaultModelListEndpoint } from "../../engine/llm/model-list.js";
import { resolveModelRetirement } from "../../shared/context-budget.js";
import { modelDiscoveryPolicyUsesSeededOptions, type MarketplaceInstalledProviderPreset } from "../../shared/marketplace-package-assets.js";
import type { JudgeModelCatalog } from "./judge-settings.js";

/** The subset of `llm` settings the picker's option list is derived from. */
export interface JudgeModelCatalogSource {
  /** Saved per-vendor blocks: the user's selected model and configured endpoint. */
  vendors?: Partial<Record<LLMVendor, { model?: string; baseUrl?: string; presetModels?: Record<string, string> }>>;
  /** `/models` handshake results, as the picker reads them. */
  modelListCache?: LlmModelListCache;
  provider?: string;
  marketplaceProviderPresetId?: string;
  installedProviderPresets?: readonly Pick<MarketplaceInstalledProviderPreset,
    "providerId" | "baseUrl" | "defaultModel" | "modelOptions" | "modelDiscoveryPolicy" | "requiresApiKey">[];
}

/**
 * The same option set the chat model picker offers (`LlmTab` `modelOptionsFor`):
 * the current route's listing or seeded policy, its saved selection, and the
 * same retirement filter. A model identity selects each vendor's current route;
 * inactive presets do not add alternative credential routes to this catalog.
 */
export function judgeModelCatalogFrom(source: JudgeModelCatalogSource): JudgeModelCatalog {
  return {
    optionsFor(vendor) {
      const block = source.vendors?.[vendor];
      const presetId = vendor === "openai-compatible" && source.provider === vendor
        ? source.marketplaceProviderPresetId?.trim() : undefined;
      const preset = presetId ? source.installedProviderPresets?.find((entry) => entry.providerId === presetId) : undefined;
      if (presetId && !preset) return [];
      const vendors = preset ? { ...source.vendors, [vendor]: { ...block, baseUrl: preset.baseUrl } } : source.vendors;
      const baseUrl = (preset?.baseUrl ?? block?.baseUrl ?? LLM_VENDOR_DEFAULTS[vendor].baseUrl)?.trim() || undefined;
      const seeded = modelDiscoveryPolicyUsesSeededOptions(preset?.modelDiscoveryPolicy);
      const listings = Object.entries(source.modelListCache ?? {}).filter(([key, entry]) => {
        if (entry.vendor !== vendor) return false;
        const scope = entry.credentialScope ?? key.split("\n")[2] ?? "";
        return scope === (presetId ?? "") && isDefaultModelListEndpoint(vendors, vendor, entry.endpoint);
      });
      const listing = listings.sort((a, b) => (Date.parse(b[1].fetchedAt) || 0) - (Date.parse(a[1].fetchedAt) || 0))[0]?.[1];
      // The chat chooser's own derivation, fed with this route's inputs.
      return chatRouteModelOptions({
        vendorId: vendor,
        selectedModel: llmRouteModel({ model: block?.model ?? "", presetModels: block?.presetModels }, presetId),
        ...(seeded || !listing?.models ? {} : { syncedOptions: listing.models }),
        seed: preset
          ? { modelOptions: preset.modelOptions, defaultModel: preset.defaultModel }
          : { modelOptions: LLM_VENDOR_MODEL_OPTIONS[vendor], defaultModel: LLM_VENDOR_DEFAULTS[vendor].model },
        ...(preset?.modelDiscoveryPolicy ? { modelDiscoveryPolicy: preset.modelDiscoveryPolicy } : {}),
        isRetired: (model) => resolveModelRetirement({ vendor, model, baseUrl, listing }) !== undefined,
      });
    },
  };
}
