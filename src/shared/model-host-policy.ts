import type { CatalogModel } from "./model-catalog/types.js";

/** Host policy owns unknown-model budgets, throttles, and request shape; never infer catalog facts from model-name spelling. */

/** The default request is a host budget, clamped to model ceilings, not a claimed model maximum. */
export const DEFAULT_LLM_OUTPUT_TOKEN_LIMIT = 32_000;

/** Report unknown-capacity budgets as fallback so diagnostics expose the guess. */
export const FALLBACK_CONTEXT_WINDOW = 128_000;

/** Reject implausibly large windows so typos cannot move compaction beyond reachable thresholds. */
export const MAX_CREDIBLE_CONTEXT_WINDOW = 4_000_000;

interface TpmDefaultRow {
  /** Apply the throttle to all declared routes, including deployments of the same model. */
  readonly vendors: readonly string[];
  /** Any model id that begins with this one, compared without regard to case. */
  readonly idPrefix: string;
  readonly tokensPerMinute: number;
}

/** Account-level token throttles can be smaller than context windows and must cap compaction thresholds. */
const TPM_DEFAULTS: readonly TpmDefaultRow[] = [
  { vendors: ["openai", "azure-foundry"], idPrefix: "gpt-5.4-mini", tokensPerMinute: 200_000 },
  { vendors: ["openai", "azure-foundry"], idPrefix: "gpt-5.4-nano", tokensPerMinute: 200_000 },
];

export function hostTpmDefault(vendor: string, model: string): number | undefined {
  const id = model.toLowerCase();
  return TPM_DEFAULTS.find((row) => row.vendors.includes(vendor) && id.startsWith(row.idPrefix))?.tokensPerMinute;
}

export interface ClaudeRequestShape {
  readonly adaptiveThinking: boolean;
  readonly numericThinking: boolean;
  readonly interleavedNumericThinking: boolean;
}

export function claudeRequestShape(model: CatalogModel | undefined): ClaudeRequestShape {
  const reasoning = model?.reasoning;
  const numericThinking = reasoning?.supported === true && reasoning.budgetTokens !== undefined;
  return {
    // Use numeric budgets when supported; qualitative-only controls use adaptive thinking without name-based guessing.
    adaptiveThinking: reasoning?.supported === true && !numericThinking && Boolean(reasoning.effort?.length),
    numericThinking,
    interleavedNumericThinking: numericThinking && model?.interleaved === true,
  };
}

/** The beta header is requested only for explicitly declared interleaving. */
export function claudeBetaHeaders(request: { interleavedThinking: boolean }): string[] {
  return request.interleavedThinking ? ["interleaved-thinking-2025-05-14"] : [];
}
