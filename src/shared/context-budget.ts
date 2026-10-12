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
import {
  effectiveContextWindow,
  FALLBACK_PRICING,
  lookupPricingOptional,
} from "./pricing-data.js";
import {
  activeLlmRouteModel,
  getLlmVendorSettings,
  requestedLlmOutputTokenLimit,
  type LlmOutputTokenLimitSource,
  type LLMVendor,
  type LLMVendorSettingsMap,
} from "./llm-vendor-defaults.js";
import { cachedModelListEntry, type LlmModelListCache } from "./llm-model-list.js";
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
 * `pricing-catalog` is the hand-kept `DEFAULT_PRICING` table, still consulted
 * for a model the catalog does not know until issue #2501's last slice
 * removes its context rows.
 *
 * `fallback` means nothing knew the model's real capacity and the conservative
 * {@link FALLBACK_PRICING} window is in use. That is the case worth reporting:
 * a served model whose true window is larger gets compacted far earlier than it
 * needs to be, and one whose true window is smaller is never compacted early
 * enough.
 */
export type ContextWindowSource =
  | "vendor-setting"
  | "provider-reported"
  | "model-catalog"
  | "pricing-catalog"
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
 * The largest window a declared or reported value is believed at.
 *
 * Above this the number is far likelier to be a typo or a malformed field than
 * a real deployment: an extra digit on 229,376 reads as 2,293,760, whose
 * preflight threshold no conversation ever reaches, so compaction never runs
 * again and the turn dies on a provider context error instead. The largest
 * window the pricing catalog carries today is 2M, so this admits every real
 * model while refusing an order of magnitude past it.
 */
export const MAX_CREDIBLE_CONTEXT_WINDOW = 4_000_000;

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
 * 4. The hand-kept pricing table's entry, for a model the catalog does not know.
 * 5. The conservative fallback window.
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
    const pricing = allowsImplicitModelLimits(params.vendor, params.baseUrl)
      ? lookupPricingOptional(params.vendor, params.model)
      : undefined;
    if (pricing) return { contextWindow: effectiveContextWindow(pricing), source: "pricing-catalog" };
    return { contextWindow: FALLBACK_PRICING.contextWindow, source: "fallback" };
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

export interface RouteContextWindow extends ResolvedContextWindow {
  /** The model this route runs on — `activeLlmRouteModel`'s answer. */
  readonly model: string;
  /**
   * The provider's own ceiling on a completion for this model, when it
   * reported one. Carried beside the window for a caller that needs an output
   * ceiling; the budget math does not use it.
   */
  readonly maxOutputTokens?: number;
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
): RouteContextWindow {
  const model = activeLlmRouteModel(llm);
  const block = getLlmVendorSettings(llm.vendors, llm.provider);
  const address = llmRouteCatalogAddress(llm, installedProviderPresets);
  // Standard model-list reports do not describe a project/location SDK route.
  // Older probes may have stored a dormant endpoint's report at the default key.
  const entry = llm.provider === "vertex-ai"
    ? undefined
    : cachedModelListEntry(llm.modelListCache, { ...address, model });
  // A named catalog entry describes the vendor block's own model; a
  // marketplace preset reached through the same vendor runs a model of its own.
  const catalogModel = address.credentialScope === undefined ? block.catalogModel : undefined;
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
  return {
    ...resolved,
    model,
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
    output,
    ...(unresolved ? { unresolvedCatalogModel: catalogModel } : {}),
  };
}
