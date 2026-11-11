import type { LLMSettings } from "../data/settings-store.js";
import { llmRouteCatalogAddress, type LlmRouteProviderPreset } from "./context-budget.js";
import { llmModelListCacheKey } from "./llm-model-list.js";
import { getLlmVendorSettings, isLLMVendor } from "./llm-vendor-defaults.js";
import type { JudgeModelRef } from "../permissions/judge/judge-settings.js";
import { MAX_SUBSCRIPTION_RUNTIME_MODEL_ID_LENGTH } from "./subscription-runtime.js";
import { hasControlChars } from "./display-safe-text.js";

export interface CompactionModelSelection {
  model: JudgeModelRef | null;
  unavailableLabel?: string;
}

export function isCompactionModelSelection(value: unknown): value is JudgeModelRef | null {
  if (value === null) return true;
  if (typeof value !== "object" || !value || !("vendor" in value) || !("model" in value)) return false;
  return isLLMVendor(value.vendor) && typeof value.model === "string"
    && value.model.trim().length > 0 && value.model.trim().length <= MAX_SUBSCRIPTION_RUNTIME_MODEL_ID_LENGTH
    && !hasControlChars(value.model);
}

/** Resolve a stored selection without substituting an unavailable legacy route. */
export function compactionModelSelection(
  llm: LLMSettings,
  presets?: readonly LlmRouteProviderPreset[],
): CompactionModelSelection {
  if (llm.compactionModelSelection !== undefined) return { model: llm.compactionModelSelection };
  const model = llm.compactionModel?.trim();
  if (!model) return { model: null };
  try {
    const parts: unknown = JSON.parse(llm.compactionModelRoute ?? "");
    if (Array.isArray(parts) && parts.length === 4 && parts[0] === "api" && typeof parts[1] === "string") {
      const vendor = parts[1].split("\n")[0];
      if (isLLMVendor(vendor)) {
        const route = { ...llm, provider: vendor };
        const address = llmRouteCatalogAddress(route, presets);
        if (address.credentialScope && !presets?.some((preset) => preset.providerId === address.credentialScope)) {
          return { model: null, unavailableLabel: model };
        }
        const block = getLlmVendorSettings(llm.vendors, vendor);
        if (parts[1] === llmModelListCacheKey(address.vendor, address.baseUrl, address.credentialScope)
          && parts[2] === (block.vertexProject ?? "")
          && parts[3] === (block.vertexLocation ?? "")) {
          return { model: { vendor, model } };
        }
      }
    }
  } catch { /* An unrecognized legacy route stays visible until the user replaces it. */ }
  return { model: null, unavailableLabel: model };
}
