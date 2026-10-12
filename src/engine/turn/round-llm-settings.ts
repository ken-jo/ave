/**
 * The generation settings an API-backed chat round sends: the vendor block,
 * with the output limit replaced by the route's effective one and the thinking
 * budget bounded against that same limit.
 *
 * The block alone is not enough: it carries `outputTokenLimit` only when the
 * user set one, and its value is the request before the model's ceiling. A
 * round built from the bare block would send no output limit at all for the
 * default, or one the model rejects.
 */
import type { ResolvedOutputTokenLimit, RouteModelCapabilities } from "../../shared/context-budget.js";
import { normalizeLlmThinkingBudgetTokens, type LLMVendorSettings } from "../../shared/llm-vendor-defaults.js";
import type { StreamTurnParams } from "../llm/types.js";

export function apiRoundLlmSettings<Smoothing extends string>(
  block: LLMVendorSettings,
  output: ResolvedOutputTokenLimit,
  streamSmoothing: Smoothing,
  modelCapabilities?: RouteModelCapabilities,
): LLMVendorSettings & { outputTokenLimit: number; outputCeiling: Exclude<StreamTurnParams["outputCeiling"], undefined>; streamSmoothing: Smoothing; modelCapabilities?: RouteModelCapabilities } {
  return {
    ...block,
    outputTokenLimit: output.effective,
    // The ceiling the effective limit was resolved against travels with it, so
    // the transport clamps to the same one instead of rediscovering another.
    // An explicitly unknown ceiling must not trigger another name match.
    outputCeiling: output.ceiling ?? null,
    ...(modelCapabilities !== undefined ? { modelCapabilities } : {}),
    thinkingBudgetTokens: normalizeLlmThinkingBudgetTokens(block.thinkingBudgetTokens, output.effective),
    streamSmoothing,
  };
}
