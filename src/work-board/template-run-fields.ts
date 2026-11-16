import { isRecord } from "../shared/is-record.js";
import { isGraphHash, isTemplateId, isTemplateVersion, requireTemplate, WorkflowTemplateError } from "./template-graph.js";

const STAGE_STATUSES = ["waiting", "running", "awaiting_gate", "passed", "failed", "cancelled", "rejected"];
function validStage(value: unknown, summary: boolean): boolean {
  if (!isRecord(value) || !isTemplateId(value.stageId) || !Number.isInteger(value.attempt) || (value.attempt as number) < 1 || (value.attempt as number) > 3 || !STAGE_STATUSES.includes(value.status as string)) return false;
  for (const key of ["startedAt", "endedAt", "childSessionId", "output"]) if (value[key] !== undefined && typeof value[key] !== "string") return false;
  if (typeof value.output === "string" && value.output.length > 48_000) throw new WorkflowTemplateError("invalid-template-run", "Stage output exceeds 48000 characters");
  if (value.outputHash !== undefined && !isGraphHash(value.outputHash)) return false;
  if (summary && (value.output !== undefined || value.gate !== undefined || value.childSessionId !== undefined)) return false;
  if (value.gate === undefined) return true;
  const g = value.gate;
  if (!isRecord(g)) return false;
  if (g.type === "auto") return typeof g.passed === "boolean" && typeof g.evidence === "string" && typeof g.evaluatedAt === "string";
  return g.type === "human" && ["pending", "approved", "changes_requested", "rejected"].includes(g.status as string)
    && Number.isInteger(g.revision) && (g.revision as number) >= 0
    && (g.note === undefined || typeof g.note === "string") && (g.decidedAt === undefined || typeof g.decidedAt === "string");
}
function stages(value: unknown, summary: boolean): boolean {
  return Array.isArray(value) && value.length <= 12 && value.every(v => validStage(v, summary)) && new Set(value.map(v => v.stageId)).size === value.length;
}
/** Optional additive fields keep legacy boards readable; partial authority pins are never repaired. */
export function assertTemplateRunFields(raw: unknown): void {
  if (!isRecord(raw)) return;
  const check = (condition: unknown): void => requireTemplate(condition, "invalid-template-run");
  if (raw.templateId !== undefined) check(isTemplateId(raw.templateId));
  const pinned = raw.runTemplateVersion !== undefined || raw.runTemplateGraphHash !== undefined || raw.stageRuns !== undefined;
  if (pinned) check(isTemplateId(raw.templateId) && typeof raw.runId === "string" && isTemplateVersion(raw.runTemplateVersion) && isGraphHash(raw.runTemplateGraphHash) && stages(raw.stageRuns, false));
  if (Array.isArray(raw.runHistory)) for (const h of raw.runHistory) {
    if (!isRecord(h)) continue;
    if (h.templateVersion !== undefined || h.templateGraphHash !== undefined || h.stageRuns !== undefined) {
      check(isTemplateId(raw.templateId) && isTemplateVersion(h.templateVersion) && isGraphHash(h.templateGraphHash) && stages(h.stageRuns, true));
    }
  }
  if (isRecord(raw.planApproval) && raw.planApproval.templateGraphHash !== undefined) check(isGraphHash(raw.planApproval.templateGraphHash) && raw.planApproval.templateGraphHash === raw.runTemplateGraphHash);
}
