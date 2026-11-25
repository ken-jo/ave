import type { SubAgentSpawnResult } from "../../engine/subagent-runner.js";
import type { TemplateStage } from "../../shared/workflow-template-types.js";
import { evaluateModelVerdict, type GenerateStageVerdictText } from "./stage-verdict.js";

type PassCondition = Extract<TemplateStage["gate"], { type: "auto" }>["pass"];
interface GateFacts {
  result: SubAgentSpawnResult;
  stage: TemplateStage;
  /** An evaluator checks this receipt immediately before applying its effect. False means it was already consumed. */
  claimEffect?: () => boolean;
  effectConsumed?: () => boolean;
}
interface GateVerdict { passed: boolean; evidence: string; judgedBy: "host" | "model" }
interface PassConditionEntry {
  /** Evaluation must be pure or idempotent; claim immediately before any application boundary. */
  evaluate(facts: GateFacts, pass: PassCondition): GateVerdict | Promise<GateVerdict>;
  /** Host text added to the stage's instructions when its gate uses this kind. */
  promptSuffix?: string;
}
export interface PassConditionRegistry {
  register(kind: PassCondition["kind"], entry: PassConditionEntry): void;
  /** Missing kinds fail closed; evaluator exceptions propagate without manufacturing a verdict. */
  evaluate(pass: PassCondition, facts: GateFacts): Promise<GateVerdict>;
  promptSuffix(kind: PassCondition["kind"]): string | undefined;
}

export function createPassConditionRegistry(generateVerdict?: GenerateStageVerdictText): PassConditionRegistry {
  const entries = new Map<PassCondition["kind"], PassConditionEntry>([
    ["stage_ok", {
      evaluate: ({ result }) => {
        const passed = result.ok && !result.incomplete;
        return { passed, evidence: passed ? "the stage ended cleanly" : `the stage did not finish (${result.stopReason ?? "no result"})`, judgedBy: "host" };
      },
    }],
  ]);
  if (generateVerdict) entries.set("model_verdict", {
    evaluate: ({ result, stage }) => result.ok && !result.incomplete
      ? evaluateModelVerdict(generateVerdict, stage.goal, result.summary)
      : { passed: false, evidence: "verdict-stage-incomplete", judgedBy: "model" },
  });
  return {
    register: (kind, entry) => { entries.set(kind, entry); },
    evaluate: async (pass, facts) => {
      const entry = entries.get(pass.kind);
      if (!entry) return { passed: false, evidence: `no evaluator for ${pass.kind}`, judgedBy: "host" };
      if (facts.effectConsumed?.() === true) return { passed: false, evidence: "the gate effect was already consumed", judgedBy: "host" };
      const verdict = await entry.evaluate(facts, pass);
      facts.claimEffect?.();
      return verdict;
    },
    promptSuffix: kind => entries.get(kind)?.promptSuffix,
  };
}
