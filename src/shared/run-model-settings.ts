/**
 * What a run resolved about its model, kept with the run (issue #2501): the
 * catalog it resolved against and the effective values with where each came
 * from. Carried on the turn summary and on the audit `turn` row, so a past
 * turn's window, output limit, reasoning level and prices can be read back as they
 * were — not re-derived from today's settings and today's catalog.
 */
import type { ContextWindowSource, ResolvedContextWindow, ResolvedOutputTokenLimit } from "./context-budget.js";
import type { ResolvedModelPricing } from "./model-pricing.js";

/** Numeric controls after native request serialization and its final projection. */
export interface RequestGenerationControls {
  readonly outputTokenLimit: number;
  readonly thinkingBudgetTokens?: number;
}

export interface RunModelSettings {
  /** `sha256` of the model catalog the run resolved against. */
  readonly modelCatalogSha256: string;
  readonly contextWindow: {
    readonly tokens: number;
    readonly source: ContextWindowSource;
    /** `<provider>/<id>` when the catalog answered. */
    readonly catalogEntry?: string;
    /** The prompt cap below the window that bounded the compaction budget, when one did. */
    readonly inputLimit?: { readonly tokens: number; readonly source: NonNullable<ResolvedContextWindow["inputLimitSource"]> };
  };
  /** The route's resolved output limit and its sources, before native request shaping. */
  readonly output: ResolvedOutputTokenLimit;
  /** Serialized controls when native shaping may narrow the route's resolved limits. */
  readonly requestControls?: RequestGenerationControls;
  /** The reasoning control sent, when thinking was on and the route has one. */
  readonly reasoning?: {
    readonly kind: "openai-effort" | "anthropic-adaptive" | "anthropic-numeric" | "none";
    readonly requestedEffort?: string;
    readonly effort?: string;
    readonly budgetTokens?: number;
    readonly source: "model-catalog" | "name-rule";
    readonly suppressed?: "chat-completions-tool-turn";
  };
  /**
   * Present only when the turn sent no tool definitions because the catalog
   * says the model takes none (`toolCall: false`). Absent means the turn's
   * tools were sent as usual.
   */
  readonly tools?: {
    readonly sent: false;
    readonly source: "model-catalog";
    /** The catalog entry that said so, `<provider>/<id>`. */
    readonly catalogEntry: string;
  };
  /**
   * The rates the turn's requests are priced at and who stated them (a user
   * correction, the catalog entry, the hand-kept table), or `unknown`. A past
   * turn's cost can be read back at the rates it ran under.
   */
  readonly pricing: ResolvedModelPricing;
  /**
   * The output that would still have fit the context window after the turn's
   * projected next input. Diagnostics only: requests are never clamped by it.
   */
  readonly remainingContextOutputTokens?: number;
}
