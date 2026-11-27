import { isPositiveSafeInteger } from "../shared/safe-integer.js";
import type { TailnetWorkDecisionRequest } from "../shared/tailnet-work-decisions.js";
import { UUID_PATTERN } from "../shared/uuid.js";
import { hasTemplateKeys, isGraphHash, isStageId, isTemplateId } from "../work-board/template-graph.js";
import { parseDecidePlanInput, parseDecideStageInput, parseJoinBinding, parseTemplateRunTuple, RUN_ID_PATTERN } from "../work-board/work-decision-input.js";
import { parseScheduleAttachmentRequest } from "../work-board/schedule-attachment-input.js";

export function parseTailnetWorkDecision(raw: unknown): TailnetWorkDecisionRequest | null {
  if (!hasTemplateKeys(raw, ["id", "scope", "kind", "input", "itemId", "templateId"])
    || typeof raw.id !== "string" || !UUID_PATTERN.test(raw.id)
    || typeof raw.scope !== "string" || !UUID_PATTERN.test(raw.scope)
    || typeof raw.kind !== "string") return null;
  const { id, scope, kind, itemId, templateId, input } = raw;
  const base = { id, scope };
  if (kind === "plan" || kind === "stage" || kind === "join") {
    if (!isPositiveSafeInteger(itemId) || templateId !== undefined) return null;
    if (kind === "plan") {
      const parsed = parseDecidePlanInput(input);
      return parsed && { ...base, kind, itemId, input: parsed };
    }
    if (kind === "stage") {
      const parsed = parseDecideStageInput(input);
      return parsed && { ...base, kind, itemId, input: parsed };
    }
    if (!hasTemplateKeys(input, ["runId", "joinId", "conflictHash", "generation", "decision"])
      || (input.decision !== "retry_merge" && input.decision !== "reject")) return null;
    const parsed = parseJoinBinding(input);
    return parsed && { ...base, kind, itemId, input: { ...parsed, decision: input.decision } };
  }
  if (itemId !== undefined) return null;
  if (kind === "template-confirmation") {
    if (!isTemplateId(templateId) || !hasTemplateKeys(input, ["expectedGraphHash", "expectedDraftRevision"])
      || !isGraphHash(input.expectedGraphHash) || !isTemplateId(input.expectedDraftRevision)) return null;
    return { ...base, kind, templateId, input: { expectedGraphHash: input.expectedGraphHash, expectedDraftRevision: input.expectedDraftRevision } };
  }
  if (templateId !== undefined) return null;
  if (kind === "create-and-run") {
    if (!hasTemplateKeys(input, ["templateId", "version", "graphHash", "projectRoot", "title", "detail"])
      || typeof input.title !== "string" || (input.detail !== undefined && typeof input.detail !== "string")) return null;
    const { title, detail, ...target } = input;
    const parsed = parseTemplateRunTuple(target);
    return parsed && { ...base, kind, input: { ...parsed.pin, projectRoot: parsed.projectRoot, title, detail } };
  }
  if (kind === "schedule-attachment") {
    const parsed = parseScheduleAttachmentRequest(input);
    return parsed && { ...base, kind, input: parsed };
  }
  if (kind === "requested-output") {
    if (!hasTemplateKeys(input, ["itemId", "runId", "stageId", "attempt", "outputId", "outputHash", "decision"])
      || !isPositiveSafeInteger(input.itemId) || typeof input.runId !== "string" || !RUN_ID_PATTERN.test(input.runId)
      || !isStageId(input.stageId) || !isPositiveSafeInteger(input.attempt)
      || !isTemplateId(input.outputId) || !isGraphHash(input.outputHash)
      || (input.decision !== "approve" && input.decision !== "reject")) return null;
    return { ...base, kind, input: {
      itemId: input.itemId, runId: input.runId, stageId: input.stageId, attempt: input.attempt,
      outputId: input.outputId, outputHash: input.outputHash, decision: input.decision,
    } };
  }
  return null;
}
