/** Estimate pre-send costs only; post-call figures must use reported usage. */

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
  historySerialized: string[];
  draft: UserContentForTokenEstimate | undefined;
  /** Reuse canonical draft estimates to avoid serializing twice per keystroke. */
  draftTokens?: number;
  maxOutputTokens: number;
}

export interface EstimateBreakdown {
  inputTokens: number;
  outputTokens: number;
  inputCost: number;
  outputCost: number;
  total: number;
  pricingKnown?: boolean;
  outputLimitSource?: "user" | "host-default" | "provider-reported" | "model-catalog";
  pricingSource?: ModelPricingSource;
  /** A zero catalog price is source provenance, not a claim that usage is free. */
  catalogListsZero?: string;
  /** Color the badge by expected cost; show the full output limit only as the upper range bound. */
  expected?: ExpectedOutput & { total: number };
}

/** Average completed-turn output within the current limit; before the first completion, estimate input only. */
export interface ExpectedOutput {
  tokens: number;
  basis: "recent-turns" | "none";
}

const EXPECTED_OUTPUT_TURNS = 5;

export function expectedTurnOutput(completedTurnOutputs: readonly number[], maxOutputTokens: number): ExpectedOutput {
  const recent = completedTurnOutputs.filter((tokens) => Number.isFinite(tokens) && tokens >= 0).slice(-EXPECTED_OUTPUT_TURNS);
  if (recent.length === 0) return { tokens: 0, basis: "none" };
  const mean = Math.ceil(recent.reduce((sum, tokens) => sum + tokens, 0) / recent.length);
  return { tokens: Math.min(mean, Math.max(0, maxOutputTokens)), basis: "recent-turns" };
}

/** Apply price tiers to the whole prompt rather than pricing each token independently. */
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

/** Compose qualifiers around shared formatCost digits so estimates and final costs round identically. */
export function formatCostBadge(total: number, pricingKnown = true): string {
  if (!pricingKnown) return t("be_costEstimator.costUnknown");
  return `~${formatCost(total)}`;
}

export function formatCostRange(expected: number, most: number): string {
  if (formatCost(expected) === formatCost(most)) return `~${formatCost(most)}`;
  return `~${formatCost(expected)} – ${formatCost(most)}`;
}
