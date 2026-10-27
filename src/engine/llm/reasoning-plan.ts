// Use declared reasoning controls and accepted levels; unknown models receive no guessed effort.
// The adapter and turn record must use this same plan.
import {
  catalogModelFor,
  resolveReasoningSupport,
  type ReportedReasoningControl,
  type ResolvedReasoningSupport,
} from "../../shared/context-budget.js";
import { isOpenAICompatibleVendor, isSelfHostedVllmVendor, type LLMVendor } from "../../shared/llm-vendor-defaults.js";
import { REASONING_EFFORT_ORDER, reasoningEffortForBudget, assertReasoningEffort, type ReasoningEffort } from "../../shared/reasoning-effort.js";
import { claudeRequestShape } from "../../shared/model-host-policy.js";
import { allowsImplicitModelLimits } from "../../shared/model-catalog/resolve.js";

// Native origins may select response reasoning controls; custom endpoints require an explicit report.
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

// Choose the nearest accepted level below the request, or the lowest accepted level.
function nearestAcceptedEffort(requested: ReasoningEffort, accepted: readonly string[]): ReasoningEffort | undefined {
  const levels = REASONING_EFFORT_ORDER.filter((level) => accepted.includes(level));
  if (levels.length === 0) return undefined;
  const at = REASONING_EFFORT_ORDER.indexOf(requested);
  const below = levels.filter((level) => REASONING_EFFORT_ORDER.indexOf(level) <= at);
  return below.at(-1) ?? levels[0];
}

type ReasoningPlanSource = "model-catalog" | "endpoint-report" | "request-shape" | "host-fallback";

export interface ReasoningPlan {
  // Control kinds distinguish API effort, adaptive effort, numeric budgets, and endpoint-reported parameters.
  readonly kind: "openai-effort" | "anthropic-adaptive" | "anthropic-numeric" | "endpoint-reasoning" | "none";
  readonly control?: ReportedReasoningControl;
  readonly requestedEffort?: ReasoningEffort;
  // Sent effort may differ from the request when the model rejects the requested level.
  readonly effort?: ReasoningEffort;
  readonly budgetTokens?: number;
  // Catalog or endpoint knowledge selects controls; fallback never invents one.
  readonly source: ReasoningPlanSource;
  // Retain historical suppressed-control records; new plans honor explicitly reported controls.
  readonly suppressed?: "chat-completions-tool-turn";
}

const OPENAI_FAMILY: ReadonlySet<LLMVendor> = new Set(["openai", "azure-foundry"]);

/** No plan when thinking is off or the route owns its numeric control outside this planner. */
export function planReasoning(params: {
  vendor: LLMVendor;
  model: string;
  enableThinking: boolean;
  budgetTokens: number;
  // Preserve the selected rung before numeric request budgets are bounded.
  requestedEffort?: ReasoningEffort;
  baseUrl?: string;
  catalogModel?: string;
  // Route reasoning support includes endpoint reports; without it, consult only the catalog.
  reasoning?: ResolvedReasoningSupport;
  request: { hasTools: boolean };
}): ReasoningPlan | undefined {
  if (params.requestedEffort !== undefined) assertReasoningEffort(params.requestedEffort);
  if (!params.enableThinking) return undefined;
  const reasoning = routeReasoningSupport(params);
  return planReasoningLevel({ ...params, reasoning });
}

// Prefer the named entry, then endpoint report, then catalog-established model identity.
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
  requestedEffort?: ReasoningEffort;
  reasoning?: ResolvedReasoningSupport;
}): ReasoningPlan | undefined {
  const entry = catalogModelFor(params.vendor, params.model, params.catalogModel, params.baseUrl)?.model;
  const accepted = entry?.reasoning?.effort;
  const support = params.reasoning;
  if (support?.source === "model-catalog" && !support.supported) {
    return { kind: "none", source: "model-catalog" };
  }
  if (OPENAI_FAMILY.has(params.vendor)) {
    const requestedEffort = params.requestedEffort ?? reasoningEffortForBudget(params.budgetTokens);
    if (support?.source === "endpoint-report") {
      // The report must name the parameter used by the selected request protocol.
      const wireParameter = usesOpenAIResponsesWire(params.vendor, params.model, support, params.baseUrl) ? "reasoning" : "reasoning_effort";
      return support.control === wireParameter
        ? { kind: "openai-effort", requestedEffort, effort: accepted?.length ? nearestAcceptedEffort(requestedEffort, accepted) : requestedEffort, source: "endpoint-report" }
        : { kind: "none", requestedEffort, source: "endpoint-report" };
    }
    const efforts = support?.source === "model-catalog" && support.supported ? support.efforts : undefined;
    const catalogEffort = efforts ? nearestAcceptedEffort(requestedEffort, efforts) : undefined;
    if (catalogEffort !== undefined) return { kind: "openai-effort", requestedEffort, effort: catalogEffort, source: "model-catalog" };
    // Unknown accepted levels mean omit effort, not guess a level.
    return { kind: "none", requestedEffort, source: "host-fallback" };
  }
  if (isOpenAICompatibleVendor(params.vendor) && !isSelfHostedVllmVendor(params.vendor)) {
    // Self-hosted routes own switch and budget; hosted compatible routes use reported parameters only.
    if (support?.source !== "endpoint-report") return undefined;
    if (support.control === undefined) return { kind: "none", source: "endpoint-report" };
    const requestedEffort = params.requestedEffort ?? reasoningEffortForBudget(params.budgetTokens);
    return support.control === "include_reasoning"
      ? { kind: "endpoint-reasoning", control: support.control, source: "endpoint-report" }
      : { kind: "endpoint-reasoning", control: support.control, requestedEffort, effort: accepted?.length ? nearestAcceptedEffort(requestedEffort, accepted) : requestedEffort, source: "endpoint-report" };
  }
  if (params.vendor === "claude") {
    const source = "model-catalog";
    const shape = claudeRequestShape(entry);
    if (shape.numericThinking) {
      return { kind: "anthropic-numeric", budgetTokens: params.budgetTokens, source };
    }
    if (!shape.adaptiveThinking) return { kind: "none", source: "host-fallback" };
    const requestedEffort = params.requestedEffort ?? reasoningEffortForBudget(params.budgetTokens);
    const effort = accepted ? nearestAcceptedEffort(requestedEffort, accepted) : undefined;
    return { kind: "anthropic-adaptive", requestedEffort, effort, source };
  }
  return undefined;
}
