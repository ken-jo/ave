/** Use fixed output reservations so small windows retain enough headroom for tool-result rounds. */
import { FALLBACK_CONTEXT_WINDOW, MAX_CREDIBLE_CONTEXT_WINDOW } from "./model-host-policy.js";
import {
  activeLlmRouteModel,
  getLlmVendorSettings,
  isLLMVendor,
  isOpenAICompatiblePresetVendor,
  llmRouteImageInput,
  OPENAI_COMPATIBLE_VENDOR_PRESETS,
  requestedLlmOutputTokenLimit,
  type LlmModelRetirementReason,
  type LlmOutputTokenLimitSource,
  type LLMVendor,
  type LLMVendorSettingsMap,
} from "./llm-vendor-defaults.js";
import {
  cachedModelListEntry,
  llmModelListCacheKey,
  type LlmModelListCache,
  type LlmModelListCacheEntry,
  type LlmModelListPricing,
} from "./llm-model-list.js";
import { CATALOG_PROVIDERS_BY_VENDOR } from "./model-catalog/provider-map.js";
import { activeModelCatalog } from "./model-catalog/active.js";
import { allowsImplicitModelLimits, lookupCatalogModel, resolveCatalogKey, type CatalogModelHit } from "./model-catalog/resolve.js";
import type { MarketplaceProviderModelDiscoveryPolicy } from "./marketplace-package-assets.js";

/** Reserve output and safety space; tiny windows retain at least 80% usable capacity. */
export function getUsableContext(contextWindow: number, inputLimit?: number): number {
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return 0;
  return Math.min(reservedUsableContext(contextWindow), promptCap(inputLimit));
}

function reservedUsableContext(contextWindow: number): number {
  if (contextWindow === 64_000) return contextWindow - 27_000;
  if (contextWindow === 128_000) return contextWindow - 30_000;
  if (contextWindow === 200_000) return contextWindow - 40_000;
  return Math.max(contextWindow - 40_000, Math.floor(contextWindow * 0.8));
}

/** A valid prompt cap independently bounds usable capacity even when the context window is larger. */
function promptCap(inputLimit: number | undefined): number {
  return typeof inputLimit === "number" && Number.isSafeInteger(inputLimit) && inputLimit > 0 ? inputLimit : Number.POSITIVE_INFINITY;
}

/** The prompt size at which a turn compacts first: 80% of {@link getUsableContext}. */
export function getPreflightThreshold(contextWindow: number, inputLimit?: number): number {
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return 0;
  const usable = getUsableContext(contextWindow, inputLimit);
  return Math.floor(usable * 0.8);
}

/** Fallback marks unknown capacity; compacting against a guess may be too early or too late. */
export type ContextWindowSource =
  | "vendor-setting"
  | "provider-reported"
  | "model-catalog"
  | "fallback";

/** Only catalog input limits currently state a prompt cap independently of the window. */
type InputLimitSource = "model-catalog";

export interface ResolvedContextWindow {
  readonly contextWindow: number;
  readonly source: ContextWindowSource;
  /** The catalog entry that supplied the window or prompt cap, `<provider>/<id>`. */
  readonly catalogEntry?: string;
  /** Prompt caps bound usable budget and compaction, not the reported window. */
  readonly inputLimit?: number;
  readonly inputLimitSource?: InputLimitSource;
}

/** Ignore non-positive, non-integer, or implausible counts so the next source can answer. */
function positiveTokenCount(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) return undefined;
  if (value > MAX_CREDIBLE_CONTEXT_WINDOW) return undefined;
  return value;
}

/** Window precedence: configured, reported, named or matched catalog, then conservative fallback. Explicit windows carry no catalog prompt cap. */
export function resolveModelContextWindow(params: {
  vendor: string;
  model: string;
  configured?: number;
  reported?: number;
  /** A catalog entry the user named for this route, `<provider>/<id>`. */
  catalogModel?: string;
  /** The route's endpoint; custom hosts cannot establish model identity by name. */
  baseUrl?: string;
}): ResolvedContextWindow {
  const configured = positiveTokenCount(params.configured);
  if (configured !== undefined) {
    return { contextWindow: configured, source: "vendor-setting" };
  }
  const hit = catalogModelFor(params.vendor, params.model, params.catalogModel, params.baseUrl);
  const window = ((): ResolvedContextWindow => {
    const reported = positiveTokenCount(params.reported);
    if (reported !== undefined) return { contextWindow: reported, source: "provider-reported" };
    const catalogWindow = positiveTokenCount(hit?.model.limits.context);
    if (hit && catalogWindow !== undefined) {
      return { contextWindow: catalogWindow, source: "model-catalog", catalogEntry: `${hit.provider}/${hit.id}` };
    }
    return { contextWindow: FALLBACK_CONTEXT_WINDOW, source: "fallback" };
  })();
  const catalogInput = positiveTokenCount(hit?.model.limits.input);
  return hit !== undefined && catalogInput !== undefined && catalogInput < window.contextWindow
    ? { ...window, catalogEntry: `${hit.provider}/${hit.id}`, inputLimit: catalogInput, inputLimitSource: "model-catalog" }
    : window;
}

/** A missing named catalog entry does not fall back to name matching; that could describe a different model. */
export function catalogModelFor(vendor: string, model: string, catalogModel?: string, baseUrl?: string): CatalogModelHit | undefined {
  const catalog = activeModelCatalog();
  if (catalogModel !== undefined) return lookupCatalogModel(catalog, catalogModel);
  if (!allowsImplicitModelLimits(vendor, baseUrl)) return undefined;
  return resolveCatalogKey(catalog, vendor, model);
}

/** Only native public model listings can prove retirement; custom, gateway, local, and SDK-derived routes cannot. */
export function listingJudgesRetirement(vendor: string, baseUrl?: string): boolean {
  if (!isLLMVendor(vendor) || CATALOG_PROVIDERS_BY_VENDOR[vendor].length === 0) return false;
  if (vendor === "vertex-ai") return false;
  if (isOpenAICompatiblePresetVendor(vendor) && OPENAI_COMPATIBLE_VENDOR_PRESETS[vendor].gateway) return false;
  return allowsImplicitModelLimits(vendor, baseUrl);
}

/** Complete fresh listings may retire known exact ids; catalog deprecation only warns, and explicit shape declarations establish no serving identity. */
export function resolveModelRetirement(params: {
  vendor: string;
  model: string;
  baseUrl?: string;
  /** The route's last successful `/models` answer, from the settings cache. */
  listing?: LlmModelListCacheEntry;
}): LlmModelRetirementReason | undefined {
  const model = params.model.trim();
  if (!model) return undefined;
  const listing = params.listing;
  const hit = catalogModelFor(params.vendor, model, undefined, params.baseUrl);
  if (hit?.match === "exact" && listing?.complete === true
    && listingJudgesRetirement(params.vendor, params.baseUrl)
    && !listingPredatesRelease(listing, hit.model.releaseDate)) {
    const wanted = model.toLowerCase();
    if (!listing.models.some((id) => id.toLowerCase() === wanted)) return "unlisted";
  }
  return hit?.model.status === "deprecated" ? "catalog-deprecated" : undefined;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Listings must postdate the entire stated release period; unknown times cannot prove a model gone. */
function listingPredatesRelease(listing: LlmModelListCacheEntry, releaseDate: string | undefined): boolean {
  if (releaseDate === undefined) return false;
  const releasedBy = releasePeriodEnd(releaseDate);
  if (releasedBy === undefined) return false;
  const fetched = Date.parse(listing.fetchedAt);
  return !Number.isFinite(fetched) || fetched < releasedBy;
}

/** The first instant after the period a catalog release date names, in UTC. */
function releasePeriodEnd(releaseDate: string): number | undefined {
  const month = /^(\d{4})-(\d{2})$/.exec(releaseDate);
  if (month) return Date.UTC(Number(month[1]), Number(month[2]), 1);
  const year = /^(\d{4})$/.exec(releaseDate);
  if (year) return Date.UTC(Number(year[1]) + 1, 0, 1);
  const released = Date.parse(releaseDate);
  return Number.isFinite(released) ? released + DAY_MS : undefined;
}

export function resolveRouteModelRetirement(
  llm: LlmRouteSettings,
  installedProviderPresets?: readonly LlmRouteProviderPreset[],
  modelOverride?: string,
): LlmModelRetirementReason | undefined {
  const address = llmRouteCatalogAddress(llm, installedProviderPresets);
  return resolveModelRetirement({
    vendor: address.vendor,
    model: activeLlmRouteModel(llm, modelOverride),
    ...(address.baseUrl !== undefined ? { baseUrl: address.baseUrl } : {}),
    listing: llm.modelListCache?.[llmModelListCacheKey(address.vendor, address.baseUrl, address.credentialScope)],
  });
}

export interface LlmRouteSettings {
  readonly provider: LLMVendor;
  readonly vendors: LLMVendorSettingsMap;
  readonly marketplaceProviderPresetId?: string;
  readonly modelListCache?: LlmModelListCache;
}

export interface LlmRouteProviderPreset {
  readonly providerId: string;
  readonly baseUrl: string;
  /** Static or manually declared preset lists must never trigger endpoint probing. */
  readonly modelDiscoveryPolicy?: MarketplaceProviderModelDiscoveryPolicy;
}

export type OutputCeilingSource = "provider-reported" | "model-catalog";

/** Clamp requested output to the model ceiling; remaining context is diagnostic only and never shrinks the request. */
export interface ResolvedOutputTokenLimit {
  readonly requested: number;
  readonly requestedSource: LlmOutputTokenLimitSource;
  readonly ceiling?: number;
  readonly ceilingSource?: OutputCeilingSource;
  readonly effective: number;
  /** `requestedSource` when the request fit, the ceiling's source when it was clamped. */
  readonly effectiveSource: LlmOutputTokenLimitSource | OutputCeilingSource;
}

/** Use credible endpoint output limits before catalog limits. */
export function resolveOutputCeiling(params: {
  vendor: string;
  model: string;
  reported?: number;
  catalogModel?: string;
  baseUrl?: string;
}): { ceiling: number; source: OutputCeilingSource } | undefined {
  const reported = positiveTokenCount(params.reported);
  if (reported !== undefined) return { ceiling: reported, source: "provider-reported" };
  const catalog = positiveTokenCount(catalogModelFor(params.vendor, params.model, params.catalogModel, params.baseUrl)?.model.limits.output);
  return catalog === undefined ? undefined : { ceiling: catalog, source: "model-catalog" };
}

export function resolveOutputTokenLimit(params: {
  vendor: string;
  model: string;
  requested: { value: number; source: LlmOutputTokenLimitSource };
  reported?: number;
  catalogModel?: string;
  baseUrl?: string;
}): ResolvedOutputTokenLimit {
  const { value: requested, source: requestedSource } = params.requested;
  const ceiling = resolveOutputCeiling(params);
  if (!ceiling || ceiling.ceiling >= requested) {
    return {
      requested,
      requestedSource,
      ...(ceiling ? { ceiling: ceiling.ceiling, ceilingSource: ceiling.source } : {}),
      effective: requested,
      effectiveSource: requestedSource,
    };
  }
  return {
    requested,
    requestedSource,
    ceiling: ceiling.ceiling,
    ceilingSource: ceiling.source,
    effective: ceiling.ceiling,
    effectiveSource: ceiling.source,
  };
}

export interface ResolvedInputModalities {
  /** As the source spells them: `text`, `image`, `pdf`, `audio`, `video`. */
  readonly input: readonly string[];
  /** Authority for the image gate; a vendor setting changes only `image`. */
  readonly source: "vendor-setting" | "provider-reported" | "model-catalog";
  /** `<provider>/<id>` when the catalog answered. */
  readonly catalogEntry?: string;
}

/** Input precedence: user image choice or named entry, endpoint report, then catalog. Missing or empty reports never imply vision support. */
export function resolveInputModalities(params: {
  vendor: string;
  model: string;
  reported?: readonly string[];
  catalogModel?: string;
  /** Implicit model matches require endpoint identity. */
  baseUrl?: string;
  imageInput?: boolean;
}): ResolvedInputModalities | undefined {
  const hit = catalogModelFor(params.vendor, params.model, params.catalogModel, params.baseUrl);
  const input = hit?.model.modalities?.input;
  const reported = params.reported?.map((modality) => modality.trim().toLowerCase()).filter(Boolean);
  const resolved: ResolvedInputModalities | undefined = params.catalogModel !== undefined && hit && input !== undefined
    ? { input, source: "model-catalog", catalogEntry: `${hit.provider}/${hit.id}` }
    : reported && reported.length > 0
      ? { input: reported, source: "provider-reported" }
      : hit && input ? { input, source: "model-catalog", catalogEntry: `${hit.provider}/${hit.id}` } : undefined;
  if (params.imageInput !== undefined) {
    const otherInputs = (resolved?.input ?? []).filter((modality) => modality !== "image");
    return { input: params.imageInput ? [...otherInputs, "image"] : otherInputs, source: "vendor-setting" };
  }
  return resolved;
}

/** Absent input modalities mean unknown support. */
export interface RouteInputModalities {
  readonly inputModalities?: ResolvedInputModalities;
}

export type ResolvedToolCallSupport =
  | { readonly supported: true; readonly source: "provider-reported" }
  | { readonly supported: boolean; readonly source: "model-catalog"; readonly catalogEntry: string };

/** Named tool capability outranks reports; missing parameters are unknown, and only explicit catalog denial withholds tools. */
export function resolveToolCallSupport(params: {
  vendor: string;
  model: string;
  reported?: readonly string[];
  catalogModel?: string;
  /** Implicit model matches require endpoint identity. */
  baseUrl?: string;
}): ResolvedToolCallSupport | undefined {
  const hit = catalogModelFor(params.vendor, params.model, params.catalogModel, params.baseUrl);
  const supported = hit?.model.toolCall;
  if (params.catalogModel !== undefined && hit && supported !== undefined) {
    return { supported, source: "model-catalog", catalogEntry: `${hit.provider}/${hit.id}` };
  }
  if (params.reported?.some((parameter) => parameter.trim().toLowerCase() === "tools")) {
    return { supported: true, source: "provider-reported" };
  }
  return hit && supported !== undefined
    ? { supported, source: "model-catalog", catalogEntry: `${hit.provider}/${hit.id}` }
    : undefined;
}

/** Prefer the reported reasoning object, then effort level, then inclusion switch. */
const REPORTED_REASONING_CONTROLS = ["reasoning", "reasoning_effort", "include_reasoning"] as const;
export type ReportedReasoningControl = (typeof REPORTED_REASONING_CONTROLS)[number];

export type ResolvedReasoningSupport =
  | {
      readonly supported: true;
      readonly source: "endpoint-report";
      /** The parameter the endpoint reported; absent when only a reasoning price says it reasons. */
      readonly control?: ReportedReasoningControl;
    }
  | {
      readonly supported: boolean;
      readonly source: "model-catalog";
      readonly catalogEntry: string;
      /** The qualitative levels the entry accepts, when it lists them. */
      readonly efforts?: readonly string[];
    };

export interface ReportedReasoningFacts {
  readonly supportedParameters?: readonly string[];
  readonly pricing?: { readonly internalReasoning?: string };
}

/** Reasoning precedence: named entry, reported parameter or price, then established catalog identity; missing parameters are not denial. */
export function resolveReasoningSupport(params: {
  vendor: string;
  model: string;
  reported?: ReportedReasoningFacts;
  catalogModel?: string;
  /** Implicit model matches require endpoint identity. */
  baseUrl?: string;
}): ResolvedReasoningSupport | undefined {
  const hit = catalogModelFor(params.vendor, params.model, params.catalogModel, params.baseUrl);
  const stated = hit?.model.reasoning;
  const fromCatalog: ResolvedReasoningSupport | undefined = hit && stated
    ? {
        supported: stated.supported,
        source: "model-catalog",
        catalogEntry: `${hit.provider}/${hit.id}`,
        ...(stated.effort !== undefined ? { efforts: stated.effort } : {}),
      }
    : undefined;
  if (params.catalogModel !== undefined && fromCatalog) return fromCatalog;
  const reportedParameters = new Set(
    (params.reported?.supportedParameters ?? []).map((parameter) => parameter.trim().toLowerCase()),
  );
  const control = REPORTED_REASONING_CONTROLS.find((candidate) => reportedParameters.has(candidate));
  if (control !== undefined || params.reported?.pricing?.internalReasoning !== undefined) {
    return { supported: true, source: "endpoint-report", ...(control !== undefined ? { control } : {}) };
  }
  return fromCatalog;
}

/** Capability facts resolved for one route; absent fields stay unknown. */
export interface RouteModelCapabilities extends RouteInputModalities {
  readonly toolCall?: ResolvedToolCallSupport;
  readonly reasoning?: ResolvedReasoningSupport;
}

export interface RouteContextWindow extends ResolvedContextWindow, RouteModelCapabilities {
  readonly model: string;
  /** The endpoint used to establish model identity; absent on an SDK-managed route. */
  readonly baseUrl?: string;
  readonly catalogModel?: string;
  /** Carry output ceiling separately; context budget math does not use it. */
  readonly maxOutputTokens?: number;
  readonly reportedPricing?: LlmModelListPricing;
  readonly output: ResolvedOutputTokenLimit;
  /** Report missing named entries once so configuration typos cannot silently become fallback budgets. */
  readonly unresolvedCatalogModel?: string;
}

/** Engine and renderer share active-route capacity; preset reports are keyed by their own endpoint. */
/** Readers and refreshers must use the same vendor, address, and preset cache coordinates. */
export interface LlmRouteCatalogAddress {
  readonly vendor: LLMVendor;
  readonly baseUrl?: string;
  readonly credentialScope?: string;
}

export function llmRouteCatalogAddress(
  llm: LlmRouteSettings,
  installedProviderPresets?: readonly LlmRouteProviderPreset[],
): LlmRouteCatalogAddress {
  const block = getLlmVendorSettings(llm.vendors, llm.provider);
  const presetId = llm.provider === "openai-compatible"
    ? llm.marketplaceProviderPresetId?.trim()
    : undefined;
  const preset = presetId
    ? installedProviderPresets?.find((installed) => installed.providerId === presetId)
    : undefined;
  // SDK project/location routing ignores baseUrl and its cached reports.
  const baseUrl = llm.provider === "vertex-ai" ? undefined : preset?.baseUrl ?? block.baseUrl;
  return {
    vendor: llm.provider,
    ...(baseUrl ? { baseUrl } : {}),
    ...(presetId ? { credentialScope: presetId } : {}),
  };
}

export function resolveContextWindowForRoute(
  llm: LlmRouteSettings,
  installedProviderPresets?: readonly LlmRouteProviderPreset[],
  modelOverride?: string,
): RouteContextWindow {
  const model = activeLlmRouteModel(llm, modelOverride);
  const block = getLlmVendorSettings(llm.vendors, llm.provider);
  const address = llmRouteCatalogAddress(llm, installedProviderPresets);
  const entry = llm.provider === "vertex-ai"
    ? undefined
    : cachedModelListEntry(llm.modelListCache, { ...address, model });
  // A named entry describes only the configured block model, not presets or different child models.
  const catalogModel = address.credentialScope === undefined && model === block.model.trim()
    ? block.catalogModel
    : undefined;
  const resolved = resolveModelContextWindow({
    vendor: llm.provider,
    model,
    ...(block.contextWindow !== undefined ? { configured: block.contextWindow } : {}),
    ...(entry?.contextLength !== undefined ? { reported: entry.contextLength } : {}),
    ...(catalogModel !== undefined ? { catalogModel } : {}),
    ...(address.baseUrl !== undefined ? { baseUrl: address.baseUrl } : {}),
  });
  const maxOutputTokens = positiveTokenCount(entry?.maxOutputTokens);
  const output = resolveOutputTokenLimit({
    vendor: llm.provider,
    model,
    requested: requestedLlmOutputTokenLimit(block),
    ...(maxOutputTokens !== undefined ? { reported: maxOutputTokens } : {}),
    ...(catalogModel !== undefined ? { catalogModel } : {}),
    ...(address.baseUrl !== undefined ? { baseUrl: address.baseUrl } : {}),
  });
  const unresolved = catalogModel !== undefined && lookupCatalogModel(activeModelCatalog(), catalogModel) === undefined;
  const inputModalities = resolveInputModalities({
    vendor: llm.provider,
    model,
    imageInput: llmRouteImageInput(block, model, address.credentialScope),
    ...(entry?.inputModalities !== undefined ? { reported: entry.inputModalities } : {}),
    ...(catalogModel !== undefined ? { catalogModel } : {}),
    ...(address.baseUrl !== undefined ? { baseUrl: address.baseUrl } : {}),
  });
  const toolCall = resolveToolCallSupport({
    vendor: llm.provider,
    model,
    ...(entry?.supportedParameters !== undefined ? { reported: entry.supportedParameters } : {}),
    ...(catalogModel !== undefined ? { catalogModel } : {}),
    ...(address.baseUrl !== undefined ? { baseUrl: address.baseUrl } : {}),
  });
  const reasoning = resolveReasoningSupport({
    vendor: llm.provider,
    model,
    ...(entry !== undefined ? { reported: entry } : {}),
    ...(catalogModel !== undefined ? { catalogModel } : {}),
    ...(address.baseUrl !== undefined ? { baseUrl: address.baseUrl } : {}),
  });
  return {
    ...resolved,
    model,
    ...(address.baseUrl !== undefined ? { baseUrl: address.baseUrl } : {}),
    ...(catalogModel !== undefined ? { catalogModel } : {}),
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
    ...(entry?.pricing !== undefined ? { reportedPricing: entry.pricing } : {}),
    output,
    ...(unresolved ? { unresolvedCatalogModel: catalogModel } : {}),
    ...(inputModalities !== undefined ? { inputModalities } : {}),
    ...(toolCall !== undefined ? { toolCall } : {}),
    ...(reasoning !== undefined ? { reasoning } : {}),
  };
}
