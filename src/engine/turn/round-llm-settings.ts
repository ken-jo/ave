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
import type { ResolvedOutputTokenLimit, RouteContextWindow, RouteModelCapabilities } from "../../shared/context-budget.js";
import { normalizeLlmThinkingBudgetTokens, type LLMVendorSettings } from "../../shared/llm-vendor-defaults.js";
import type { StreamTurnParams } from "../llm/types.js";

export function apiRoundLlmSettings<Smoothing extends string>(
  block: LLMVendorSettings,
  output: ResolvedOutputTokenLimit,
  streamSmoothing: Smoothing,
  /**
   * The route this round was resolved for: its named identity and its input
   * and tool facts. Omitted, the block's own identity applies and the
   * transport resolves capabilities itself (purpose-specific callers).
   */
  route?: Pick<RouteContextWindow, "catalogModel"> & RouteModelCapabilities,
): LLMVendorSettings & {
  outputTokenLimit: number;
  requestedOutputTokenLimit: number;
  outputCeiling: Exclude<StreamTurnParams["outputCeiling"], undefined>;
  outputCeilingSource?: StreamTurnParams["outputCeilingSource"];
  requestedThinkingBudgetTokens: number;
  streamSmoothing: Smoothing;
  modelCapabilities?: RouteModelCapabilities;
} {
  const identity = route ?? block;
  return {
    ...block,
    // The block's named entry may describe another model on this endpoint.
    catalogModel: identity.catalogModel,
    outputTokenLimit: output.effective,
    requestedOutputTokenLimit: output.requested,
    // The ceiling the effective limit was resolved against travels with it, so
    // the transport clamps to the same one instead of rediscovering another.
    // An explicitly unknown ceiling must not trigger another name match.
    outputCeiling: output.ceiling ?? null,
    ...(output.ceilingSource === undefined ? {} : { outputCeilingSource: output.ceilingSource }),
    requestedThinkingBudgetTokens: block.thinkingBudgetTokens,
    // A resolved route's facts, even when empty: an unknown fact stays unknown
    // instead of matching again by name in the transport.
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
