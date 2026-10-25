/** Output limits remain host-owned and are forwarded as native request limits. */
import {
  freshAllVendorBlocks,
  type LLMVendor,
} from "../llm-vendor-defaults.js";

export function fakeLlmSettings(overrides: {
  provider?: LLMVendor;
  model?: string;
  /** Preset models belong in the preset slot; the generic block model names a different route. */
  marketplaceProviderPresetId?: string;
  /** Set the output ceiling on the active vendor block. */
  outputTokenLimit?: number;
} = {}) {
  const provider: LLMVendor = overrides.provider ?? "openai";
  const presetId = overrides.marketplaceProviderPresetId;
  const vendors = freshAllVendorBlocks();
  if (overrides.outputTokenLimit !== undefined) {
    vendors[provider].outputTokenLimit = overrides.outputTokenLimit;
  }
  if (overrides.model !== undefined) {
    if (presetId) vendors[provider].presetModels = { [presetId]: overrides.model };
    else vendors[provider].model = overrides.model;
  }
  return {
    provider,
    vendors,
    ...(presetId ? { marketplaceProviderPresetId: presetId } : {}),
    streamSmoothing: "none" as const,
    fallbackChain: [],
    modelListCache: {},
  };
}
