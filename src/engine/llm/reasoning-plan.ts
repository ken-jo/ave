/**
 * Which reasoning control a request carries, and at what level.
 *
 * The catalog states, per model, whether it reasons and which qualitative
 * effort levels it accepts. Where it knows the model, that list decides: the
 * level Ave's budget maps to is sent if the model accepts it, otherwise the
 * nearest accepted level below it (the lowest accepted level when none is
 * below), and the change is reported. Where the catalog does not know the
 * model, the name rules below decide, as they did before the catalog — they
 * are removed in issue #2501's last slice.
 *
 * Request SHAPE stays out of this: whether a Claude model takes adaptive or
 * numeric thinking, whether numeric thinking interleaves with tools, and
 * whether an OpenAI model is reached over the Responses API are properties of
 * the wire the catalog does not describe (it lists effort levels for models
 * that take numeric thinking), so they remain host rules.
 *
 * The adapter applies {@link planReasoning}; the conversation loop records the
 * same function's answer in the turn summary, so the record is what was sent.
 */
import { catalogModelFor } from "../../shared/context-budget.js";
import type { LLMVendor } from "../../shared/llm-vendor-defaults.js";

/** Name rule: an OpenAI-family model that takes `reasoning_effort` (gpt-5.x, o-series). */
export function isOpenAIReasoningModel(model: string): boolean {
  const m = model.toLowerCase();
  return (
    m.includes("gpt-5") ||
    m.includes("o1") ||
    m.includes("o3") ||
    m.includes("o4")
  );
}

/**
 * Map Ave thinking budget (tokens) to OpenAI reasoning_effort.
 *   budget ≤   500 → "none"    (GPT-5.2+ only; callers ignore for older models)
 *   budget ≤ 3 000 → "low"
 *   budget ≥ 8 000 → "high"
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
 * Whether a model accepts `reasoning_effort: "none"`. Only GPT-5.2+ (and later
 * GPT majors) support it; o-series (o1/o3/o4) and GPT-5.0/5.1 reject it with a
 * 400. `mapReasoningEffort` can emit "none" for tiny budgets, so callers must
 * clamp it to "low" for models without the capability.
 */
export function supportsReasoningEffortNone(model: string): boolean {
  const m = model.toLowerCase();
  const gpt5 = m.match(/gpt-5(?:\.(\d+))?/);
  if (gpt5) return Number(gpt5[1] ?? "0") >= 2;
  const gptMajor = m.match(/gpt-(\d+)/);
  if (gptMajor) return Number(gptMajor[1]) >= 6;
  return false;
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

/**
 * Adaptive thinking starts with version 4.6. A release date after the major
 * version is not a minor version; earlier models retain numeric thinking.
 */
export function supportsAdaptiveThinking(modelId: string): boolean {
  const m = modelId.toLowerCase();
  const match = m.match(/claude-(?:[a-z]+-)?(\d+)(?:[-.](\d{1,2})(?=$|[-.]))?/);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2] ?? 0);
  return major > 4 || (major === 4 && minor >= 6);
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
  /** Which knowledge decided: the catalog entry, or the name rules for a model it does not know. */
  readonly source: "model-catalog" | "name-rule";
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
}): ReasoningPlan | undefined {
  if (!params.enableThinking) return undefined;
  const entry = catalogModelFor(params.vendor, params.model)?.model;
  const accepted = entry?.reasoning?.effort;
  if (OPENAI_FAMILY.has(params.vendor)) {
    const requestedEffort = mapReasoningEffort(params.budgetTokens);
    if (entry?.reasoning?.supported === false) return { kind: "none", source: "model-catalog" };
    // A reasoning model whose levels the catalog does not list has unknown
    // levels, not none (absent means unknown): the name rule decides for it.
    const catalogEffort = entry?.reasoning?.supported === true && accepted ? nearestAcceptedEffort(requestedEffort, accepted) : undefined;
    if (catalogEffort !== undefined) return { kind: "openai-effort", requestedEffort, effort: catalogEffort, source: "model-catalog" };
    if (!isOpenAIReasoningModel(params.model)) return { kind: "none", source: "name-rule" };
    // "none" is GPT-5.2+ only by name; o-series / GPT-5.0-5.1 reject it with a 400.
    const effort = requestedEffort === "none" && !supportsReasoningEffortNone(params.model) ? "low" : requestedEffort;
    return { kind: "openai-effort", requestedEffort, effort, source: "name-rule" };
  }
  if (params.vendor === "claude") {
    const source = entry?.reasoning !== undefined ? "model-catalog" : "name-rule";
    if (!supportsAdaptiveThinking(params.model)) {
      return { kind: "anthropic-numeric", budgetTokens: params.budgetTokens, source };
    }
    const requestedEffort = mapBudgetToEffort(params.budgetTokens);
    const effort = accepted ? nearestAcceptedEffort(requestedEffort, accepted) ?? requestedEffort : requestedEffort;
    return { kind: "anthropic-adaptive", requestedEffort, effort, source };
  }
  return undefined;
}
