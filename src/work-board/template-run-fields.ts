import { isRecord } from "../shared/is-record.js";
import { canonicalWorkflowJson, STAGE_OUTPUT_MAX_CHARS } from "../shared/workflow-template-output.js";
import type { WorkflowRunRecord } from "../shared/workflow-template-types.js";
import { hasTemplateKeys, parseRequestedOutputDecl, isGraphHash, isStageId, isTemplateId, isTemplateVersion, isWorkspaceGlob, requireTemplate, WorkflowTemplateError } from "./template-graph.js";
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
function validStage(value: unknown): boolean {
  if (!isRecord(value) || !isStageId(value.stageId) || !Number.isInteger(value.attempt) || (value.attempt as number) < 1 || (value.attempt as number) > 3 || !STAGE_STATUSES.includes(value.status as string)) return false;
  for (const key of ["startedAt", "endedAt", "childSessionId", "output"]) if (value[key] !== undefined && typeof value[key] !== "string") return false;
  if (typeof value.output === "string" && value.output.length > STAGE_OUTPUT_MAX_CHARS) throw new WorkflowTemplateError("invalid-template-run", `Stage output exceeds ${STAGE_OUTPUT_MAX_CHARS} characters`);
  if (!optional(value, "resultHash", isGraphHash) || !optional(value, "outputHash", isGraphHash)) return false;
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
function stages(value: unknown): boolean {
  return Array.isArray(value) && value.length <= 12 && value.every(validStage) && new Set(value.map(v => v.stageId)).size === value.length;
}
function authority(value: unknown, pin: Record<string, unknown>): boolean {
  if (!isRecord(value) || !isRecord(value.pin)) return false;
  if (value.pin.templateId !== pin.templateId || value.pin.version !== pin.version || value.pin.graphHash !== pin.graphHash) return false;
  return (value.kind === "local-create-and-run" && optional(value, "projectRoot", text)) || (value.kind === "schedule-attachment" && isTemplateId(value.attachmentId) && timestamp(value.firedAt));
}
/** One entry of the covered run file. Unknown keys are refused, so an entry is either fully understood or left untouched. */
export function assertWorkflowRunRecord(raw: unknown): asserts raw is WorkflowRunRecord {
  const check = (condition: unknown): void => requireTemplate(condition, "invalid-template-run");
  check(hasTemplateKeys(raw, ["runId", "itemId", "pin", "runStartedBy", "startedAt", "stageRuns", "stageJoins", "runWorkspace", "settled"]));
  const run = raw as Record<string, unknown>;
  check(text(run.runId, 256) && Number.isSafeInteger(run.itemId) && (run.itemId as number) > 0 && timestamp(run.startedAt));
  const pin = run.pin;
  check(hasTemplateKeys(pin, ["templateId", "version", "graphHash"]) && isTemplateId(pin.templateId) && isTemplateVersion(pin.version) && isGraphHash(pin.graphHash));
  check(stages(run.stageRuns));
  check(authority(run.runStartedBy, pin as Record<string, unknown>));
  check(optional(run, "runWorkspace", value => workspace(value, true)));
  check(optional(run, "settled", value => hasTemplateKeys(value, ["status", "at"]) && ["completed", "denied", "error", "cancelled"].includes(value.status as string) && timestamp(value.at)));
  if (run.stageJoins !== undefined) {
    check(joins(run.stageJoins));
    const stageIds = new Set((run.stageRuns as { stageId: string }[]).map(stage => stage.stageId));
    check((run.stageJoins as { stageIds: string[] }[]).every(join => join.stageIds.every(id => stageIds.has(id))));
  }
}

const BOARD_RUN_FIELDS = ["runTemplateVersion", "runTemplateGraphHash", "runStartedBy", "pin", "stageRuns", "stageJoins", "runWorkspace", "gate", "resultHash", "outputHash", "templateRunError"];
function without(value: unknown, fields: readonly string[]): unknown {
  if (!isRecord(value)) return value;
  const clean = { ...value };
  for (const field of fields) delete clean[field];
  return clean;
}
/** A board row names its run by runId only: every run field is removed from the row, its run history and its plan approval. */
export function stripBoardRunFields<T>(row: T): T {
  if (!isRecord(row)) return row;
  const clean = without(row, BOARD_RUN_FIELDS) as Record<string, unknown>;
  if (Array.isArray(clean.runHistory)) clean.runHistory = clean.runHistory.map(entry => without(entry, ["templateVersion", "templateGraphHash", "stageRuns"]));
  if (isRecord(clean.planApproval)) clean.planApproval = without(clean.planApproval, ["templateGraphHash"]);
  return clean as T;
}

/** Legacy boards predate templates: their rows keep ordinary item and run history fields only. */
export function stripLegacyBoardTemplateRunFields<T extends { items: unknown[] }>(board: T): T {
  return { ...board, items: board.items.map(row => without(stripBoardRunFields(row), ["templateId"])) };
}
