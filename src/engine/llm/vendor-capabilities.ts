// Refuse unsupported image sends without dropping parts; only stated image modality grants support.
// File attachment support describes agent-readable paths, not model image input.
import type { LLMVendor } from "./types.js";
import { isSelfHostedVllmVendor } from "../../shared/llm-vendor-defaults.js";
import { resolveInputModalities, type RouteInputModalities } from "../../shared/context-budget.js";
import type {
  MarketplaceInstalledProviderPreset,
  MarketplaceProviderPackageAsset,
} from "../../shared/marketplace-package-assets.js";

type ProviderPackageCapabilitySource =
  | Pick<MarketplaceInstalledProviderPreset, "capabilities">
  | Pick<MarketplaceProviderPackageAsset, "capabilities">
  | undefined;

/** Use resolved route modalities as authoritative; never infer missing support from a model name. */
export function supportsVision(
  vendor: LLMVendor,
  model: string,
  route?: RouteInputModalities,
): boolean {
  const m = model.trim();
  if (m.length === 0) return false;
  const stated = route ? route.inputModalities : resolveInputModalities({ vendor, model: m });
  return stated?.input.includes("image") === true;
}

/** Continue truncated output only on routes supporting native assistant prefill.
 * Share the capability predicate with request shaping so advertised and sent behavior agree. */
export function vendorSupportsLengthContinuation(vendor: LLMVendor): boolean {
  return isSelfHostedVllmVendor(vendor);
}

export function providerPackageSupportsReviewerAdapter(
  metadata: ProviderPackageCapabilitySource,
): boolean {
  return metadata?.capabilities?.reviewerAdapter === true;
}
