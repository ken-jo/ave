/**
 * Which reasoning control a request carries, and at what level.
 *
 * The catalog states, per model, whether it reasons and which qualitative
 * effort levels it accepts. Where it states them, that list decides: the
 * level Ave's budget maps to is sent if the model accepts it, otherwise the
 * nearest accepted level below it (the lowest accepted level when none is
 * below), and the change is reported. Where nobody states the levels — the
 * catalog does not know the model, lists no levels for it, or the route's
 * endpoint does not establish its identity — an OpenAI-family request carries
 * no `reasoning_effort` (source `host-fallback`): a level guessed from the
 * model's name is a 400 on a model that does not take it. Naming the entry the
 * endpoint serves (`llm.vendors.<vendor>.catalogModel`) supplies the levels.
 *
 * Request SHAPE stays out of this: whether a Claude model takes adaptive or
 * numeric thinking, whether numeric thinking interleaves with tools, and
 * whether an OpenAI model is reached over the Responses API are properties of
 * the wire the catalog does not describe (it lists effort levels for models
 * that take numeric thinking), so they are host rules in the request-shape
 * table (`shared/model-host-policy.ts`).
 *
 * The adapter applies {@link planReasoning}; the conversation loop records the
 * same function's answer in the turn summary, so the record is what was sent.
 */
import { catalogModelFor } from "../../shared/context-budget.js";
import type { LLMVendor } from "../../shared/llm-vendor-defaults.js";
import { claudeRequestShape, usesOpenAIResponsesWire } from "../../shared/model-host-policy.js";

/**
 * Map Ave thinking budget (tokens) to OpenAI reasoning_effort.
 *   budget ≤   500 → "none"
 *   budget ≤ 3 000 → "low"
 *   budget > 8 000 → "high"
 *   else           → "medium"
 */
export function mapReasoningEffort(
  budget: number,
): "none" | "low" | "medium" | "high" {
  if (budget <= 500) return "none";
  if (budget <= 3000) return "low";
  if (budget > 8000) return "high";
  return "medium";
}

/**
 * Map Ave thinking budget (tokens) to Anthropic adaptive-thinking effort.
 *   budget ≤ 3 000 → "low"
 *   budget ≤ 6 000 → "medium"
 *   budget ≤ 16 000 → "high"
 *   budget >  16 000 → "max"
 * Numeric thinking routes use their token budget directly.
 */
export function mapBudgetToEffort(
  budget: number,
): "low" | "medium" | "high" | "max" {
  if (budget <= 3000) return "low";
  if (budget <= 6000) return "medium";
  if (budget <= 16_000) return "high";
  return "max";
}

/** Qualitative levels from least to most reasoning; `default` is not a level. */
const EFFORT_ORDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
type EffortLevel = (typeof EFFORT_ORDER)[number];

/** The accepted level nearest `requested` from below, else the lowest accepted; `undefined` when none is accepted. */
function nearestAcceptedEffort(requested: EffortLevel, accepted: readonly string[]): EffortLevel | undefined {
  const levels = EFFORT_ORDER.filter((level) => accepted.includes(level));
  if (levels.length === 0) return undefined;
  const at = EFFORT_ORDER.indexOf(requested);
  const below = levels.filter((level) => EFFORT_ORDER.indexOf(level) <= at);
  return below.at(-1) ?? levels[0];
}

type ReasoningPlanSource = "model-catalog" | "request-shape" | "host-fallback";

/** What a request's reasoning control is, as the adapter sends it. */
export interface ReasoningPlan {
  /**
   * `openai-effort`: `reasoning_effort` on an OpenAI-family route;
   * `anthropic-adaptive`: adaptive thinking with an effort;
   * `anthropic-numeric`: a numeric thinking budget;
   * `none`: the route sends no reasoning control from this plan.
   */
  readonly kind: "openai-effort" | "anthropic-adaptive" | "anthropic-numeric" | "none";
  /** The level Ave's budget maps to, for an effort kind. */
  readonly requestedEffort?: EffortLevel;
  /** The level sent; differs from `requestedEffort` when the model does not accept it. */
  readonly effort?: EffortLevel;
  /** The numeric budget, for `anthropic-numeric`. */
  readonly budgetTokens?: number;
  /**
   * Which knowledge decided: the catalog entry; the request-shape table, for a
   * Claude model whose reasoning the catalog does not state (adaptive or
   * numeric thinking is a wire rule); or the host fallback, which sends no
   * effort when nobody states the levels an OpenAI-family model accepts.
   */
  readonly source: ReasoningPlanSource;
  /**
   * The effort the route would carry was dropped for this request: a tool turn
   * on Chat Completions (see {@link chatCompletionsRejectsToolTurnEffort}).
   */
  readonly suppressed?: "chat-completions-tool-turn";
}

/**
 * Whether this request must not carry `reasoning_effort`: Chat Completions
 * answers 400 when GPT-5.x gets it together with tools. The actual protocol
 * selected by the adapter decides this; changing an endpoint does not change
 * that protocol. The responses wire has no such restriction.
 * One rule for the request and for the turn's record of it.
 */
function chatCompletionsRejectsToolTurnEffort(params: {
  vendor: LLMVendor;
  model: string;
  hasTools: boolean;
  baseUrl?: string;
  catalogModel?: string;
}): boolean {
  const identity = catalogModelFor(params.vendor, params.model, params.catalogModel, params.baseUrl)?.id;
  if (!params.hasTools || ![params.model, identity ?? ""].some((model) => model.toLowerCase().includes("gpt-5"))) return false;
  return OPENAI_FAMILY.has(params.vendor) && !usesOpenAIResponsesWire(params.vendor, params.model);
}

const OPENAI_FAMILY: ReadonlySet<LLMVendor> = new Set(["openai", "copilot", "azure-foundry"]);

/**
 * The reasoning control for one request. `undefined` when thinking is off or
 * the route has no reasoning control this plan owns (self-hosted routes pass
 * their numeric budget through the compatibility options on their own).
 */
export function planReasoning(params: {
  vendor: LLMVendor;
  model: string;
  enableThinking: boolean;
  budgetTokens: number;
  baseUrl?: string;
  catalogModel?: string;
  /** The request's shape, for the rules that depend on it. */
  request: { hasTools: boolean };
}): ReasoningPlan | undefined {
  if (!params.enableThinking) return undefined;
  const plan = planReasoningLevel(params);
  if (plan?.kind === "openai-effort" && chatCompletionsRejectsToolTurnEffort({
    vendor: params.vendor, model: params.model, baseUrl: params.baseUrl, catalogModel: params.catalogModel, ...params.request,
  })) {
    return { kind: "none", requestedEffort: plan.requestedEffort, source: plan.source, suppressed: "chat-completions-tool-turn" };
  }
  return plan;
}

function planReasoningLevel(params: {
  vendor: LLMVendor; model: string; budgetTokens: number; baseUrl?: string; catalogModel?: string;
}): ReasoningPlan | undefined {
  const entry = catalogModelFor(params.vendor, params.model, params.catalogModel, params.baseUrl)?.model;
  const accepted = entry?.reasoning?.effort;
  if (entry?.reasoning?.supported === false) {
    return { kind: "none", source: "model-catalog" };
  }
  if (OPENAI_FAMILY.has(params.vendor)) {
    const requestedEffort = mapReasoningEffort(params.budgetTokens);
    const catalogEffort = entry?.reasoning?.supported === true && accepted ? nearestAcceptedEffort(requestedEffort, accepted) : undefined;
    if (catalogEffort !== undefined) return { kind: "openai-effort", requestedEffort, effort: catalogEffort, source: "model-catalog" };
    // Nobody states the levels this model accepts (absent means unknown, not
    // none): the request carries no effort rather than a guessed one.
    return { kind: "none", requestedEffort, source: "host-fallback" };
  }
  if (params.vendor === "claude") {
    const source = entry?.reasoning !== undefined ? "model-catalog" : "request-shape";
    if (!claudeRequestShape(params.model).adaptiveThinking) {
      return { kind: "anthropic-numeric", budgetTokens: params.budgetTokens, source };
    }
    const requestedEffort = mapBudgetToEffort(params.budgetTokens);
    const effort = accepted ? nearestAcceptedEffort(requestedEffort, accepted) ?? requestedEffort : requestedEffort;
    return { kind: "anthropic-adaptive", requestedEffort, effort, source };
  }
  return undefined;
}
