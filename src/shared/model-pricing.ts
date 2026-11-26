/** User corrections are whole prices. A route that does not establish the catalog model needs its own endpoint report; a recorded request URL decides the route. */
import type { TokenRateTier, TokenRates, UsageForCost } from "./pricing-data.js";
import { isPricingOverrideRate, type PricingOverride } from "./pricing-overrides.js";
import { activeModelCatalog } from "./model-catalog/active.js";
import { allowsImplicitModelLimits, resolveCatalogKey } from "./model-catalog/resolve.js";
import { vendorHasCatalogProvider } from "./model-catalog/vendor-models.js";
import type { CatalogModelCost } from "./model-catalog/types.js";
import type { LlmModelListPricing } from "./llm-model-list.js";
import { isLLMVendor, isOpenAICompatiblePresetVendor, OPENAI_COMPATIBLE_VENDOR_PRESETS } from "./llm-vendor-defaults.js";

export type ModelPricingSource = "user" | "endpoint-report" | "model-catalog";
export type UnknownModelPricingReason = "endpoint-price-unavailable" | "legacy-route-unrecorded";

export interface ModelPricingRoute {
  /** The configured endpoint the route's model list was read from; absent on a vendor's default route. */
  readonly baseUrl?: string;
  readonly reported?: LlmModelListPricing;
  /**
   * Dispatch evidence: the URL a provider request was sent to, as the transport saw it.
   * When present it decides the route; the settings only say where `reported` was listed.
   * Absent before dispatch (the pre-send estimate), where the configured endpoint is the projection.
   */
  readonly servedRequestUrl?: string;
}

function parsedUrl(value: string): URL | undefined {
  try {
    return new URL(value.trim());
  } catch {
    return undefined;
  }
}

/**
 * Whether a recorded request URL is on the vendor's own route. The identity rule stays
 * `allowsImplicitModelLimits`; a request under a preset's base is judged as that base,
 * because the rule compares base addresses and some presets select a product by path.
 */
function servedOnCatalogRoute(vendor: string, servedRequestUrl: string): boolean {
  const served = parsedUrl(servedRequestUrl);
  if (served === undefined) return false;
  if (isLLMVendor(vendor) && isOpenAICompatiblePresetVendor(vendor)) {
    const presetBaseUrl = OPENAI_COMPATIBLE_VENDOR_PRESETS[vendor].baseUrl;
    const preset = parsedUrl(presetBaseUrl);
    const prefix = preset?.pathname.replace(/\/+$/u, "");
    if (preset !== undefined && prefix !== undefined && served.origin === preset.origin
      && (served.pathname === prefix || served.pathname.startsWith(`${prefix}/`))) {
      return allowsImplicitModelLimits(vendor, presetBaseUrl);
    }
  }
  return allowsImplicitModelLimits(vendor, served.href);
}

/**
 * A model-list report prices only the endpoint that listed it. Origins are compared, not
 * paths: SDKs append versions and operations to a base address. With no configured
 * endpoint the list came from the vendor's default, so the request must be on that route.
 */
function reportListedByServedEndpoint(vendor: string, route: ModelPricingRoute, servedRequestUrl: string): boolean {
  const configured = route.baseUrl?.trim();
  if (!configured) return servedOnCatalogRoute(vendor, servedRequestUrl);
  const listed = parsedUrl(configured);
  const served = parsedUrl(servedRequestUrl);
  return listed !== undefined && served !== undefined && listed.origin === served.origin;
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
  const served = route?.servedRequestUrl;
  const routeEstablishesModel = served !== undefined
    ? servedOnCatalogRoute(vendor, served)
    : allowsImplicitModelLimits(vendor, route?.baseUrl);
  const needsEndpointPrice = !routeEstablishesModel
    || (route !== undefined && (!isLLMVendor(vendor) || !vendorHasCatalogProvider(vendor)));
  const reportedRates = route?.reported !== undefined
    && (served === undefined || reportListedByServedEndpoint(vendor, route, served))
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
