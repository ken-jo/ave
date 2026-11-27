import { isPositiveSafeInteger } from "../shared/safe-integer.js";
import type { TailnetWorkDecisionRequest } from "../shared/tailnet-work-decisions.js";
import { UUID_PATTERN } from "../shared/uuid.js";
import { hasTemplateKeys, isGraphHash, isStageId, isTemplateId } from "../work-board/template-graph.js";
import { parseDecidePlanInput, parseDecideStageInput, parseJoinBinding, parseTemplateConfirmInput, parseTemplateRunTuple, RUN_ID_PATTERN } from "../work-board/work-decision-input.js";
import { parseScheduleAttachmentRequest } from "../work-board/schedule-attachment-input.js";

export function parseTailnetWorkDecision(raw: unknown): TailnetWorkDecisionRequest | null {
  if (!hasTemplateKeys(raw, ["id", "scope", "kind", "input", "itemId", "templateId", "reviewHandle"])
    || typeof raw.id !== "string" || !UUID_PATTERN.test(raw.id)
    || typeof raw.scope !== "string" || !UUID_PATTERN.test(raw.scope)
    || typeof raw.kind !== "string") return null;
  const { id, scope, kind, itemId, templateId, input, reviewHandle } = raw;
  if (reviewHandle !== undefined && ((kind !== "stage" && kind !== "requested-output")
    || typeof reviewHandle !== "string" || !UUID_PATTERN.test(reviewHandle))) return null;
  const base = { id, scope, ...(reviewHandle === undefined ? {} : { reviewHandle }) };
  if (kind === "output-retry") {
    if (!isPositiveSafeInteger(itemId) || templateId !== undefined
      || !hasTemplateKeys(input, ["runId", "stageId", "attempt", "outputHash", "outputId"])
      || typeof input.runId !== "string" || !RUN_ID_PATTERN.test(input.runId) || !isStageId(input.stageId)
      || !isPositiveSafeInteger(input.attempt) || !isGraphHash(input.outputHash)
      || typeof input.outputId !== "string" || !UUID_PATTERN.test(input.outputId)) return null;
    return { ...base, kind, itemId, input: { runId: input.runId, stageId: input.stageId, attempt: input.attempt, outputHash: input.outputHash, outputId: input.outputId } };
  }
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
    const parsed = parseTemplateConfirmInput(input);
    return parsed && isTemplateId(templateId) ? { ...base, kind, templateId, input: parsed } : null;
  }
  if (templateId !== undefined) return null;
  if (kind === "output-execution-card") {
    if (!hasTemplateKeys(input, ["handle", "choice"]) || typeof input.handle !== "string" || input.handle.length > 115
      || !/^[\da-f-]{36}\.\d{1,16}\.[\da-f]{64}$/u.test(input.handle)
      || (input.choice !== "allow-once" && input.choice !== "deny-once")) return null;
    return { ...base, kind, input: { handle: input.handle, choice: input.choice } };
  }
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
    if (!hasTemplateKeys(input, ["itemId", "runId", "stageId", "attempt", "outputHash", "decision"])
      || !isPositiveSafeInteger(input.itemId) || typeof input.runId !== "string" || !RUN_ID_PATTERN.test(input.runId)
      || !isStageId(input.stageId) || !isPositiveSafeInteger(input.attempt)
      || !isGraphHash(input.outputHash)
      || (input.decision !== "approve" && input.decision !== "reject")) return null;
    return { ...base, kind, input: {
      itemId: input.itemId, runId: input.runId, stageId: input.stageId, attempt: input.attempt,
      outputHash: input.outputHash, decision: input.decision,
    } };
  }
  return null;
}
