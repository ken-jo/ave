// Successful low and medium review allows; high review asks the owner. Failures always require a human decision.
import { LlmRiskClassifier, RuleBasedRiskClassifier, type RiskClassifier, type LlmRiskClassificationTrace, type RiskVerdict, type ToolInvocationContext } from "../reviewer/risk-classifier.js";
import { errorMessage } from "../../shared/error-message.js";
import {
  JudgeFailure,
  JudgeContractError,
  type JudgeDecision,
  type JudgeFailureKind,
  type JudgeRequest,
  type JudgeVerdict,
  type PermissionJudge,
} from "./judge-contract.js";

export interface TracingRiskClassifier {
  classifyWithTrace(
    input: ToolInvocationContext,
    opts?: { abortSignal?: AbortSignal },
  ): Promise<LlmRiskClassificationTrace>;
}

export function assertRiskClassificationTrace(trace: LlmRiskClassificationTrace): void {
  const validVerdict = (verdict: RiskVerdict): boolean => Boolean(verdict) &&
    ["low", "medium", "high"].includes(verdict.level) && typeof verdict.reason === "string" &&
    (verdict.requiresExplicitApproval === undefined || typeof verdict.requiresExplicitApproval === "boolean");
  if (!trace || !Object.hasOwn(REVIEWER_FAILURE_KIND, trace.outcome) ||
      !validVerdict(trace.ruleVerdict) || !validVerdict(trace.finalVerdict) ||
      (trace.llmVerdict !== null && !validVerdict(trace.llmVerdict))) {
    throw new JudgeContractError("Invalid internal reviewer classification trace");
  }
}

// Adapt rule/disabled/strict reviewer modes at the provider boundary. The manager
// consumes traces without knowing which classifier produced them.
export function traceRiskClassifier(classifier: RiskClassifier): TracingRiskClassifier {
  return {
    async classifyWithTrace(input, options) {
      try {
        if (classifier instanceof LlmRiskClassifier) {
          return await classifier.classifyWithTrace(input, options);
        }
        const verdict = await classifier.classify(input);
        return { ruleVerdict: verdict, llmVerdict: null, finalVerdict: verdict, outcome: "fresh" };
      } catch (error) {
        if (error instanceof JudgeContractError) throw error;
        const finalVerdict: RiskVerdict = { level: "high", reason: `reviewer error — ${errorMessage(error)}` };
        return {
          ruleVerdict: new RuleBasedRiskClassifier().classify(input),
          llmVerdict: classifier instanceof LlmRiskClassifier ? finalVerdict : null,
          finalVerdict, outcome: "error",
        };
      }
    },
  };
}

export function mapRiskVerdictToJudgeDecision(verdict: RiskVerdict): JudgeDecision {
  if (!["low", "medium", "high"].includes(verdict.level)) {
    throw new JudgeContractError("Invalid builtin reviewer decision inputs");
  }
  return verdict.level === "high" ? "ask" : "allow";
}

// null = the outcome may auto-decide; otherwise the failure it surfaces as.
const REVIEWER_FAILURE_KIND: Record<LlmRiskClassificationTrace["outcome"], JudgeFailureKind | null> = {
  fresh: null,
  "host-determined": null,
  timeout: "timeout",
  error: "error",
  malformed: "unparseable",
};

export class BuiltinLlmJudge implements PermissionJudge {
  readonly id = "builtin-llm";
  readonly version = "1";

  constructor(
    private readonly classifier: TracingRiskClassifier | null,
    // Resolved `<provider>/<model>` the classifier runs on.
    readonly model?: string,
    readonly cacheScope?: Record<string, unknown>,
  ) {}

  getClassifier(): TracingRiskClassifier | null {
    return this.classifier;
  }

  async judge(request: JudgeRequest, signal: AbortSignal): Promise<JudgeVerdict> {
    if (this.classifier === null) throw new JudgeFailure("unavailable", "Permission reviewer is not wired");
    const trace = await this.classifier.classifyWithTrace(request.invocation, { abortSignal: signal });
    assertRiskClassificationTrace(trace);
    const failure = REVIEWER_FAILURE_KIND[trace.outcome];
    if (failure === undefined) throw new JudgeContractError(`Unknown reviewer outcome: ${String(trace.outcome)}`);
    if (failure) {
      throw new JudgeFailure(failure, `reviewer ${trace.outcome}: ${trace.finalVerdict.reason}`);
    }
    const verdict = trace.finalVerdict;
    return {
      decision: mapRiskVerdictToJudgeDecision(verdict),
      rationale: `reviewer ${verdict.level}: ${verdict.reason}`,
    };
  }
}
