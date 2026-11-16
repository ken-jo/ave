import type { SubAgentSpawnResult } from "../../engine/subagent-runner.js";
import type { TemplateStage } from "../../shared/workflow-template-types.js";

type PassCondition = Extract<TemplateStage["gate"], { type: "auto" }>["pass"];
interface GateFacts { result: SubAgentSpawnResult; stage: TemplateStage }
interface GateVerdict { passed: boolean; evidence: string; judgedBy: "host" | "model" }
interface PassConditionEntry {
  evaluate(facts: GateFacts, pass: PassCondition): GateVerdict | Promise<GateVerdict>;
  /** Host text added to the stage's instructions when its gate uses this kind. */
  promptSuffix?: string;
}
export interface PassConditionRegistry {
  register(kind: PassCondition["kind"], entry: PassConditionEntry): void;
  /** A kind with no entry, or an entry that throws, fails: a gate that cannot be evaluated never passes. */
  evaluate(pass: PassCondition, facts: GateFacts): Promise<GateVerdict>;
  promptSuffix(kind: PassCondition["kind"]): string | undefined;
}

export function createPassConditionRegistry(): PassConditionRegistry {
  const entries = new Map<PassCondition["kind"], PassConditionEntry>([
    ["stage_ok", {
      evaluate: ({ result }) => {
        const passed = result.ok && !result.incomplete;
        return { passed, evidence: passed ? "the stage ended cleanly" : `the stage did not finish (${result.stopReason ?? "no result"})`, judgedBy: "host" };
      },
    }],
    // The host runs no command. The child's recorded steps carry no exit status, so exit zero cannot be proven and the gate fails.
    ["check_exit_zero", { evaluate: () => ({ passed: false, evidence: "the stage's recorded steps carry no exit status for the command", judgedBy: "host" }) }],
  ]);
  return {
    register: (kind, entry) => { entries.set(kind, entry); },
    evaluate: async (pass, facts) => {
      const entry = entries.get(pass.kind);
      if (!entry) return { passed: false, evidence: `no evaluator for ${pass.kind}`, judgedBy: "host" };
      try {
        return await entry.evaluate(facts, pass);
      } catch {
        return { passed: false, evidence: `the ${pass.kind} evaluator failed`, judgedBy: "host" };
      }
    },
    promptSuffix: kind => entries.get(kind)?.promptSuffix,
  };
}
