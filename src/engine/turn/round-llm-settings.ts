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
import type { ResolvedOutputTokenLimit } from "../../shared/context-budget.js";
import { normalizeLlmThinkingBudgetTokens, type LLMVendorSettings } from "../../shared/llm-vendor-defaults.js";

export function apiRoundLlmSettings<Smoothing extends string>(
  block: LLMVendorSettings,
  output: ResolvedOutputTokenLimit,
  streamSmoothing: Smoothing,
): LLMVendorSettings & { outputTokenLimit: number; streamSmoothing: Smoothing } {
  return {
    ...block,
    outputTokenLimit: output.effective,
    thinkingBudgetTokens: normalizeLlmThinkingBudgetTokens(block.thinkingBudgetTokens, output.effective),
    streamSmoothing,
  };
}
