/** User corrections are whole prices. A route that does not establish the catalog model needs its own endpoint report; a recorded request URL decides the route. */
import type { TokenRateTier, TokenRates, UsageForCost } from "./pricing-data.js";
import { isPricingOverrideRate, type PricingOverride } from "./pricing-overrides.js";
import { activeModelCatalog } from "./model-catalog/active.js";
import { allowsImplicitModelLimits, resolveCatalogKey } from "./model-catalog/resolve.js";
import { vendorHasCatalogProvider } from "./model-catalog/vendor-models.js";
import type { CatalogModelCost } from "./model-catalog/types.js";
import type { LlmModelListPricing } from "./llm-model-list.js";
import { isLLMVendor, isOpenAICompatiblePresetVendor, OPENAI_COMPATIBLE_VENDOR_PRESETS, type LLMVendor } from "./llm-vendor-defaults.js";

export type ModelPricingSource = "user" | "endpoint-report" | "model-catalog";
export type UnknownModelPricingReason = "endpoint-price-unavailable" | "legacy-route-unrecorded";

/**
 * What a request's transport established about where it was served. Decided at dispatch
 * and carried on the request's usage; it holds no request path, so a credential in a
 * configured path cannot leave the transport through it.
 */
export type ServedRouteEvidence =
  /**
   * The response came from the vendor's own API base; `base` is that canonical address.
   * `configuredBaseId` is present when an endpoint was configured and the response came
   * from under it.
   */
  | { readonly kind: "vendor-native"; readonly base: string; readonly configuredBaseId?: string }
  /** The response came from under the provider's configured endpoint, named only by a process-keyed id of that setting. */
  | { readonly kind: "configured-endpoint"; readonly origin: string; readonly configuredBaseId: string }
  /** Neither could be established: a redirect out of the configured endpoint, or an address nothing configured. */
  | { readonly kind: "unknown"; readonly origin?: string };

/** The served route as pricing judges it; `base` values come from settings or the canonical table. */
export type ServedPricingRoute =
  /** `base` is the endpoint whose model list may price it; absent when another endpoint's setting served. */
  | { readonly kind: "vendor-native"; readonly base?: string }
  /** Served by the configured endpoint the route's model list is keyed on. */
  | { readonly kind: "report-endpoint"; readonly base: string }
  | { readonly kind: "unknown" };

export interface ModelPricingRoute {
  /** The configured endpoint; absent on a vendor's default route. Projects the route before any request is sent. */
  readonly baseUrl?: string;
  readonly reported?: LlmModelListPricing;
  /** The address the model list holding `reported` was read from (the cache row's `endpoint`). */
  readonly reportedAt?: string;
  /** Dispatch evidence. When present it decides the route and `baseUrl` is not consulted. */
  readonly served?: ServedPricingRoute;
}

function parsedUrl(value: string): URL | undefined {
  try {
    return new URL(value.trim());
  } catch {
    return undefined;
  }
}

/** Same origin and the base's path as a whole-segment prefix; the base's query is not part of it. */
export function urlIsUnderBase(url: string, base: string): boolean {
  const target = parsedUrl(url);
  const root = parsedUrl(base);
  if (target === undefined || root === undefined || target.origin !== root.origin) return false;
  const prefix = root.pathname.replace(/\/+$/u, "");
  return target.pathname === prefix || target.pathname.startsWith(`${prefix}/`);
}

/**
 * The address discovery reads a base's model list from, as it writes it to the cache row:
 * `<base>/models`, without a trailing slash, query or fragment. Discovery refuses a base
 * that embeds credentials, so such a base has no list.
 */
function modelListAddress(base: string): string | undefined {
  const url = parsedUrl(`${base.trim().replace(/\/+$/u, "")}/`);
  if (url === undefined || (url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) return undefined;
  const pathname = url.pathname.replace(/\/+$/u, "");
  url.pathname = pathname.endsWith("/models") ? pathname : `${pathname}/models`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

/** Whether `listedAt` is the model list of `base` itself: the same address, not one beneath it. */
export function isModelListOfBase(listedAt: string, base: string): boolean {
  const listed = parsedUrl(listedAt);
  return listed !== undefined && listed.toString() === modelListAddress(base);
}

/** The default API base of each first-party SDK; regional hosts serve the same path. */
const DEFAULT_NATIVE_API_BASES: Partial<Record<LLMVendor, string>> = {
  openai: "https://api.openai.com/v1",
  claude: "https://api.anthropic.com/v1",
  gemini: "https://generativelanguage.googleapis.com/v1beta",
};

/** Hosts the Vertex SDK builds for a location: global, `<region>-`, and the `eu`/`us` multi-region hosts. */
const VERTEX_API_HOST = /^(?:[a-z0-9-]+-)?aiplatform\.googleapis\.com$|^aiplatform\.(?:eu|us)\.rep\.googleapis\.com$/u;
const VERTEX_API_PATH = /^\/v1(?:beta1)?\/(?:projects\/[^/]+\/locations\/[^/]+\/)?publishers\/google(?:\/|$)/u;

/**
 * The vendor's canonical API base an address is served under, or `undefined`. A vendor's
 * published price holds only there: the same host can serve other products on other paths.
 */
export function vendorNativeBase(vendor: string, address: string): string | undefined {
  const url = parsedUrl(address);
  if (url === undefined || !isLLMVendor(vendor)) return undefined;
  if (isOpenAICompatiblePresetVendor(vendor)) {
    const preset = parsedUrl(OPENAI_COMPATIBLE_VENDOR_PRESETS[vendor].baseUrl);
    if (preset === undefined) return undefined;
    const base = `${preset.origin}${preset.pathname.replace(/\/+$/u, "")}`;
    return urlIsUnderBase(url.href, base) ? base : undefined;
  }
  if (url.protocol !== "https:" || url.port !== "") return undefined;
  if (vendor === "vertex-ai") {
    const version = VERTEX_API_HOST.test(url.hostname) ? VERTEX_API_PATH.exec(url.pathname) : null;
    return version ? `${url.origin}/${url.pathname.split("/")[1]}` : undefined;
  }
  const standard = DEFAULT_NATIVE_API_BASES[vendor];
  // The host rule is the shared one; the path is what narrows a host to the vendor's API.
  if (standard === undefined || !allowsImplicitModelLimits(vendor, url.origin)) return undefined;
  const base = `${url.origin}${new URL(standard).pathname}`;
  return urlIsUnderBase(url.href, base) ? base : undefined;
}

/** The address a route with no configured endpoint lists its models from. */
export function vendorDefaultApiBase(vendor: string): string | undefined {
  if (!isLLMVendor(vendor)) return undefined;
  return isOpenAICompatiblePresetVendor(vendor)
    ? OPENAI_COMPATIBLE_VENDOR_PRESETS[vendor].baseUrl
    : DEFAULT_NATIVE_API_BASES[vendor];
}

/** Read persisted legacy price provenance unchanged; new resolution never emits that source. */
type RecordedModelPricingSource = ModelPricingSource | "pricing-catalog";

export type ResolvedModelPricing<Source extends RecordedModelPricingSource = ModelPricingSource> =
  | {
      readonly source: Source;
      readonly rates: TokenRates;
      /** `<provider>/<id>` when the catalog answered. */
      readonly catalogEntry?: string;
    }
  | {
      readonly source: "unknown";
      readonly reason?: UnknownModelPricingReason;
      /** The catalog entry that lists the model at zero, when one does: listed, not free. */
      readonly catalogListsZero?: string;
    };

export type RecordedModelPricing = ResolvedModelPricing<RecordedModelPricingSource>;

export const LEGACY_ROUTE_UNRECORDED = { source: "unknown", reason: "legacy-route-unrecorded" } as const;

export type KnownModelPricing = Extract<RecordedModelPricing, { rates: TokenRates }>;

export interface ModelUsageSegment<Vendor extends string = string> {
  vendorProvider: Vendor;
  vendorModel: string;
  tokenUsage: UsageForCost;
  /** Absent only for records predating captured request prices. */
  pricing?: RecordedModelPricing;
}

/** Older segments can use the primary snapshot when both recorded route labels match. */
export function recordedUsageSegmentPricing(
  segment: Pick<ModelUsageSegment, "vendorProvider" | "vendorModel" | "pricing">,
  primary: { vendorProvider?: string; vendorModel?: string; pricing?: RecordedModelPricing },
): RecordedModelPricing | undefined {
  if (segment.pricing !== undefined) return parseResolvedModelPricing(segment.pricing);
  if (primary.vendorProvider === segment.vendorProvider && primary.vendorModel === segment.vendorModel) {
    return primary.pricing;
  }
  return undefined;
}

const OPTIONAL_TOKEN_RATE_FIELDS = ["cacheReadPer1M", "cacheWritePer1M", "reasoningPer1M"] as const;
const OPTIONAL_TIER_RATE_FIELDS = ["inputPer1M", "outputPer1M", "cacheReadPer1M", "cacheWritePer1M"] as const;

/** Convert persisted surcharge snapshots into equivalent whole-request tiers, preserving input/cache and output/reasoning multipliers. */
function recordedSurchargeTier(raw: Record<string, unknown>, rates: TokenRates): TokenRateTier | undefined | null {
  const threshold = raw.surchargeInputThreshold;
  const inputMultiplier = raw.surchargeInputMultiplier ?? 1;
  const outputMultiplier = raw.surchargeOutputMultiplier ?? 1;
  // Multipliers without a threshold never applied.
  if (threshold === undefined) return undefined;
  if (!isPricingOverrideRate(threshold) || !isPricingOverrideRate(inputMultiplier) || !isPricingOverrideRate(outputMultiplier)) return null;
  if (rates.reasoningPer1M !== undefined && outputMultiplier !== 1) return null;
  const tier = {
    afterInputTokens: threshold,
    inputPer1M: rates.inputPer1M * inputMultiplier,
    outputPer1M: rates.outputPer1M * outputMultiplier,
    cacheReadPer1M: (rates.cacheReadPer1M ?? rates.inputPer1M) * inputMultiplier,
    cacheWritePer1M: (rates.cacheWritePer1M ?? rates.inputPer1M) * inputMultiplier,
  };
  return OPTIONAL_TIER_RATE_FIELDS.every((key) => isPricingOverrideRate(tier[key])) ? tier : null;
}

/** Validate every numeric field before copying IPC or persisted price snapshots. */
export function parseResolvedModelPricing(value: unknown): RecordedModelPricing | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const obj = value as Record<string, unknown>;
  if (obj.source === "unknown") {
    return {
      source: "unknown",
      ...(obj.reason === "endpoint-price-unavailable" || obj.reason === "legacy-route-unrecorded"
        ? { reason: obj.reason } : {}),
      ...(typeof obj.catalogListsZero === "string" ? { catalogListsZero: obj.catalogListsZero } : {}),
    };
  }
  if (obj.source !== "user" && obj.source !== "endpoint-report" && obj.source !== "model-catalog"
    && obj.source !== "pricing-catalog") return undefined;
  if (!obj.rates || typeof obj.rates !== "object" || Array.isArray(obj.rates)) return undefined;
  const raw = obj.rates as Record<string, unknown>;
  if (!isPricingOverrideRate(raw.inputPer1M) || !isPricingOverrideRate(raw.outputPer1M)) return undefined;
  const rates: TokenRates = { inputPer1M: raw.inputPer1M, outputPer1M: raw.outputPer1M };
  for (const key of OPTIONAL_TOKEN_RATE_FIELDS) {
    if (raw[key] === undefined) continue;
    if (!isPricingOverrideRate(raw[key])) return undefined;
    rates[key] = raw[key];
  }
  if (raw.reasoningRateScope !== undefined) {
    if (raw.reasoningRateScope !== "output") return undefined;
    rates.reasoningRateScope = "output";
  }
  if (raw.tiers !== undefined) {
    if (!Array.isArray(raw.tiers)) return undefined;
    const tiers: TokenRateTier[] = [];
    for (const value of raw.tiers) {
      if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
      const rawTier = value as Record<string, unknown>;
      if (!isPricingOverrideRate(rawTier.afterInputTokens)) return undefined;
      const tier: TokenRateTier = { afterInputTokens: rawTier.afterInputTokens };
      for (const key of OPTIONAL_TIER_RATE_FIELDS) {
        if (rawTier[key] === undefined) continue;
        if (!isPricingOverrideRate(rawTier[key])) return undefined;
        tier[key] = rawTier[key];
      }
      tiers.push(tier);
    }
    rates.tiers = tiers;
  }
  const surchargeTier = recordedSurchargeTier(raw, rates);
  if (surchargeTier === null) return undefined;
  if (surchargeTier !== undefined) {
    // Legacy surcharge snapshots did not also carry tiers.
    if (rates.tiers !== undefined) return undefined;
    rates.tiers = [surchargeTier];
  }
  return {
    source: obj.source,
    rates,
    ...(typeof obj.catalogEntry === "string" ? { catalogEntry: obj.catalogEntry } : {}),
  };
}

export function resolveModelPricing(
  vendor: string,
  model: string,
  overrides: readonly PricingOverride[] = [],
  route?: ModelPricingRoute,
): ResolvedModelPricing {
  const override = overrides.find((entry) => entry.vendor === vendor && entry.model === model);
  if (override) {
    return {
      source: "user",
      rates: {
        inputPer1M: override.inputPer1M,
        outputPer1M: override.outputPer1M,
        ...(override.cacheReadPer1M !== undefined ? { cacheReadPer1M: override.cacheReadPer1M } : {}),
        ...(override.cacheWritePer1M !== undefined ? { cacheWritePer1M: override.cacheWritePer1M } : {}),
      },
    };
  }
  const served = route?.served;
  const routeEstablishesModel = served !== undefined
    ? served.kind === "vendor-native"
    : allowsImplicitModelLimits(vendor, route?.baseUrl);
  const needsEndpointPrice = !routeEstablishesModel
    || (route !== undefined && (!isLLMVendor(vendor) || !vendorHasCatalogProvider(vendor)));
  // A report prices only the endpoint that listed it: its list must have been read at the
  // model-list address of the base that served, or before dispatch of the base the route
  // projects. A list from beneath that base (another tenant's path) is not that base's
  // list. A list filed under one endpoint but read from another is kept for everything
  // else and is simply not price evidence.
  const reportBase = served === undefined
    ? route?.baseUrl?.trim() || vendorDefaultApiBase(vendor)
    : served.kind === "unknown" ? undefined : served.base;
  const reportApplies = route?.reportedAt !== undefined && reportBase !== undefined && isModelListOfBase(route.reportedAt, reportBase);
  const reportedRates = route?.reported !== undefined && reportApplies
    ? endpointTokenRates(route.reported)
    : undefined;
  if (needsEndpointPrice) {
    return reportedRates !== undefined
      ? { source: "endpoint-report", rates: reportedRates }
      : { source: "unknown", reason: "endpoint-price-unavailable" };
  }
  const hit = resolveCatalogKey(activeModelCatalog(), vendor, model);
  const catalogEntry = hit ? `${hit.provider}/${hit.id}` : undefined;
  const catalogRates = hit?.model.cost ? catalogTokenRates(hit.model.cost, hit.provider) : undefined;
  const catalogPrices = catalogEntry !== undefined && catalogRates !== undefined && listsAPrice(catalogRates);
  if (catalogPrices) {
    return { source: "model-catalog", rates: catalogRates, catalogEntry };
  }
  if (reportedRates !== undefined) return { source: "endpoint-report", rates: reportedRates };
  // A report exists but belongs to another address: say so, as for any route without its own price.
  if (route?.reported !== undefined && !reportApplies) return { source: "unknown", reason: "endpoint-price-unavailable" };
  return catalogEntry !== undefined && catalogRates !== undefined
    ? { source: "unknown", catalogListsZero: catalogEntry }
    : { source: "unknown" };
}

export function knownModelPricing(pricing: RecordedModelPricing): KnownModelPricing | undefined {
  return pricing.source === "unknown" ? undefined : pricing;
}

/** Both input and output rates are required; one missing side is unknown, never zero. */
function catalogTokenRates(cost: CatalogModelCost, provider: string): TokenRates | undefined {
  if (cost.input === undefined || cost.output === undefined) return undefined;
  const tiers: TokenRateTier[] = (cost.tiers ?? [])
    .map((tier) => ({
      afterInputTokens: tier.afterInputTokens,
      ...(tier.input !== undefined ? { inputPer1M: tier.input } : {}),
      ...(tier.output !== undefined ? { outputPer1M: tier.output } : {}),
      ...(tier.cacheRead !== undefined ? { cacheReadPer1M: tier.cacheRead } : {}),
      ...(tier.cacheWrite !== undefined ? { cacheWritePer1M: tier.cacheWrite } : {}),
    }))
    .sort((left, right) => left.afterInputTokens - right.afterInputTokens);
  return {
    inputPer1M: cost.input,
    outputPer1M: cost.output,
    ...(cost.cacheRead !== undefined ? { cacheReadPer1M: cost.cacheRead } : {}),
    ...(cost.cacheWrite !== undefined ? { cacheWritePer1M: cost.cacheWrite } : {}),
    // A listed zero reasoning rate does not imply free reasoning; use output price.
    ...(cost.reasoning !== undefined && cost.reasoning > 0 ? { reasoningPer1M: cost.reasoning } : {}),
    // Thinking-mode output rates cover both reasoning and answer tokens.
    ...(provider === "alibaba-cn" && cost.reasoning !== undefined && cost.reasoning > 0
      ? { reasoningRateScope: "output" as const }
      : {}),
    ...(tiers.length > 0 ? { tiers } : {}),
  };
}

/** Reports are USD-per-token decimal strings; require nonnegative input and output with at least one nonzero. Ignore malformed optional cache or reasoning rates. */
function endpointTokenRates(pricing: LlmModelListPricing): TokenRates | undefined {
  const inputPer1M = perMillion(pricing.prompt);
  const outputPer1M = perMillion(pricing.completion);
  if (inputPer1M === undefined || outputPer1M === undefined) return undefined;
  const rates: TokenRates = { inputPer1M, outputPer1M };
  const cacheReadPer1M = perMillion(pricing.inputCacheRead);
  const cacheWritePer1M = perMillion(pricing.inputCacheWrite);
  const reasoningPer1M = perMillion(pricing.internalReasoning);
  if (cacheReadPer1M !== undefined) rates.cacheReadPer1M = cacheReadPer1M;
  if (cacheWritePer1M !== undefined) rates.cacheWritePer1M = cacheWritePer1M;
  // Use output price when reported reasoning price is zero.
  if (reasoningPer1M !== undefined && reasoningPer1M > 0) rates.reasoningPer1M = reasoningPer1M;
  return listsAPrice(rates) ? rates : undefined;
}

/** Convert per-token decimal strings to per-million rates. */
function perMillion(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+(?:\.\d+)?(?:[eE][-+]?\d+)?$/u.test(value.trim())) return undefined;
  // Strip binary-float noise and validate after both scaling and rounding.
  const rate = Number((Number(value.trim()) * 1_000_000).toPrecision(12));
  return isPricingOverrideRate(rate) ? rate : undefined;
}

/** Catalog-listed zero rates remain source data, not a displayed free price. */
function listsAPrice(rates: TokenRates): boolean {
  return rates.inputPer1M > 0 || rates.outputPer1M > 0;
}
