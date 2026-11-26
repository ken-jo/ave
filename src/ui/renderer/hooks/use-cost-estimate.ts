import { useMemo } from "react";
import type { ChatEntry } from "../../../lib/chat-stream-state.js";
import { costTier, estimateTurnTokens, expectedTurnOutput, type EstimateBreakdown } from "../../../lib/cost-estimator.js";
import {
  computeCost,
  toPricingVendor,
  type PricingVendor,
  type TokenRates,
} from "../../../shared/pricing-data.js";
import { resolveModelPricing, type ModelPricingRoute } from "../../../shared/model-pricing.js";
import { usePricingOverrides } from "./use-pricing-overrides.js";
import {
  estimateOutgoingUserMessageTokens,
  toUserContentForEstimation,
} from "../../../shared/multimodal-token-estimate.js";
import type { ComposedOutgoing } from "../utils/compose.js";

type CostEstimateParams = {
  entries: ChatEntry[];
  /** Already-composed draft snapshot; App shares this with the context ring. */
  draft: Pick<ComposedOutgoing, "text"> & Partial<Pick<ComposedOutgoing, "attachments">>;
  /** Omit when the active runtime has no verified billing contract. */
  llmVendor?: string;
  /** Omit when the active runtime has no verified billing contract. */
  llmModel?: string;
  /** The route's configured endpoint and its own price report (`resolveModelPricing`'s route), projected before any request is sent. */
  pricingRoute?: ModelPricingRoute;
  /** The route's effective output limit: the most a reply may cost in output. */
  maxOutputTokens: number;
  /** Who set that limit, shown beside the output estimate. */
  outputLimitSource?: EstimateBreakdown["outputLimitSource"];

  /** False suppresses all API-model-derived billing estimates. */
  enabled?: boolean;
};

type EnabledCostEstimate = { costEstimate: EstimateBreakdown; costBadgeClass: string };
type DisabledCostEstimate = { costEstimate: undefined; costBadgeClass: undefined };

export function useCostEstimate(params: CostEstimateParams & { enabled?: true }): EnabledCostEstimate;
export function useCostEstimate(params: CostEstimateParams & { enabled: false }): DisabledCostEstimate;
export function useCostEstimate(params: CostEstimateParams & { enabled: boolean }): EnabledCostEstimate | DisabledCostEstimate;

/** Memoize history serialization separately from draft changes so typing in long sessions does not reserialize the
 * transcript. */
export function useCostEstimate(params: CostEstimateParams): EnabledCostEstimate | DisabledCostEstimate {
  const { entries, draft, llmVendor, llmModel, pricingRoute, maxOutputTokens, outputLimitSource, enabled = true } = params;
  const pricingOverrides = usePricingOverrides();

  const contextCarrierTokens = useMemo(() => {
    if (!enabled) return undefined;
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (entry?.kind === "turn_summary" || entry?.kind === "context_usage") {
        return Math.max(0, entry.tokensIn);
      }
    }
    return undefined;
  }, [enabled, entries.length, entries[entries.length - 1]]);

  const historySerialized = useMemo(() => {
    if (!enabled || contextCarrierTokens !== undefined) return [];
    return entries.map((e) => {
      if (e.kind === "user" || e.kind === "assistant" || e.kind === "reasoning" || e.kind === "system") {
        return JSON.stringify({ kind: e.kind, text: (e as { text?: string }).text ?? "" });
      }
      if (e.kind === "tool_group") {
        return JSON.stringify({
          kind: "tool_group",
          tools: (e.tools ?? []).map((t: { input?: unknown; result?: unknown }) => ({
            input: t.input ?? {},
            result: t.result ?? "",
          })),
        });
      }
      return "";
    }).filter(Boolean);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, contextCarrierTokens, entries.length, entries[entries.length - 1]]);

  const costEstimate = useMemo<EstimateBreakdown | undefined>(() => {
    if (!enabled) return undefined;
    const resolved = resolveModelPricing(llmVendor ?? "", llmModel ?? "", pricingOverrides, pricingRoute);
    const attachments = draft.attachments ?? [];
    const draftContent = toUserContentForEstimation(draft.text, attachments);
    const draftTokens = estimateOutgoingUserMessageTokens(draft.text, attachments);
    const estimated = contextCarrierTokens !== undefined
      ? { inputTokens: contextCarrierTokens + draftTokens, outputTokens: Math.max(0, maxOutputTokens) }
      : estimateTurnTokens({ historySerialized, draft: draftContent, draftTokens, maxOutputTokens });
    if (resolved.source === "unknown") {
      return {
        ...estimated,
        pricingKnown: false,
        ...(resolved.catalogListsZero !== undefined ? { catalogListsZero: resolved.catalogListsZero } : {}),
        ...(resolved.reason !== undefined ? { reason: resolved.reason } : {}),
      };
    }
    const amounts = computeEstimatedCost(estimated.inputTokens, estimated.outputTokens, resolved.rates, toPricingVendor(llmVendor ?? ""));
    if (!Number.isFinite(amounts.total)) return { ...estimated, pricingKnown: false };
    return {
      ...estimated,
      ...amounts,
      pricingKnown: true,
      pricingSource: resolved.source,
    };
  }, [enabled, contextCarrierTokens, historySerialized, draft.text, draft.attachments, llmVendor, llmModel, pricingRoute, maxOutputTokens, pricingOverrides]);
  // What this conversation's turns have produced, not the most a turn may: the limit is the upper end of the range, never
  // the tier on its own.
  const completedTurnOutputs = useMemo(() => {
    if (!enabled) return [];
    return entries.flatMap((entry) => (entry.kind === "turn_summary" ? [entry.tokensOut] : []));
  }, [enabled, entries.length, entries[entries.length - 1]]);
  const sourcedCostEstimate = useMemo<EstimateBreakdown | undefined>(() => {
    if (!costEstimate) return costEstimate;
    const expectedOutput = expectedTurnOutput(completedTurnOutputs, costEstimate.outputTokens);
    const limit = outputLimitSource ? { outputLimitSource } : {};
    if (costEstimate.pricingKnown === false) return { ...costEstimate, ...limit, expected: expectedOutput };
    const outputRate = costEstimate.outputTokens > 0 ? costEstimate.outputCost / costEstimate.outputTokens : 0;
    return {
      ...costEstimate,
      ...limit,
      expected: { ...expectedOutput, total: costEstimate.inputCost + expectedOutput.tokens * outputRate },
    };
  }, [costEstimate, outputLimitSource, completedTurnOutputs]);

  const costBadgeClass = useMemo(() => {
    if (!sourcedCostEstimate) return undefined;
    if (sourcedCostEstimate.pricingKnown === false) return "text-muted-foreground";
    const t = costTier(sourcedCostEstimate.expected?.total ?? sourcedCostEstimate.total);
    if (t === "trivial") return "text-muted-foreground";
    if (t === "low") return "text-success";
    if (t === "medium") return "text-warning";
    return "text-destructive";
  }, [sourcedCostEstimate]);

  if (!enabled) {
    return { costEstimate: undefined, costBadgeClass: undefined };
  }
  // The `costEstimate` memo returns undefined only through the disabled branch above; retain that correlation for the
  // overload contract.
  return { costEstimate: sourcedCostEstimate!, costBadgeClass: costBadgeClass! };
}

function computeEstimatedCost(
  inputTokens: number,
  outputTokens: number,
  pricing: TokenRates,
  vendor: PricingVendor,
): { inputCost: number; outputCost: number; total: number } {
  const inputCost = computeCost({ inputTokens, outputTokens: 0 }, pricing, vendor);
  const total = computeCost({ inputTokens, outputTokens }, pricing, vendor);
  return {
    inputCost,
    outputCost: Math.max(0, total - inputCost),
    total,
  };
}
