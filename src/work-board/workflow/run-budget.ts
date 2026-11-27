import type { StageEnvelope, WorkItemStageRun } from "../../shared/workflow-template-types.js";

export interface StageUsage {
  rounds: number;
  startedAt: number;
  costUsd?: number;
  denials: number;
}

export type BudgetVerdict = { ok: true } | { ok: false; code: "rounds" | "minutes" | "cost" | "denials" };

export const MAX_LANE_DENIALS_PER_STAGE = 3;

export function stageReachedDenialLimit(stage: WorkItemStageRun): boolean {
  return stage.status === "failed" && stage.failure === "budget" && stage.deniedCalls?.length === MAX_LANE_DENIALS_PER_STAGE;
}

export function checkStageBudget(usage: StageUsage, budget: StageEnvelope["budget"], now: number): BudgetVerdict {
  if (usage.denials >= MAX_LANE_DENIALS_PER_STAGE) return { ok: false, code: "denials" };
  if (usage.rounds > budget.rounds) return { ok: false, code: "rounds" };
  if (now - usage.startedAt >= budget.minutes * 60_000) return { ok: false, code: "minutes" };
  if (usage.costUsd !== undefined && usage.costUsd > budget.costUsd) return { ok: false, code: "cost" };
  return { ok: true };
}
