/** Persist the resolved catalog, effective values, and their sources with each run so historical settings are not re-derived from current state. */
import type { ContextWindowSource, ResolvedContextWindow, ResolvedOutputTokenLimit } from "./context-budget.js";
import type { ResolvedModelPricing } from "./model-pricing.js";

/** Numeric controls after native request serialization and its final projection. */
export interface RequestGenerationControls {
  readonly outputTokenLimit: number;
  readonly thinkingBudgetTokens?: number;
}

export interface RunModelSettings {
  readonly modelCatalogSha256: string;
  readonly contextWindow: {
    readonly tokens: number;
    readonly source: ContextWindowSource;
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
    readonly kind: "openai-effort" | "anthropic-adaptive" | "anthropic-numeric" | "endpoint-reasoning" | "none";
    /** The parameter an `endpoint-reasoning` request carried, as the endpoint's report named it. */
    readonly control?: "reasoning" | "reasoning_effort" | "include_reasoning";
    readonly requestedEffort?: string;
    readonly effort?: string;
    readonly budgetTokens?: number;
    readonly source: "model-catalog" | "endpoint-report" | "request-shape" | "host-fallback";
    readonly suppressed?: "chat-completions-tool-turn";
  };
  /** Present only when catalog toolCall:false suppressed all tool definitions; absence means tools were sent normally. */
  readonly tools?: {
    readonly sent: false;
    readonly source: "model-catalog";
    readonly catalogEntry: string;
  };
  /** Record the actual rates and their source, or unknown, so past costs remain reproducible. */
  readonly pricing: ResolvedModelPricing;
  /** Diagnostics only; requests are never clamped to this projected remaining window. */
  readonly remainingContextOutputTokens?: number;
}
