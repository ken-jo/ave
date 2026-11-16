import { isRecord } from "../shared/is-record.js";
import { canonicalWorkflowJson } from "../shared/workflow-template-output.js";
import { parseRequestedOutputDecl, isGraphHash, isStageId, isTemplateId, isTemplateVersion, isWorkspaceGlob, requireTemplate, WorkflowTemplateError } from "./template-graph.js";
const STAGE_STATUSES = ["waiting", "running", "awaiting_gate", "passed", "failed", "cancelled", "rejected"];
function text(value: unknown, max = 2048): value is string { return typeof value === "string" && value.length > 0 && value.length <= max && !value.includes("\0"); }
function timestamp(value: unknown): boolean { return text(value, 64) && Number.isFinite(Date.parse(value)); }
function count(value: unknown): boolean { return Number.isSafeInteger(value) && (value as number) >= 0; }
function optional(raw: Record<string, unknown>, key: string, valid: (value: unknown) => boolean): boolean { return raw[key] === undefined || valid(raw[key]); }
function list(value: unknown, max: number, valid: (value: unknown) => boolean): value is unknown[] { return Array.isArray(value) && value.length <= max && value.every(valid); }
function ids(value: unknown): boolean { return list(value, 12, isStageId) && value.length > 0 && new Set(value).size === value.length; }
function relativeFile(value: unknown): boolean { return isWorkspaceGlob(value) && !/[*?]/.test(value); }
function files(value: unknown): boolean {
  return list(value, 5000, file => isRecord(file) && relativeFile(file.path) && count(file.size) && isGraphHash(file.sha256))
    && value.reduce<number>((sum, file) => sum + (file as { size: number }).size, 0) <= 512 * 1024 * 1024
    && new Set(value.map(file => (file as { path: string }).path)).size === value.length;
}
function workspace(value: unknown, run: boolean): boolean {
  if (!isRecord(value) || !["git", "folder"].includes(value.kind as string) || !text(value[run ? "runRoot" : "root"])) return false;
  return optional(value, "baseCommit", v => text(v, 128)) && (run
    ? optional(value, "branch", v => text(v, 256)) && optional(value, "outputDir", text)
    : optional(value, "sealCommit", v => text(v, 128)) && optional(value, "manifest", files));
}
function requestedOutput(value: unknown): boolean {
  if (!isRecord(value) || !isTemplateId(value.id) || !isRecord(value.decl) || typeof value.summary !== "string" || value.summary.length > 400 || typeof value.args !== "string" || Buffer.byteLength(value.args, "utf8") > 32 * 1024) return false;
  try { parseRequestedOutputDecl(value.decl); } catch { return false; }
  try { if (canonicalWorkflowJson(JSON.parse(value.args)) !== value.args) return false; } catch { return false; }
  return optional(value, "files", files);
}
function uniqueEntries(value: unknown, max: number, valid: (value: unknown) => boolean): boolean {
  return list(value, max, valid) && new Set(value.map(v => (v as { id: string }).id)).size === value.length;
}
function conflict(value: unknown): boolean {
  return isRecord(value) && isGraphHash(value.conflictHash) && ["merge-conflict", "same-path", "identity-missing", "interrupted"].includes(value.reason as string)
    && list(value.files, 50, file => isRecord(file) && relativeFile(file.path) && ids(file.stageIds))
    && optional(value, "excerpt", v => typeof v === "string" && v.length <= 8192);
}
function joins(value: unknown): boolean {
  return list(value, 12, join => isRecord(join) && isTemplateId(join.joinId) && ids(join.stageIds) && ["integrating", "integrated", "conflict", "rejected"].includes(join.status as string)
    && optional(join, "conflict", conflict) && (join.status !== "conflict" || join.conflict !== undefined) && optional(join, "decidedAt", timestamp))
    && new Set(value.map(join => (join as { joinId: string }).joinId)).size === value.length;
}
function validStage(value: unknown, summary: boolean): boolean {
  if (!isRecord(value) || !isStageId(value.stageId) || !Number.isInteger(value.attempt) || (value.attempt as number) < 1 || (value.attempt as number) > 3 || !STAGE_STATUSES.includes(value.status as string)) return false;
  for (const key of ["startedAt", "endedAt", "childSessionId", "output"]) if (value[key] !== undefined && typeof value[key] !== "string") return false;
  if (typeof value.output === "string" && value.output.length > 48_000) throw new WorkflowTemplateError("invalid-template-run", "Stage output exceeds 48000 characters");
  if (value.resultHash !== undefined && !isGraphHash(value.resultHash)) return false;
  if (summary && ["output", "gate", "childSessionId", "failure", "taint", "workspace", "blocked", "requestedOutputs", "outputExecutions", "usage"].some(key => value[key] !== undefined)) return false;
  if (!optional(value, "failure", v => ["error", "gate", "interrupted", "denied-tool", "workspace-lost", "workspace-revoked", "budget", "seed"].includes(v as string))
    || !optional(value, "taint", v => v === "file-content" || v === "agent-message") || !optional(value, "workspace", v => workspace(v, false))
    || !optional(value, "blocked", v => isRecord(v) && ["envelope-missing", "isolation-unproven", "lane-unavailable"].includes(v.code as string) && timestamp(v.at))
    || !optional(value, "requestedOutputs", v => uniqueEntries(v, 10, requestedOutput))
    || !optional(value, "outputExecutions", v => uniqueEntries(v, 10, e => isRecord(e) && isTemplateId(e.id) && ["pending", "done", "failed", "denied"].includes(e.status as string) && optional(e, "at", timestamp) && optional(e, "detail", d => typeof d === "string" && d.length <= 8192)))
    || !optional(value, "usage", v => isRecord(v) && count(v.rounds) && timestamp(v.startedAt) && count(v.denials) && optional(v, "costUsd", c => typeof c === "number" && Number.isFinite(c) && c >= 0))) return false;
  if (value.gate === undefined) return true;
  const g = value.gate;
  if (!isRecord(g) || !optional(g, "judgedBy", v => v === "host" || v === "model")) return false;
  if (g.type === "auto") return typeof g.passed === "boolean" && typeof g.evidence === "string" && typeof g.evaluatedAt === "string";
  return g.type === "human" && ["pending", "approved", "changes_requested", "rejected"].includes(g.status as string)
    && Number.isInteger(g.revision) && (g.revision as number) >= 0
    && (g.note === undefined || typeof g.note === "string") && (g.decidedAt === undefined || typeof g.decidedAt === "string");
}
function stages(value: unknown, summary: boolean): boolean {
  return Array.isArray(value) && value.length <= 12 && value.every(v => validStage(v, summary)) && new Set(value.map(v => v.stageId)).size === value.length;
}
function authority(value: unknown, raw: Record<string, unknown>): boolean {
  if (!isRecord(value) || !isRecord(value.pin)) return false;
  const pin = value.pin;
  if (pin.templateId !== raw.templateId || pin.version !== raw.runTemplateVersion || pin.graphHash !== raw.runTemplateGraphHash) return false;
  return (value.kind === "local-create-and-run" && optional(value, "projectRoot", text)) || (value.kind === "schedule-attachment" && isTemplateId(value.attachmentId) && timestamp(value.firedAt));
}
/** Optional additive fields keep legacy boards readable; partial authority pins are never repaired. */
export function assertTemplateRunFields(raw: unknown): void {
  if (!isRecord(raw)) return;
  const check = (condition: unknown): void => requireTemplate(condition, "invalid-template-run");
  if (raw.templateId !== undefined) check(isTemplateId(raw.templateId));
  const pinned = ["runTemplateVersion", "runTemplateGraphHash", "stageRuns", "runStartedBy", "runWorkspace", "stageJoins"].some(key => raw[key] !== undefined);
  if (pinned) check(isTemplateId(raw.templateId) && text(raw.runId, 256) && isTemplateVersion(raw.runTemplateVersion) && isGraphHash(raw.runTemplateGraphHash) && stages(raw.stageRuns, false));
  if (raw.runStartedBy !== undefined) check(authority(raw.runStartedBy, raw));
  if (raw.runWorkspace !== undefined) check(workspace(raw.runWorkspace, true));
  if (raw.stageJoins !== undefined) { check(joins(raw.stageJoins)); const stageIds = new Set((raw.stageRuns as { stageId: string }[]).map(s => s.stageId)); check((raw.stageJoins as { stageIds: string[] }[]).every(j => j.stageIds.every(id => stageIds.has(id)))); }
  if (Array.isArray(raw.runHistory)) for (const h of raw.runHistory) {
    if (!isRecord(h)) continue;
    if (h.templateVersion !== undefined || h.templateGraphHash !== undefined || h.stageRuns !== undefined) {
      check(isTemplateId(raw.templateId) && isTemplateVersion(h.templateVersion) && isGraphHash(h.templateGraphHash) && stages(h.stageRuns, true));
    }
  }
  if (isRecord(raw.planApproval) && raw.planApproval.templateGraphHash !== undefined) check(isGraphHash(raw.planApproval.templateGraphHash) && raw.planApproval.templateGraphHash === raw.runTemplateGraphHash);
}

/** Legacy boards predate template authority; retain ordinary item and run history fields only. */
export function stripLegacyBoardTemplateRunFields<T extends { items: unknown[] }>(board: T): T {
  const strip = (value: unknown, fields: readonly string[]): unknown => {
    if (!isRecord(value)) return value;
    const clean = { ...value };
    for (const field of fields) delete clean[field];
    return clean;
  };
  return { ...board, items: board.items.map(value => {
    if (!isRecord(value)) return value;
    const row = strip(value, ["templateId", "runTemplateVersion", "runTemplateGraphHash", "runStartedBy", "pin", "stageRuns", "stageJoins", "runWorkspace", "templateRunError"]) as Record<string, unknown>;
    if (Array.isArray(row.runHistory)) row.runHistory = row.runHistory.map(entry => strip(entry, ["templateVersion", "templateGraphHash", "stageRuns"]));
    if (isRecord(row.planApproval)) row.planApproval = strip(row.planApproval, ["templateGraphHash"]);
    return row;
  }) };
}
