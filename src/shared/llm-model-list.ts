import { modelDiscoveryPolicyUsesSeededOptions, type MarketplaceProviderModelDiscoveryPolicy } from "./marketplace-package-assets.js";
import { isLLMVendor, isOpenAICompatibleVendor } from "./llm-vendor-defaults.js";
import { vendorHasCatalogProvider } from "./model-catalog/vendor-models.js";
import type { CustomProviderWire } from "./custom-provider.js";

export type LlmModelListRequest = {
  vendor: string;
  /** Optional draft endpoint from the settings UI. When omitted, the host reads the persisted vendor block and
   * provider defaults. The host must not attach stored credentials unless this resolves to the persisted/default endpoint. */
  baseUrl?: string;
  /** API format paired with the draft custom endpoint. Omitted drafts use the default format. */
  wire?: CustomProviderWire;
  /** Optional marketplace provider preset id. Renderer uses this when multiple installed
   * OpenAI-compatible presets share one endpoint but must use separate credential namespaces and cache entries. */
  credentialScope?: string;
  /** Optional marketplace provider discovery policy. Static/manual providers keep their seeded model list and must not be probed through /models. */
  modelDiscoveryPolicy?: MarketplaceProviderModelDiscoveryPolicy;
};

export const MAX_LLM_MODEL_LIST_CACHE_ENTRIES = 48;
export const MAX_CACHED_LLM_MODEL_IDS = 2_000;
export const MAX_CACHED_LLM_MODEL_ID_LENGTH = 256;

export type LlmModelListPricing = {
  prompt?: string;
  completion?: string;
  request?: string;
  image?: string;
  webSearch?: string;
  internalReasoning?: string;
  inputCacheRead?: string;
  inputCacheWrite?: string;
};

export type LlmModelListEntry = {
  id: string;
  name?: string;
  provider?: string;
  ownedBy?: string;
  description?: string;
  /** The largest prompt this model accepts, as the provider reports it. The host budgets compaction against this when the model is
   * not in the pricing catalog, so a self-hosted or gateway-served model is no longer stuck with the conservative fallback window. */
  contextLength?: number;
  /** The largest completion this model will produce, as the provider reports it. Carried beside
   * the window for a caller that needs an output ceiling; nothing enforces a limit from it yet. */
  maxOutputTokens?: number;
  inputModalities?: string[];
  outputModalities?: string[];
  supportedParameters?: string[];
  pricing?: LlmModelListPricing;
  tags?: {
    free?: boolean;
    router?: boolean;
    local?: boolean;
  };
};

export type LlmModelListCacheEntry = {
  vendor: string;
  baseUrl?: string;
  credentialScope?: string;
  endpoint: string;
  models: string[];
  modelEntries?: LlmModelListEntry[];
  /** Set when this answer is the endpoint's whole list: the response carried no continuation marker and every id fit the cache. Only a complete listing
   * can prove a model gone (`resolveModelRetirement`); without it, including every entry written before this field existed, a missing id is unknown. */
  complete?: true;
  fetchedAt: string;
};

export type LlmModelListCache = Record<string, LlmModelListCacheEntry>;

export function llmModelListCacheKey(
  vendor: string,
  baseUrl?: string,
  credentialScope?: string,
): string {
  return `${vendor.trim()}\n${baseUrl?.trim() ?? ""}\n${credentialScope?.trim() ?? ""}`;
}

/** The catalogue row a route's model was last reported under, when that route's `/models` handshake is in the cache and named this model. `undefined` covers every "the provider never told us" case; no
 * handshake for this endpoint, a handshake that predates entry metadata, or a catalogue that does not list the configured model. Callers treat that as an absent input and ask the next source, never as an error. */
export function cachedModelListEntry(
  cache: LlmModelListCache | undefined,
  params: {
    vendor: string;
    model: string;
    baseUrl?: string;
    credentialScope?: string;
  },
): LlmModelListEntry | undefined {
  if (!cache || !params.model) return undefined;
  const key = llmModelListCacheKey(params.vendor, params.baseUrl, params.credentialScope);
  const cached = cache[key];
  const exact = cached?.modelEntries?.find((row) => row.id === params.model);
  if (exact) return exact;
  // Preserve distinct endpoint ids. A case-only spelling difference may use the report only
  // when the complete model list names one candidate, even when another listed id has no metadata.
  const wanted = params.model.toLowerCase();
  const matches = cached?.models.filter((id) => id.toLowerCase() === wanted);
  return matches?.length === 1
    ? cached?.modelEntries?.find((row) => row.id === matches[0])
    : undefined;
}

export type LlmModelListError =
  | "invalid-provider"
  | "provider-not-installed"
  | "model-list-not-supported"
  | "invalid-model-list-endpoint"
  | "model-list-fetch-failed"
  | "model-list-response-too-large"
  | "invalid-model-list-response";

export type LlmModelListResult =
  | {
      ok: true;
      vendor: string;
      endpoint: string;
      models: string[];
      modelEntries?: LlmModelListEntry[];
      /** See {@link LlmModelListCacheEntry.complete}. */
      complete?: true;
      fetchedAt: string;
    }
  | {
      ok: false;
      error: LlmModelListError;
      message?: string;
      endpoint?: string;
      status?: number;
    };

/** Vendors whose model-list endpoint is fixed and known, so their catalogue is always fetchable without the user supplying a base URL. */
export const STANDARD_CATALOGUE_ENDPOINT_VENDORS: ReadonlySet<string> = new Set([
  "openai",
  "claude",
  "gemini",
]);

/** Of those, the vendors whose list is the endpoint's word alone: until their `/models` answers, no catalog
 * list stands in. Other native routes offer catalog models until their listing arrives, then the listing. */
const ENDPOINT_ONLY_CATALOGUE_VENDORS: ReadonlySet<string> = new Set([
  "openai",
]);

/** Whether this vendor's catalogue is the endpoint's word rather than ours. Two kinds qualify: the openai-compatible family, whose catalogue is defined by whatever endpoint it points at, and {@link
 * ENDPOINT_ONLY_CATALOGUE_VENDORS}. For both, a bundled list of model ids is a guess about someone else's inventory, so it must never stand in for the answer; a failed handshake has to READ as a failed handshake, not as a short catalogue. */
export function usesEndpointModelCatalogue(vendorId: string): boolean {
  return (isLLMVendor(vendorId) && isOpenAICompatibleVendor(vendorId))
    || ENDPOINT_ONLY_CATALOGUE_VENDORS.has(vendorId);
}

/** The model ids a chat route offers: THE derivation behind both the chat model chooser (Settings > LLM) and the permission reviewer's model catalog, so the two can never disagree about what a provider offers. A synced `/models` listing wins. Without one, a catalog supplies choices; a vendor whose
 * catalogue is the endpoint's word and has no catalog offers nothing until the handshake answers (unless its discovery policy is seeded); any other vendor offers its bundled seed. The saved selection is always kept so a configured route never shows blank, and retired models; the saved one included; are dropped. */
export function chatRouteModelOptions(params: {
  vendorId: string;
  selectedModel: string;
  syncedOptions?: readonly string[];
  seed: { modelOptions: readonly string[] };
  modelDiscoveryPolicy?: MarketplaceProviderModelDiscoveryPolicy;
  isRetired?: (model: string) => boolean;
}): string[] {
  const { vendorId, selectedModel, syncedOptions, seed, modelDiscoveryPolicy } = params;
  const hasSynced = syncedOptions !== undefined;
  const handshakeOnly =
    !hasSynced &&
    !(isLLMVendor(vendorId) && vendorHasCatalogProvider(vendorId)) &&
    usesEndpointModelCatalogue(vendorId) &&
    !modelDiscoveryPolicyUsesSeededOptions(modelDiscoveryPolicy);
  const options = hasSynced
    ? [...(syncedOptions ?? [])]
    : handshakeOnly
      ? []
      : [...seed.modelOptions];
  const currentModel = selectedModel.trim();
  if (currentModel && !options.includes(currentModel)) options.unshift(currentModel);
  const isRetired = params.isRetired ?? (() => false);
  return [...new Set(options)].filter((option) => option.trim() && !isRetired(option));
}
