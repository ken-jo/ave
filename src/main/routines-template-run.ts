import type { WorkBoardEngine } from "../core/work-board-engine.js";
import type { EnvelopeToolRef } from "../shared/workflow-template-types.js";
import type { RoutineRunOutcome } from "../shared/routines-types.js";
import type { RoutinesStore, TemplateRoutineFire } from "./routines-store.js";
import type { WorkBoardStore } from "./work-board-store.js";
import type { WorkflowTemplateStore } from "./workflow-template-store.js";

interface ScheduledTemplateDeps {
  routinesStore: RoutinesStore;
  workflowTemplateStore: WorkflowTemplateStore;
  workBoardStore: WorkBoardStore;
  workBoardEngine: Pick<WorkBoardEngine, "startScheduledTemplate">;
}

const failed = (reason: string): RoutineRunOutcome => ({ ok: false, kind: "error", reason });

function refusedFire(code: string, tool?: EnvelopeToolRef): RoutineRunOutcome {
  return (code === "outward-effect-tool" || code === "tool-effect-unknown") && tool
    ? { ok: false, kind: "template-skipped", skip: { code, tool } } : failed(code);
}

export async function fireScheduledTemplate(deps: ScheduledTemplateDeps, { routine, attachment }: TemplateRoutineFire): Promise<void> {
  const { routinesStore, workflowTemplateStore, workBoardStore, workBoardEngine } = deps;
  const { id, lastFiredAt: firedAt } = routine;
  if (!firedAt || routine.execution !== "template-run") throw new Error("Expected a fired template routine");

  const admitted = await routinesStore.withTemplateSchedule(id, async () => {
    const current = routinesStore.listActive().find(record => record.id === id);
    if (!current || current.pausedAt) return null;
    if ("reason" in attachment) return { outcome: failed(attachment.reason) };
    const attachments = await workflowTemplateStore.listByRoutine(id);
    const active = attachments.find(entry => entry.detachedAt === undefined);
    if (active && active.id !== attachment.id) {
      return { outcome: { ok: false, kind: "template-skipped", skip: { code: "attachment-replaced" } } satisfies RoutineRunOutcome };
    }
    if (!active) return { outcome: failed("attachment-missing") };
    const ids = new Set(attachments.map(attachment => attachment.id));
    const board = await workBoardStore.list();
    const runs = await workBoardStore.runs.list();
    if (board.status !== "ok" || board.unreadableRows?.length || board.unreadableRuns?.length || board.writesRefused || runs.status !== "found") {
      return { outcome: failed("run-state-unavailable") };
    }
    if (runs.runs.some(({ runStartedBy, settled }) => settled === undefined && runStartedBy.kind === "schedule-attachment" && ids.has(runStartedBy.attachmentId))) {
      return { outcome: { ok: false, kind: "template-skipped", skip: { code: "run-unsettled" } } satisfies RoutineRunOutcome };
    }
    const { id: attachmentId, templateId, version, graphHash } = active;
    const started = await workBoardEngine.startScheduledTemplate({ kind: "schedule-attachment", attachmentId, pin: { templateId, version, graphHash }, firedAt }, current.title ?? templateId);
    if (started.ok) return { result: started.result };
    return { outcome: refusedFire(started.code, started.tool) };
  });
  if (!admitted) return;
  const result = admitted.result ? await admitted.result : undefined;
  const outcome = admitted.outcome ?? (result?.status === "completed" || result?.status === "awaiting_approval"
    ? { ok: true } : refusedFire(result?.reasonCode ?? "template-run-unavailable", result?.status === "error" ? result.reasonTool : undefined));
  await routinesStore.recordRunOutcome(id, firedAt, outcome);
}
