/**
 * Cost Estimator
 *
 * Pre-send cost preview for the chat input bar (the small badge next to
 * the input). Uses a chars/4 heuristic, ±20% accuracy. *Pre-send only* —
 * post-call display must use provider-reported `usage` from `turn_summary`
 * (see TokenCostBadge / useContextBudget for the post-call surfaces).
 *
 * 2026-05-07: kept as the only client-side estimator. A single
 * tiktoken-equivalent estimate is used for *prediction* before the call and
 * never reconciled against post-call reality. chars/4 is good enough for
 * "will this draft cost a lot?" vibe-check; precise figures come from the
 * provider.
 */

import { t } from "../i18n/index.js";
import {
  estimateUserMessageTokens,
  type UserContentForTokenEstimate,
} from "../shared/multimodal-token-estimate.js";
import { estimateTokens } from "../shared/token-estimate.js";
import { formatCost } from "./cost-format.js";
import type { ModelPricingSource } from "../shared/model-pricing.js";

export { estimateTokens } from "../shared/token-estimate.js";

export interface EstimateInput {
  /** Already-serialized prior history messages. */
  historySerialized: string[];
  /** The canonical draft the user is about to send, or undefined when empty. */
  draft: UserContentForTokenEstimate | undefined;
  /**
   * Optional precomputed canonical draft estimate. Renderer callers use this
   * to avoid serializing the composed draft twice per keystroke.
   */
  draftTokens?: number;
  /** Conservative max output tokens the model may produce this turn. */
  maxOutputTokens: number;
}

export interface EstimateBreakdown {
  inputTokens: number;
  outputTokens: number;
  inputCost: number;
  outputCost: number;
  total: number;
  pricingKnown?: boolean;
  /** Who set the output limit `outputTokens` assumes (see `ResolvedOutputTokenLimit.effectiveSource`). */
  outputLimitSource?: "user" | "host-default" | "provider-reported" | "model-catalog";
  /** Who stated the rates the costs use (`ResolvedModelPricing.source`), when the model is priced. */
  pricingSource?: ModelPricingSource;
  /**
   * The catalog entry that lists the model at zero, when that is why the
   * model is unpriced: the source's listing, not a claim that it is free.
   */
  catalogListsZero?: string;
  /**
   * The output this turn is expected to produce, and the total at that
   * output. `outputTokens` and `total` are the most the turn may cost — the
   * full output limit — and are shown as the upper end; the badge's tier is
   * read from the expected total, so a large limit alone does not color every
   * draft as expensive.
   */
  expected?: ExpectedOutput & { total: number };
}

/**
 * The output a turn is expected to produce: the mean output of this
 * conversation's completed turns (`recent-turns`), bounded by the limit, or
 * nothing before the first turn completes (`none`) — the estimate then
 * expects the input alone and shows the limit as the range's upper end.
 */
export interface ExpectedOutput {
  tokens: number;
  basis: "recent-turns" | "none";
}

/** Turns averaged for {@link expectedTurnOutput}: recent enough to follow the conversation's pace. */
const EXPECTED_OUTPUT_TURNS = 5;

export function expectedTurnOutput(completedTurnOutputs: readonly number[], maxOutputTokens: number): ExpectedOutput {
  const recent = completedTurnOutputs.filter((tokens) => Number.isFinite(tokens) && tokens >= 0).slice(-EXPECTED_OUTPUT_TURNS);
  if (recent.length === 0) return { tokens: 0, basis: "none" };
  const mean = Math.ceil(recent.reduce((sum, tokens) => sum + tokens, 0) / recent.length);
  return { tokens: Math.min(mean, Math.max(0, maxOutputTokens)), basis: "recent-turns" };
}

/**
 * The tokens a turn is about to send and may produce. Pricing them is
 * `computeCost`'s job, with the model's resolved rates: the rate a request
 * pays depends on its whole prompt (a price tier), not on each token alone.
 */
export function estimateTurnTokens(input: EstimateInput): Pick<EstimateBreakdown, "inputTokens" | "outputTokens"> {
  const historyTokens = input.historySerialized.reduce(
    (sum, s) => sum + estimateTokens(s),
    0,
  );
  const precomputedDraftTokens = normalizePrecomputedTokens(input.draftTokens);
  const draftTokens = precomputedDraftTokens ??
    (hasDraftPayload(input.draft) ? estimateUserMessageTokens(input.draft) : 0);
  return {
    inputTokens: historyTokens + draftTokens,
    outputTokens: Math.max(0, input.maxOutputTokens),
  };
}

function hasDraftPayload(draft: UserContentForTokenEstimate | undefined): draft is UserContentForTokenEstimate {
  return draft !== undefined && (typeof draft !== "string" || draft.length > 0) &&
    (!Array.isArray(draft) || draft.length > 0);
}

function normalizePrecomputedTokens(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.max(0, Math.ceil(value));
}

export type CostTier = "trivial" | "low" | "medium" | "high";

export function costTier(total: number): CostTier {
  if (total < 0.01) return "trivial";
  if (total < 0.1) return "low";
  if (total < 1) return "medium";
  return "high";
}

/**
 * The pre-flight estimate badge. Only the `~` prefix and the unknown-pricing
 * message belong here — the digits come from the shared `formatCost` so the
 * estimate and the post-call cost the user sees next never round differently.
 */
export function formatCostBadge(total: number, pricingKnown = true): string {
  if (!pricingKnown) return t("be_costEstimator.costUnknown");
  return `~${formatCost(total)}`;
}

/** The expected-to-most range, or the single figure when the two agree. */
export function formatCostRange(expected: number, most: number): string {
  if (formatCost(expected) === formatCost(most)) return `~${formatCost(most)}`;
  return `~${formatCost(expected)} – ${formatCost(most)}`;
}
