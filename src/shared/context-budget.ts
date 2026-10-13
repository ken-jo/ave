/**
 * Usable context budget — Ave model-tier fixed reservations.
 *
 * Browser-safe (no Node imports) so both the renderer hook
 * (`use-context-budget`) and engine paths can derive the same usable
 * denominator.
 *
 * Why fixed buffers not a percentage:
 *   Small models (64K) need proportionally more reservation for output.
 *   With 32K typical max output, 0.85× of 64K (= 54K) leaves only 10K
 *   headroom — single tool-result rounds blow past it. Ave reserves fixed
 *   output/safety buffers (27K / 30K / 40K) to prevent this asymmetric pinch.
 */
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

/**
 * Reserve buffer for output + safety, return the *usable* portion of the
 * context window. Caller divides used-tokens by this to get the displayed
 * percentage.
 *
 * - 64,000     → 37,000 (reserved 27K — small models, output-heavy reasoning)
 * - 128,000    → 98,000 (reserved 30K)
 * - 200,000    → 160,000 (reserved 40K — Anthropic default tier)
 * - any other  → max(ctx − 40,000, 0.8 × ctx)
 *               picks the larger of "−40K floor" and "20% reservation",
 *               so 1M ⇒ 960K usable, 32K ⇒ ~25.6K, ≤40K ⇒ 80% (avoids
 *               negative usable on tiny windows).
 */
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

/**
 * A model's prompt cap bounds the usable budget on its own: a window of 264K
 * whose prompt may hold 128K is a 128K budget, whatever the reservation for
 * output leaves of the window. An absent or malformed cap bounds nothing.
 */
function promptCap(inputLimit: number | undefined): number {
  return typeof inputLimit === "number" && Number.isSafeInteger(inputLimit) && inputLimit > 0 ? inputLimit : Number.POSITIVE_INFINITY;
}

/** The prompt size at which a turn compacts first: 80% of {@link getUsableContext}. */
export function getPreflightThreshold(contextWindow: number, inputLimit?: number): number {
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return 0;
  const usable = getUsableContext(contextWindow, inputLimit);
  return Math.floor(usable * 0.8);
}

/**
 * Which input the resolved context window came from, in priority order.
 *
 * `model-catalog` is the generated catalog (`docs/design/model-capability-catalog.md`).
 *
 * `fallback` means nothing knew the model's real capacity and the conservative
 * {@link FALLBACK_CONTEXT_WINDOW} is in use. That is the case worth reporting:
 * a served model whose true window is larger gets compacted far earlier than it
 * needs to be, and one whose true window is smaller is never compacted early
 * enough.
 */
export type ContextWindowSource =
  | "vendor-setting"
  | "provider-reported"
  | "model-catalog"
  | "fallback";

/**
 * Who stated a model's prompt cap. Only the catalog's `limits.input` does
 * today: no `/models` endpoint Ave calls reports a prompt cap apart from the
 * window (GitHub Models' `limits.max_input_tokens` is read as the window).
 */
type InputLimitSource = "model-catalog";

export interface ResolvedContextWindow {
  readonly contextWindow: number;
  readonly source: ContextWindowSource;
  /** The catalog entry that supplied the window or prompt cap, `<provider>/<id>`. */
  readonly catalogEntry?: string;
  /**
   * The model's prompt cap, when a source states one below the window. The
   * usable budget and the compaction threshold are bounded by it
   * ({@link getUsableContext}); the window itself is still what is reported.
   */
  readonly inputLimit?: number;
  readonly inputLimitSource?: InputLimitSource;
}

/**
 * A token count only counts as an answer when it is a usable positive integer
 * within {@link MAX_CREDIBLE_CONTEXT_WINDOW}. Anything else is treated as
 * absent, so the next source answers instead.
 */
function positiveTokenCount(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) return undefined;
  if (value > MAX_CREDIBLE_CONTEXT_WINDOW) return undefined;
  return value;
}

/**
 * The context window to budget a model against, and where that number came
 * from. The single place the four possible answers are ordered.
 *
 * 1. `configured` — an explicit `llm.vendors.<vendor>.contextWindow`. The user
 *    declared the capacity of the endpoint they own; nothing outranks that.
 * 2. `reported` — what the provider itself said about this model in its
 *    `/v1/models` handshake. An external value, so the caller parses it
 *    defensively and passes `undefined` when the field was absent or malformed.
 * 3. The model catalog's entry: the one the user named for this route
 *    (`llm.vendors.<vendor>.catalogModel`), else the one the vendor's model id
 *    resolves to ({@link resolveCatalogKey}).
 * 4. The host's conservative fallback window ({@link FALLBACK_CONTEXT_WINDOW}).
 *
 * The prompt cap is resolved beside the window: the catalog entry's
 * `limits.input`, kept only when it is below the window. A declared window
 * carries none — the user stated the capacity of the endpoint they run.
 */
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

/**
 * The catalog entry for a model: the one the user named, when they named one,
 * else the one the vendor's model id resolves to. A named entry that is not in
 * the catalog answers nothing rather than falling back to the name: the user
 * said which model this is, and a name match could be a different one.
 */
export function catalogModelFor(vendor: string, model: string, catalogModel?: string, baseUrl?: string): CatalogModelHit | undefined {
  const catalog = activeModelCatalog();
  if (catalogModel !== undefined) return lookupCatalogModel(catalog, catalogModel);
  if (!allowsImplicitModelLimits(vendor, baseUrl)) return undefined;
  return resolveCatalogKey(catalog, vendor, model);
}

/**
 * Whether a route's own `/models` answer can prove one of its models retired
 * (design `model-capability-catalog.md` §6.1): a public vendor that serves its
 * own models, reached on its native host. Local runtimes, self-hosted and
 * custom endpoints (no catalog provider), gateways, Azure deployments and any
 * custom `baseUrl` list what that endpoint happens to route, so a missing id
 * there says nothing about the model.
 */
export function listingJudgesRetirement(vendor: string, baseUrl?: string): boolean {
  if (!isLLMVendor(vendor) || CATALOG_PROVIDERS_BY_VENDOR[vendor].length === 0) return false;
  if (isOpenAICompatiblePresetVendor(vendor) && OPENAI_COMPATIBLE_VENDOR_PRESETS[vendor].gateway) return false;
  return allowsImplicitModelLimits(vendor, baseUrl);
}

/**
 * Which retirement tier `model` is in on this route, or `undefined` when
 * nothing says it is going away.
 *
 * - `"unlisted"` (retired, blocks the route): the route's last successful
 *   listing was complete, comes from a route that
 *   {@link listingJudgesRetirement}, and names no id equal to `model` ignoring
 *   case. A failed, partial or missing listing proves nothing.
 * - `"catalog-deprecated"` (deprecated, does not block): the active catalog
 *   marks the model the route serves `deprecated` — judged only where the
 *   route itself establishes that identity; a user's `catalogModel`
 *   declaration describes a model's shape, not whether this host still
 *   serves it.
 *
 * The listing outranks the catalog: a model the vendor no longer serves is
 * retired even when the catalog only calls it deprecated.
 */
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
  if (listing?.complete === true && listingJudgesRetirement(params.vendor, params.baseUrl)) {
    const wanted = model.toLowerCase();
    if (!listing.models.some((id) => id.toLowerCase() === wanted)) return "unlisted";
  }
  return catalogModelFor(params.vendor, model, undefined, params.baseUrl)?.model.status === "deprecated"
    ? "catalog-deprecated"
    : undefined;
}

/** {@link resolveModelRetirement} for a model on the active route's address. */
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

/** The settings a route's context window is read out of. */
export interface LlmRouteSettings {
  readonly provider: LLMVendor;
  readonly vendors: LLMVendorSettingsMap;
  readonly marketplaceProviderPresetId?: string;
  readonly modelListCache?: LlmModelListCache;
}

/** A marketplace preset, as far as finding its catalogue row needs to know. */
export interface LlmRouteProviderPreset {
  readonly providerId: string;
  readonly baseUrl: string;
  /**
   * Whether the preset discovers its models or declares them. A caller that
   * refreshes the catalogue has to honour this: a preset declaring a static or
   * manual list is saying its endpoint must not be probed.
   */
  readonly modelDiscoveryPolicy?: MarketplaceProviderModelDiscoveryPolicy;
}

/** Where a model's output ceiling came from: the endpoint's own report, or the catalog. */
export type OutputCeilingSource = "provider-reported" | "model-catalog";

/**
 * A route's output limit: what was asked for, what the model allows, and the
 * smaller of the two that a request carries. An unknown ceiling clamps
 * nothing. The output that would still fit the remaining context is NOT a
 * part of this — it is reported in a run's diagnostics only, never used to
 * shrink a request (owner decision, #2501).
 */
export interface ResolvedOutputTokenLimit {
  readonly requested: number;
  readonly requestedSource: LlmOutputTokenLimitSource;
  readonly ceiling?: number;
  readonly ceilingSource?: OutputCeilingSource;
  readonly effective: number;
  /** `requestedSource` when the request fit, the ceiling's source when it was clamped. */
  readonly effectiveSource: LlmOutputTokenLimitSource | OutputCeilingSource;
}

/**
 * The model's output ceiling: what its endpoint reported, else the catalog
 * entry's `limits.output`. Values outside a credible range are ignored.
 */
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

/** The requested limit clamped to the model's ceiling, with both sources. */
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

/** The kinds of input a model accepts, and who stated them. */
export interface ResolvedInputModalities {
  /** As the source spells them: `text`, `image`, `pdf`, `audio`, `video`. */
  readonly input: readonly string[];
  /** Authority for the image gate; a vendor setting changes only `image`. */
  readonly source: "vendor-setting" | "provider-reported" | "model-catalog";
  /** `<provider>/<id>` when the catalog answered. */
  readonly catalogEntry?: string;
}

/**
 * A model's input modalities: the user's image declaration or named entry,
 * then its endpoint's report, then the catalog match. `undefined` when
 * neither states them: unknown, which the image gate (`supportsVision`) does
 * not read as image support. An empty reported list states nothing. A reported list is
 * an external value, folded to lower case so `Image` reads as the catalog's `image`.
 */
export function resolveInputModalities(params: {
  vendor: string;
  model: string;
  reported?: readonly string[];
  catalogModel?: string;
  /** The route's endpoint: an implicit name match follows the same identity rule as its limits (§4). */
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

/**
 * What the active route resolved about its model's inputs, for a caller that
 * gates on them: `inputModalities` absent means nobody stated them.
 */
export interface RouteInputModalities {
  readonly inputModalities?: ResolvedInputModalities;
}

/** Whether a route takes tool definitions, with the authority that states it. */
export type ResolvedToolCallSupport =
  | { readonly supported: true; readonly source: "provider-reported" }
  | { readonly supported: boolean; readonly source: "model-catalog"; readonly catalogEntry: string };

/**
 * The user's named tool capability takes precedence over an endpoint report.
 * Otherwise explicit endpoint support for `tools` overrides the catalog.
 * A missing parameter is not a denial: only a catalog `toolCall: false`
 * withholds tools. Absent means unknown and sends tools as before.
 */
export function resolveToolCallSupport(params: {
  vendor: string;
  model: string;
  reported?: readonly string[];
  catalogModel?: string;
  /** The route's endpoint: an implicit name match follows the same identity rule as its limits (§4). */
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

/**
 * The request parameter an endpoint's `/models` report names for reasoning,
 * in the order the engine prefers it (design `model-capability-catalog.md`
 * §5.1): OpenRouter's unified `reasoning` object, the OpenAI-style
 * `reasoning_effort` level, and the `include_reasoning` switch.
 */
const REPORTED_REASONING_CONTROLS = ["reasoning", "reasoning_effort", "include_reasoning"] as const;
export type ReportedReasoningControl = (typeof REPORTED_REASONING_CONTROLS)[number];

/** Whether a route's model reasons, with the authority that states it. */
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

/** What a `/models` row says about reasoning: its parameters and its prices. */
export interface ReportedReasoningFacts {
  readonly supportedParameters?: readonly string[];
  readonly pricing?: { readonly internalReasoning?: string };
}

/**
 * One rule for whether a route's model reasons, shared by the settings
 * chooser and the engine. The user's named catalog entry decides first; then
 * the endpoint's report — a reasoning parameter in `supported_parameters`, or
 * an `internal_reasoning` price; then the catalog where the route establishes
 * the model. A report that names no reasoning parameter is not a denial.
 * `undefined` means nobody states it (the host fallback).
 */
export function resolveReasoningSupport(params: {
  vendor: string;
  model: string;
  reported?: ReportedReasoningFacts;
  catalogModel?: string;
  /** The route's endpoint: an implicit name match follows the identity rule (§4). */
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
  /** The model this route runs on — `activeLlmRouteModel`'s answer. */
  readonly model: string;
  /** The endpoint used to establish model identity; absent on an SDK-managed route. */
  readonly baseUrl?: string;
  /** The named identity eligible for this model, shared with its reasoning decision. */
  readonly catalogModel?: string;
  /**
   * The provider's own ceiling on a completion for this model, when it
   * reported one. Carried beside the window for a caller that needs an output
   * ceiling; the budget math does not use it.
   */
  readonly maxOutputTokens?: number;
  /** The prices the route's own `/models` answer reported for this model, for `resolveModelPricing`. */
  readonly reportedPricing?: LlmModelListPricing;
  /**
   * The output limit a chat request on this route carries, resolved once for
   * the engine and the renderer's cost estimate alike.
   */
  readonly output: ResolvedOutputTokenLimit;
  /**
   * The `llm.vendors.<vendor>.catalogModel` the user named for this route when
   * the catalog has no such entry. The window then comes from the next source;
   * the engine reports the miss once, so a typo does not pass silently.
   */
  readonly unresolvedCatalogModel?: string;
}

/**
 * The window the ACTIVE route should be budgeted against, read straight from
 * the settings both the engine and the renderer already hold.
 *
 * This exists so there is one answer to "how big is this model's context". The
 * engine budgets compaction against it and the renderer's context-fill ring
 * divides by it; resolving it separately on each side is how the ring came to
 * show a 128K denominator for a model the gateway had reported at 229,376.
 *
 * The declared window comes off the vendor block. The reported one comes off
 * the catalogue row that route's last `/models` handshake left in the cache —
 * keyed by the address the row actually synced, which for a marketplace preset
 * is the preset's own endpoint rather than the generic custom-provider block's.
 */
/**
 * Where a route's `/models` answer lives in the cache: the vendor, the address
 * that row actually synced against, and the preset scope it synced under.
 *
 * Exported because a caller that wants to REFRESH that row has to name the
 * same coordinates the reader looks it up by — key it differently and the
 * refreshed answer is never found, so the probe repeats forever.
 */
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
  // A preset is a provider in its own right reached through the
  // openai-compatible vendor: its catalogue synced against its own endpoint,
  // not the generic custom-provider block's.
  const preset = presetId
    ? installedProviderPresets?.find((installed) => installed.providerId === presetId)
    : undefined;
  // This SDK derives its endpoint from project/location and ignores baseUrl.
  // A dormant field and its cached model list must not describe that route.
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
  // Standard model-list reports do not describe a project/location SDK route.
  // Older probes may have stored a dormant endpoint's report at the default key.
  const entry = llm.provider === "vertex-ai"
    ? undefined
    : cachedModelListEntry(llm.modelListCache, { ...address, model });
  // A named entry describes the block's own model, not a preset or a child
  // running a different model through the same endpoint.
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
