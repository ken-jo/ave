import type { LLMSettings } from "../data/settings-store.js";
import { llmRouteCatalogAddress, type LlmRouteProviderPreset } from "./context-budget.js";
import { llmModelListCacheKey } from "./llm-model-list.js";
import { getLlmVendorSettings } from "./llm-vendor-defaults.js";
import { subscriptionAcceptsModelOverride } from "./subscription-runtime.js";

/** A model id belongs to one authenticated provider namespace, including custom endpoints and project routing. */
export function compactionModelRouteKey(
  llm: LLMSettings,
  presets?: readonly LlmRouteProviderPreset[],
): string {
  if (llm.activeChatRuntime?.kind === "subscription") return JSON.stringify(["subscription", llm.activeChatRuntime.provider]);
  const address = llmRouteCatalogAddress(llm, presets);
  const block = getLlmVendorSettings(llm.vendors, llm.provider);
  return JSON.stringify(["api", llmModelListCacheKey(address.vendor, address.baseUrl, address.credentialScope), block.vertexProject ?? "", block.vertexLocation ?? ""]);
}

/** An inactive selection follows the current chat model; another route never inherits its model id. */
export function selectedCompactionModel(llm: LLMSettings, presets?: readonly LlmRouteProviderPreset[]): string | undefined {
  if (llm.activeChatRuntime?.kind === "subscription" && !subscriptionAcceptsModelOverride(llm.activeChatRuntime)) return undefined;
  return llm.compactionModelRoute === compactionModelRouteKey(llm, presets)
    ? llm.compactionModel || undefined
    : undefined;
}
