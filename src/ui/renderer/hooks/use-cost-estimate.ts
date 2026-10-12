import { useMemo } from "react";
import type { ChatEntry } from "../../../lib/chat-stream-state.js";
import { costTier, estimateTurnTokens, expectedTurnOutput, type EstimateBreakdown } from "../../../lib/cost-estimator.js";
import {
  computeCost,
  toPricingVendor,
  type PricingVendor,
  type TokenRates,
} from "../../../shared/pricing-data.js";
import { resolveModelPricing } from "../../../shared/model-pricing.js";
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

/**
 * Cost estimate hook.
 *
 * Returns the pre-send cost estimate + badge color for the draft input.
 * The expensive history serialization only depends on `entries`, so we
 * memo it separately keyed on length + last-entry identity (performance fix
 * pattern) — typing a draft in long sessions doesn't re-serialize the
 * whole conversation.
 */
export function useCostEstimate(params: CostEstimateParams): EnabledCostEstimate | DisabledCostEstimate {
  const { entries, draft, llmVendor, llmModel, maxOutputTokens, outputLimitSource, enabled = true } = params;
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

  const costEstimate = useMemo(() => {
    if (!enabled) return undefined;
    const resolved = resolveModelPricing(llmVendor ?? "", llmModel ?? "", pricingOverrides);
    const pricing = resolved.source === "unknown" ? undefined : resolved.rates;
    // Where the rates came from, or why there are none: a model the catalog
    // lists at zero is said so, never shown as a $0 estimate.
    const provenance: Pick<EstimateBreakdown, "pricingSource" | "catalogListsZero"> = resolved.source === "unknown"
      ? (resolved.catalogListsZero !== undefined ? { catalogListsZero: resolved.catalogListsZero } : {})
      : { pricingSource: resolved.source };
    const attachments = draft.attachments ?? [];
    const draftContent = toUserContentForEstimation(draft.text, attachments);
    const draftTokens = estimateOutgoingUserMessageTokens(draft.text, attachments);
    const pricingVendor = toPricingVendor(llmVendor ?? "");
    if (contextCarrierTokens !== undefined) {
      const inputTokens = contextCarrierTokens + draftTokens;
      const outputTokens = Math.max(0, maxOutputTokens);
      const { inputCost, outputCost, total } = pricing
        ? computeEstimatedCost(inputTokens, outputTokens, pricing, pricingVendor)
        : { inputCost: 0, outputCost: 0, total: 0 };
      return {
        inputTokens,
        outputTokens,
        inputCost,
        outputCost,
        total,
        pricingKnown: !!pricing,
        ...provenance,
      };
    }
    const estimated = estimateTurnTokens({ historySerialized, draft: draftContent, draftTokens, maxOutputTokens });
    if (!pricing) {
      return { ...estimated, inputCost: 0, outputCost: 0, total: 0, pricingKnown: false, ...provenance };
    }
    return {
      ...estimated,
      ...computeEstimatedCost(estimated.inputTokens, estimated.outputTokens, pricing, pricingVendor),
      pricingKnown: true,
      ...provenance,
    };
  }, [enabled, contextCarrierTokens, historySerialized, draft.text, draft.attachments, llmVendor, llmModel, maxOutputTokens, pricingOverrides]);
  // What this conversation's turns have produced, not the most a turn may:
  // the limit is the upper end of the range, never the tier on its own.
  const completedTurnOutputs = useMemo(() => {
    if (!enabled) return [];
    return entries.flatMap((entry) => (entry.kind === "turn_summary" ? [entry.tokensOut] : []));
  }, [enabled, entries.length, entries[entries.length - 1]]);
  const sourcedCostEstimate = useMemo(() => {
    if (!costEstimate) return costEstimate;
    const expectedOutput = expectedTurnOutput(completedTurnOutputs, costEstimate.outputTokens);
    const outputRate = costEstimate.outputTokens > 0 ? costEstimate.outputCost / costEstimate.outputTokens : 0;
    return {
      ...costEstimate,
      ...(outputLimitSource ? { outputLimitSource } : {}),
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
  // The `costEstimate` memo returns undefined only through the disabled branch
  // above; retain that correlation for the overload contract.
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
