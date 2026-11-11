import type { LLMSettings } from "../data/settings-store.js";
import type { LlmRouteProviderPreset } from "./context-budget.js";
import { getLlmVendorSettings, isLLMVendor } from "./llm-vendor-defaults.js";
import type { JudgeModelRef } from "../permissions/judge/judge-settings.js";
import { isSystemSubagentModelRef, systemSubagentRouteIdentity } from "./system-subagent-model.js";

export interface CompactionModelSelection {
  model: JudgeModelRef | null;
  unavailableLabel?: string;
}

export function isCompactionModelSelection(value: unknown): value is JudgeModelRef | null {
  return value === null || isSystemSubagentModelRef(value);
}

/** Preserve historical destination identity, including destinations no longer configured. */
export function compactionModelSelection(
  llm: LLMSettings,
  _presets?: readonly LlmRouteProviderPreset[],
): CompactionModelSelection {
  if (llm.compactionModelSelection !== undefined) return { model: llm.compactionModelSelection };
  const model = llm.compactionModel?.trim();
  if (!model) return { model: null };
  try {
    const parts: unknown = JSON.parse(llm.compactionModelRoute ?? "");
    if (Array.isArray(parts) && parts.length === 4 && parts[0] === "api" && typeof parts[1] === "string"
      && typeof parts[2] === "string" && typeof parts[3] === "string") {
      const [vendor, baseUrl, presetId] = parts[1].split("\n");
      if (isLLMVendor(vendor) && baseUrl !== undefined && presetId !== undefined
        && parts[1].split("\n").length === 3 && (!presetId || vendor === "openai-compatible")) {
        const block = getLlmVendorSettings(llm.vendors, vendor);
        const historical = { ...llm, vendors: { ...llm.vendors, [vendor]: {
          ...block, baseUrl: baseUrl || undefined, vertexProject: parts[2], vertexLocation: parts[3],
        } } };
        const route = systemSubagentRouteIdentity(historical, vendor,
          presetId ? [{ providerId: presetId, baseUrl }] : [], presetId || undefined);
        if (route) {
          // The old format omitted protocol identity. An endpoint change cannot establish it.
          if (vendor === "openai-compatible" && !presetId && baseUrl !== (block.baseUrl ?? "")) delete route.wire;
          return { model: { vendor, model, route } };
        }
      }
    }
  } catch { /* Unrecognized legacy choices stay visible until explicitly replaced. */ }
  return { model: null, unavailableLabel: model };
}
