// Replace raw block limits with route-effective output controls and bound thinking to the same limit.
import type { ResolvedOutputTokenLimit, RouteContextWindow, RouteModelCapabilities } from "../../shared/context-budget.js";
import { normalizeLlmThinkingBudgetTokens, type LLMVendorSettings } from "../../shared/llm-vendor-defaults.js";
import { reasoningEffortForBudget, type ReasoningEffort } from "../../shared/reasoning-effort.js";
import type { StreamTurnParams } from "../llm/types.js";

export function apiRoundLlmSettings<Smoothing extends string>(
  block: LLMVendorSettings,
  output: ResolvedOutputTokenLimit,
  streamSmoothing: Smoothing,
  // Resolved route facts override block identity; purpose-specific callers may let transport resolve them.
  route?: Pick<RouteContextWindow, "catalogModel"> & RouteModelCapabilities,
): LLMVendorSettings & {
  outputTokenLimit: number;
  requestedOutputTokenLimit: number;
  outputCeiling: Exclude<StreamTurnParams["outputCeiling"], undefined>;
  outputCeilingSource?: StreamTurnParams["outputCeilingSource"];
  requestedThinkingBudgetTokens: number;
  reasoningEffort: ReasoningEffort;
  streamSmoothing: Smoothing;
  modelCapabilities?: RouteModelCapabilities;
} {
  const identity = route ?? block;
  return {
    ...block,
    // The named block entry may describe a different endpoint model.
    catalogModel: identity.catalogModel,
    outputTokenLimit: output.effective,
    requestedOutputTokenLimit: output.requested,
    // Carry the resolved ceiling, including explicit unknown, so transport cannot rediscover a conflicting one.
    outputCeiling: output.ceiling ?? null,
    ...(output.ceilingSource === undefined ? {} : { outputCeilingSource: output.ceilingSource }),
    requestedThinkingBudgetTokens: block.thinkingBudgetTokens,
    reasoningEffort: reasoningEffortForBudget(block.thinkingBudgetTokens),
    // Unknown resolved facts stay unknown; transport must not rematch them by name.
    ...(route !== undefined
      ? { modelCapabilities: {
          ...(route.inputModalities !== undefined ? { inputModalities: route.inputModalities } : {}),
          ...(route.toolCall !== undefined ? { toolCall: route.toolCall } : {}),
          ...(route.reasoning !== undefined ? { reasoning: route.reasoning } : {}),
        } }
      : {}),
    thinkingBudgetTokens: normalizeLlmThinkingBudgetTokens(block.thinkingBudgetTokens, output.effective),
    streamSmoothing,
  };
}
