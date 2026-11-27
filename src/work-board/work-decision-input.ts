import { hasTemplateKeys, isGraphHash, isStageId, isTemplateId, isTemplateVersion } from "./template-graph.js";
import { hasOnlyKeys, isRecord } from "../shared/is-record.js";
import type { StageGateDecideInput, StageJoinDecideInput, WorkPlanDecideInput, WorkPlanDecision } from "../shared/work-board-types.js";
import type { TemplateVersionPin, WorkflowTemplateConfirmInput } from "../shared/workflow-template-types.js";

const PLAN_DECISIONS: readonly WorkPlanDecision[] = ["approve", "reject", "request_changes"];
export const PLAN_HASH_PATTERN = /^[0-9a-f]{64}$/;
export const RUN_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export function exactRecord(raw: unknown, keys: readonly string[]): Record<string, unknown> | null {
  return isRecord(raw) && hasOnlyKeys(raw, keys) ? raw : null;
}

export function parseTemplateConfirmInput(raw: unknown): WorkflowTemplateConfirmInput | null {
  if (!hasTemplateKeys(raw, ["expectedGraphHash", "expectedDraftRevision"])
    || !isGraphHash(raw.expectedGraphHash) || !isTemplateId(raw.expectedDraftRevision)) return null;
  return { expectedGraphHash: raw.expectedGraphHash, expectedDraftRevision: raw.expectedDraftRevision };
}

/** Accept exactly `{ runId, planHash, decision, note? }`; anything else is invalid input, never a partial decision. */
export function parseDecidePlanInput(raw: unknown): WorkPlanDecideInput | null {
  const record = exactRecord(raw, ["runId", "planHash", "decision", "note"]);
  if (!record) return null;
  const { runId, planHash, decision, note } = record;
  if (typeof runId !== "string" || !RUN_ID_PATTERN.test(runId)) return null;
  if (typeof planHash !== "string" || !PLAN_HASH_PATTERN.test(planHash)) return null;
  if (typeof decision !== "string" || !PLAN_DECISIONS.includes(decision as WorkPlanDecision)) return null;
  if (note !== undefined && typeof note !== "string") return null;
  return { runId, planHash, decision: decision as WorkPlanDecision, ...(note !== undefined ? { note } : {}) };
}

/** Accept exactly `{ runId, stageId, attempt, resultHash, outputHash?, decision, note? }`; never a partial decision. */
export function parseDecideStageInput(raw: unknown): StageGateDecideInput | null {
  const record = exactRecord(raw, ["runId", "stageId", "attempt", "resultHash", "outputHash", "decision", "note"]);
  if (!record) return null;
  const { runId, stageId, attempt, resultHash, outputHash, decision, note } = record;
  if (typeof runId !== "string" || !RUN_ID_PATTERN.test(runId) || !isStageId(stageId)) return null;
  if (typeof attempt !== "number" || !Number.isInteger(attempt) || attempt < 1 || attempt > 3) return null;
  if (typeof resultHash !== "string" || !PLAN_HASH_PATTERN.test(resultHash)) return null;
  if (outputHash !== undefined && (typeof outputHash !== "string" || !PLAN_HASH_PATTERN.test(outputHash))) return null;
  if (typeof decision !== "string" || !PLAN_DECISIONS.includes(decision as WorkPlanDecision)) return null;
  if (note !== undefined && typeof note !== "string") return null;
  return { runId, stageId, attempt, resultHash, decision: decision as WorkPlanDecision, ...(outputHash !== undefined ? { outputHash } : {}), ...(note !== undefined ? { note } : {}) };
}

/** The conflict and generation the user saw. */
export function parseJoinBinding(record: Record<string, unknown> | null): Omit<StageJoinDecideInput, "decision"> | null {
  if (!record) return null;
  const { runId, joinId, conflictHash, generation } = record;
  if (typeof runId !== "string" || !RUN_ID_PATTERN.test(runId) || !isTemplateId(joinId)
    || typeof conflictHash !== "string" || !PLAN_HASH_PATTERN.test(conflictHash)
    || typeof generation !== "number" || !Number.isSafeInteger(generation) || generation < 0) return null;
  return { runId, joinId, conflictHash, generation };
}

/** The exact pin and project the user chose for Create and run. */
export function parseTemplateRunTuple(raw: unknown): { pin: TemplateVersionPin; projectRoot?: string } | null {
  const record = exactRecord(raw, ["templateId", "version", "graphHash", "projectRoot"]);
  if (!record || !isTemplateId(record.templateId) || !isTemplateVersion(record.version) || !isGraphHash(record.graphHash)) return null;
  if (record.projectRoot !== undefined && (typeof record.projectRoot !== "string" || record.projectRoot.length === 0)) return null;
  return { pin: { templateId: record.templateId, version: record.version, graphHash: record.graphHash }, ...(record.projectRoot !== undefined ? { projectRoot: record.projectRoot } : {}) };
}
