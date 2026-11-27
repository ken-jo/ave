import { isRoutineScheduleShape } from "../routines/schedule-advance.js";
import type { RoutineSchedule } from "../shared/routines-types.js";
import type { ScheduleAttachmentRequest } from "../shared/workflow-template-types.js";
import { hasTemplateKeys, isGraphHash, isTemplateId, isTemplateScope, isTemplateVersion } from "./template-graph.js";

export function parseScheduleAttachmentRequest(raw: unknown): ScheduleAttachmentRequest | null {
  if (!hasTemplateKeys(raw, ["templateId", "version", "graphHash", "expectedScope", "scheduleId", "schedule"])
    || !isTemplateId(raw.templateId) || !isTemplateVersion(raw.version) || !isGraphHash(raw.graphHash)
    || !isTemplateScope(raw.expectedScope)) return null;
  const { templateId, version, graphHash, expectedScope, scheduleId, schedule } = raw;
  const pin = { templateId, version, graphHash, expectedScope };
  if (scheduleId === undefined) return isAttachmentSchedule(schedule) ? { ...pin, schedule } : null;
  return isTemplateId(scheduleId) && schedule === undefined ? { ...pin, scheduleId } : null;
}

function isAttachmentSchedule(value: unknown): value is RoutineSchedule {
  if (!isRoutineScheduleShape(value)) return false;
  const { at, repeat } = value;
  if (!hasTemplateKeys(value, ["at", "repeat"])) return false;
  if (!repeat) return at !== undefined;
  if (repeat.kind === "cron") return hasTemplateKeys(repeat, ["kind", "expression"]);
  return at !== undefined && hasTemplateKeys(repeat, repeat.kind === "interval" ? ["kind", "intervalMs"] : ["kind"]);
}
