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
 * Request controls come from the catalog or the endpoint report. Unknown
 * entries send no inferred thinking control.
 *
 * The adapter applies {@link planReasoning}; the conversation loop records the
 * same function's answer in the turn summary, so the record is what was sent.
 */
import {
  catalogModelFor,
  resolveReasoningSupport,
  type ReportedReasoningControl,
  type ResolvedReasoningSupport,
} from "../../shared/context-budget.js";
import { isOpenAICompatibleVendor, isSelfHostedVllmVendor, type LLMVendor } from "../../shared/llm-vendor-defaults.js";
import { claudeRequestShape } from "../../shared/model-host-policy.js";
import { allowsImplicitModelLimits } from "../../shared/model-catalog/resolve.js";

/**
 * Reported controls select their protocol. At a native API origin the host
 * prefers the response protocol for reasoning-capable entries, where tools
 * and effort can be sent together. Custom endpoints retain the chat protocol
 * unless their report explicitly selects the response control.
 */
export function usesOpenAIResponsesWire(
  vendor: string,
  model: string,
  reasoning: ResolvedReasoningSupport | undefined,
  baseUrl?: string,
): boolean {
  if (vendor === "azure-foundry") return true;
  if (vendor !== "openai") return false;
  if (reasoning?.source === "endpoint-report" && reasoning.control !== undefined) {
    return reasoning.control === "reasoning";
  }
  // A public model identity does not establish a custom endpoint's protocol.
  if (!allowsImplicitModelLimits(vendor, baseUrl)) return false;
  const nativeSupport = reasoning?.source === "model-catalog"
    ? reasoning
    : resolveReasoningSupport({ vendor, model, baseUrl });
  return nativeSupport?.supported === true;
}

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

type ReasoningPlanSource = "model-catalog" | "endpoint-report" | "request-shape" | "host-fallback";

/**
 * The level sent where only the endpoint's report says the model reasons: the
 * report names the parameter, not the levels. `low`, `medium` and `high` are
 * the levels every effort convention defines (OpenAI `reasoning_effort`,
 * OpenRouter `reasoning.effort`); Ave's lowest budget maps to `none`, which a
 * model whose reasoning is mandatory rejects and which contradicts thinking
 * being on, so it is sent as `low`.
 */
function reportedEffort(requested: ReturnType<typeof mapReasoningEffort>): "low" | "medium" | "high" {
  return requested === "none" ? "low" : requested;
}

/** What a request's reasoning control is, as the adapter sends it. */
export interface ReasoningPlan {
  /**
   * `openai-effort`: `reasoning_effort` on an OpenAI-family route;
   * `anthropic-adaptive`: adaptive thinking with an effort;
   * `anthropic-numeric`: a numeric thinking budget;
   * `endpoint-reasoning`: the reasoning parameter an OpenAI-compatible
   * endpoint's `/models` report names (`control`);
   * `none`: the route sends no reasoning control from this plan.
   */
  readonly kind: "openai-effort" | "anthropic-adaptive" | "anthropic-numeric" | "endpoint-reasoning" | "none";
  /** The reported parameter an `endpoint-reasoning` plan sends. */
  readonly control?: ReportedReasoningControl;
  /** The level Ave's budget maps to, for an effort kind. */
  readonly requestedEffort?: EffortLevel;
  /** The level sent; differs from `requestedEffort` when the model does not accept it. */
  readonly effort?: EffortLevel;
  /** The numeric budget, for `anthropic-numeric`. */
  readonly budgetTokens?: number;
  /**
   * Which knowledge decided: the catalog entry; the endpoint's `/models`
   * report (a reasoning parameter or price); or the host fallback, which
   * sends no inferred control when neither source describes one.
   */
  readonly source: ReasoningPlanSource;
  /**
   * Historical records may name a control the host suppressed. New plans
   * preserve explicitly reported controls instead of guessing restrictions.
   */
  readonly suppressed?: "chat-completions-tool-turn";
}

const OPENAI_FAMILY: ReadonlySet<LLMVendor> = new Set(["openai", "azure-foundry"]);

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
  /**
   * The route's resolved reasoning support (`resolveReasoningSupport`), which
   * carries the endpoint's report. Absent: the catalog alone is asked.
   */
  reasoning?: ResolvedReasoningSupport;
  /** The request's shape, for the rules that depend on it. */
  request: { hasTools: boolean };
}): ReasoningPlan | undefined {
  if (!params.enableThinking) return undefined;
  const reasoning = routeReasoningSupport(params);
  return planReasoningLevel({ ...params, reasoning });
}

/**
 * One answer with the settings chooser: the user's named entry, then the
 * endpoint's report, then the catalog where the route establishes the model.
 */
function routeReasoningSupport(params: {
  vendor: LLMVendor; model: string; baseUrl?: string; catalogModel?: string;
  reasoning?: ResolvedReasoningSupport;
}): ResolvedReasoningSupport | undefined {
  return params.reasoning ?? resolveReasoningSupport({
    vendor: params.vendor,
    model: params.model,
    ...(params.catalogModel !== undefined ? { catalogModel: params.catalogModel } : {}),
    ...(params.baseUrl !== undefined ? { baseUrl: params.baseUrl } : {}),
  });
}

function planReasoningLevel(params: {
  vendor: LLMVendor; model: string; budgetTokens: number; baseUrl?: string; catalogModel?: string;
  reasoning?: ResolvedReasoningSupport;
}): ReasoningPlan | undefined {
  const entry = catalogModelFor(params.vendor, params.model, params.catalogModel, params.baseUrl)?.model;
  const accepted = entry?.reasoning?.effort;
  const support = params.reasoning;
  if (support?.source === "model-catalog" && !support.supported) {
    return { kind: "none", source: "model-catalog" };
  }
  if (OPENAI_FAMILY.has(params.vendor)) {
    const requestedEffort = mapReasoningEffort(params.budgetTokens);
    if (support?.source === "endpoint-report") {
      // The SDK sends `reasoningEffort` as `reasoning.effort` on the Responses
      // wire and as `reasoning_effort` on Chat Completions; the report has to
      // name that parameter.
      const wireParameter = usesOpenAIResponsesWire(params.vendor, params.model, support, params.baseUrl) ? "reasoning" : "reasoning_effort";
      return support.control === wireParameter
        ? { kind: "openai-effort", requestedEffort, effort: reportedEffort(requestedEffort), source: "endpoint-report" }
        : { kind: "none", requestedEffort, source: "endpoint-report" };
    }
    const efforts = support?.source === "model-catalog" && support.supported ? support.efforts : undefined;
    const catalogEffort = efforts ? nearestAcceptedEffort(requestedEffort, efforts) : undefined;
    if (catalogEffort !== undefined) return { kind: "openai-effort", requestedEffort, effort: catalogEffort, source: "model-catalog" };
    // Nobody states the levels this model accepts (absent means unknown, not
    // none): the request carries no effort rather than a guessed one.
    return { kind: "none", requestedEffort, source: "host-fallback" };
  }
  if (isOpenAICompatibleVendor(params.vendor) && !isSelfHostedVllmVendor(params.vendor)) {
    // The self-hosted class carries its own switch and budget (adapter); a
    // commercial OpenAI-compatible endpoint gets only the parameter its own
    // report names, never one guessed from the catalog or the name.
    if (support?.source !== "endpoint-report") return undefined;
    if (support.control === undefined) return { kind: "none", source: "endpoint-report" };
    const requestedEffort = mapReasoningEffort(params.budgetTokens);
    return support.control === "include_reasoning"
      ? { kind: "endpoint-reasoning", control: support.control, source: "endpoint-report" }
      : { kind: "endpoint-reasoning", control: support.control, requestedEffort, effort: reportedEffort(requestedEffort), source: "endpoint-report" };
  }
  if (params.vendor === "claude") {
    const source = "model-catalog";
    const shape = claudeRequestShape(entry);
    if (shape.numericThinking) {
      return { kind: "anthropic-numeric", budgetTokens: params.budgetTokens, source };
    }
    if (!shape.adaptiveThinking) return { kind: "none", source: "host-fallback" };
    const requestedEffort = mapBudgetToEffort(params.budgetTokens);
    const effort = accepted ? nearestAcceptedEffort(requestedEffort, accepted) ?? requestedEffort : requestedEffort;
    return { kind: "anthropic-adaptive", requestedEffort, effort, source };
  }
  return undefined;
}
