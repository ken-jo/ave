/**
 * What a run resolved about its model, kept with the run (issue #2501): the
 * catalog it resolved against and the effective values with where each came
 * from. Carried on the turn summary and on the audit `turn` row, so a past
 * turn's window, output limit and reasoning level can be read back as they
 * were — not re-derived from today's settings and today's catalog.
 */
import type { ContextWindowSource, InputLimitSource, ResolvedOutputTokenLimit } from "./context-budget.js";

export interface RunModelSettings {
  /** `sha256` of the model catalog the run resolved against. */
  readonly modelCatalogSha256: string;
  readonly contextWindow: {
    readonly tokens: number;
    readonly source: ContextWindowSource;
    /** `<provider>/<id>` when the catalog answered. */
    readonly catalogEntry?: string;
    /** The prompt cap below the window that bounded the compaction budget, when one did. */
    readonly inputLimit?: { readonly tokens: number; readonly source: InputLimitSource };
  };
  /** The output limit each request carried, and its sources. */
  readonly output: ResolvedOutputTokenLimit;
  /** The reasoning control sent, when thinking was on and the route has one. */
  readonly reasoning?: {
    readonly kind: "openai-effort" | "anthropic-adaptive" | "anthropic-numeric" | "none";
    readonly requestedEffort?: string;
    readonly effort?: string;
    readonly budgetTokens?: number;
    readonly source: "model-catalog" | "name-rule";
  };
  /**
   * The output that would still have fit the context window after the turn's
   * last request input. Diagnostics only: requests are never clamped by it.
   */
  readonly remainingContextOutputTokens?: number;
}
