import type { WorkBoardEngine } from "../core/work-board-engine.js";
import type { EnvelopeToolRef } from "../shared/workflow-template-types.js";
import type { RoutineRunOutcome } from "../shared/routines-types.js";
import type { RoutinesStore, TemplateRoutineFire } from "./routines-store.js";
import type { WorkBoardStore } from "./work-board-store.js";
import type { WorkflowTemplateStore } from "./workflow-template-store.js";
import { createLogger } from "../lib/logger.js";
import type { mayFire, ScheduledRunOutcome } from "../work-board/workflow/schedule-breaker.js";

interface ScheduledTemplateDeps {
  routinesStore: RoutinesStore;
  workflowTemplateStore: WorkflowTemplateStore;
  workBoardStore: WorkBoardStore;
  workBoardEngine: Pick<WorkBoardEngine, "startScheduledTemplate" | "readScheduledOutcome">;
}

const failed = (reason: string): RoutineRunOutcome => ({ ok: false, kind: "error", reason });
const log = createLogger("ave");
const pendingRuns = new WeakMap<RoutinesStore, Set<string>>();

function refusedFire(code: string, tool?: EnvelopeToolRef): RoutineRunOutcome {
  return (code === "outward-effect-tool" || code === "tool-effect-unknown") && tool
    ? { ok: false, kind: "template-skipped", skip: { code, tool } } : failed(code);
}

export async function fireScheduledTemplate(deps: ScheduledTemplateDeps, { routine, attachment }: TemplateRoutineFire, checkAdmission: typeof mayFire): Promise<void> {
  const { routinesStore, workflowTemplateStore, workBoardStore, workBoardEngine } = deps;
  const { id, lastFiredAt: firedAt } = routine;
  if (!firedAt || routine.execution !== "template-run") throw new Error("Expected a fired template routine");
  const pending = pendingRuns.get(routinesStore) ?? new Set<string>();
  pendingRuns.set(routinesStore, pending);

  const admitted = await routinesStore.withTemplateSchedule(id, async () => {
    const current = routinesStore.listActive().find(record => record.id === id);
    if (!current) return null;
    const unsettled = {
      outcome: { ok: false, kind: "template-skipped", skip: { code: "run-unsettled" } } satisfies RoutineRunOutcome,
    };
    const firstCheck = checkAdmission({ unsettledRun: pending.has(id), paused: current.pausedAt !== undefined });
    if (!firstCheck.fire) return firstCheck.reason === "paused" ? null : unsettled;
    if ("reason" in attachment && attachment.reason === "attachment-unavailable") return { outcome: failed(attachment.reason) };
    const attachments = await workflowTemplateStore.listByRoutine(id);
    const ids = new Set(attachments.map(attachment => attachment.id));
    const board = await workBoardStore.list();
    const runs = await workBoardStore.runs.list();
    if (board.status !== "ok" || board.unreadableRows?.length || board.unreadableRuns?.length || board.writesRefused || runs.status !== "found") {
      return { outcome: failed("run-state-unavailable") };
    }
    let unsettledRun = false;
    let latestEnd: { firedAt: string; outcome: ScheduledRunOutcome } | undefined;
    for (const run of runs.runs) {
      const { runStartedBy, settled } = run;
      if (runStartedBy.kind !== "schedule-attachment" || !ids.has(runStartedBy.attachmentId)) continue;
      if (settled === undefined) unsettledRun = true;
      const outcome = await workBoardEngine.readScheduledOutcome(run);
      if (outcome && (!latestEnd || runStartedBy.firedAt > latestEnd.firedAt)) latestEnd = { firedAt: runStartedBy.firedAt, outcome };
    }
    // Recover a late outcome from the run file if this process did not observe it.
    const updated = latestEnd && await routinesStore.recordTemplateScheduleOutcome(id, latestEnd.firedAt, latestEnd.outcome);
    const admission = checkAdmission({ unsettledRun, paused: (updated ?? current).pausedAt !== undefined });
    if (!admission.fire) return admission.reason === "paused" ? null : unsettled;
    if ("reason" in attachment) return { outcome: failed(attachment.reason) };
    const active = attachments.find(entry => entry.detachedAt === undefined);
    if (active && active.id !== attachment.id) {
      return { outcome: { ok: false, kind: "template-skipped", skip: { code: "attachment-replaced" } } satisfies RoutineRunOutcome };
    }
    if (!active) return { outcome: failed("attachment-missing") };
    const { id: attachmentId, templateId, version, graphHash } = active;
    const started = await workBoardEngine.startScheduledTemplate({ kind: "schedule-attachment", attachmentId, pin: { templateId, version, graphHash }, firedAt }, current.title ?? templateId);
    if (started.ok) {
      pending.add(id);
      return { result: started.result, breakerOutcome: started.breakerOutcome, completion: started.completion };
    }
    const outcome = refusedFire(started.code, started.tool);
    if (!outcome.ok && outcome.kind === "template-skipped") await routinesStore.recordTemplateScheduleOutcome(id, firedAt, "skipped-unavailable");
    return { outcome };
  });
  if (!admitted) return;
  if (admitted.outcome) {
    await routinesStore.recordRunOutcome(id, firedAt, admitted.outcome);
    return;
  }
  try {
    const result = await admitted.result;
    const completed = result.status === "completed";
    const parked = result.status === "awaiting_approval" && result.reasonCode === undefined;
    const outcome = completed || parked ? { ok: true } as const : failed(result.reasonCode ?? "template-run-unavailable");
    const breakerOutcome = parked ? null : await admitted.breakerOutcome;
    await routinesStore.withTemplateSchedule(id, async () => {
      if (breakerOutcome) await routinesStore.recordTemplateScheduleOutcome(id, firedAt, breakerOutcome);
      await routinesStore.recordRunOutcome(id, firedAt, outcome);
    });
    const recordLater = (later: ScheduledRunOutcome) =>
      routinesStore.withTemplateSchedule(id, async () => {
        await routinesStore.recordTemplateScheduleOutcome(id, firedAt, later);
        await routinesStore.recordRunOutcome(id, firedAt, later === "completed" ? { ok: true }
          : failed(later === "parked-on-denials" ? later : "stage-failed"));
      });
    if (result.status === "awaiting_approval") {
      const persistLater = async () => {
        if (parked) {
          const later = await admitted.breakerOutcome;
          if (later !== null) await recordLater(later);
          if (later === "completed") return;
        }
        if (await admitted.completion) await recordLater("completed");
      };
      void persistLater().catch(() => log.warn("scheduled template outcome could not be stored (%s)", id));
    }
  } finally {
    pending.delete(id);
  }
}
