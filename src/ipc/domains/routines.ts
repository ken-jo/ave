import { ipcMain } from "electron";
import { validateHostRendererSender, UNAUTHORIZED_FRAME, auditUnauthorized } from "../gated.js";
import type { IpcDeps } from "../types.js";
import type {
  AddRoutineInput,
  RoutineEditPatch,
  RoutineFiredPayload,
  RoutineListResult,
  RoutineOccurrencesResult,
  RoutineRun,
} from "../../shared/routines-types.js";
import { listRoutineOccurrences } from "../../routines/occurrences.js";
import { ROUTINES } from "../../shared/ipc-channels.js";
import { toSessionListRow } from "../../memory/memory-manager.js";
import type { RoutineRunRow } from "../../shared/session-lookup.js";
import { ensureSuggestionsSession } from "../../main/suggestions-session.js";

// The month grid spans at most six weeks; a little slack keeps a range that starts mid-day valid.
const MAX_OCCURRENCE_RANGE_MS = 43 * 24 * 60 * 60 * 1000;

function projectRootFilter(filter: unknown): string | undefined {
  if (!filter || typeof filter !== "object") return undefined;
  const projectRoot = (filter as Record<string, unknown>).projectRoot;
  return typeof projectRoot === "string" && projectRoot.trim() ? projectRoot : undefined;
}

export function registerRoutineHandlers(deps: IpcDeps): void {
  const { routinesStore, routinesScheduler, memoryManager, auditLogger } = deps;

  ipcMain.handle(ROUTINES.list, (e, filter?: unknown) => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, ROUTINES.list, e);
      return UNAUTHORIZED_FRAME;
    }
    if (!routinesStore) return { routines: [], invalid: [] } satisfies RoutineListResult;
    const projectRoot = projectRootFilter(filter);
    return projectRoot === undefined ? routinesStore.listForDisplay() : routinesStore.listForDisplay({ projectRoot });
  });

  ipcMain.handle(ROUTINES.dismiss, async (e, id: string) => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, ROUTINES.dismiss, e);
      return UNAUTHORIZED_FRAME;
    }
    if (!routinesStore) return { ok: false, error: "no-store" };
    const ok = await routinesStore.dismiss(id);
    return { ok };
  });

  ipcMain.handle(ROUTINES.remove, async (e, id: string) => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, ROUTINES.remove, e);
      return UNAUTHORIZED_FRAME;
    }
    if (!routinesStore) return { ok: false, error: "no-store" };
    const ok = await routinesStore.remove(id);
    if (ok) {
      const { endSessionScopedPermissions } = await import("../../permissions/session-scope-end.js");
      for (const session of memoryManager.listSessionsByRoutine(id)) {
        await memoryManager.deleteSession(session.id);
        endSessionScopedPermissions(session.id, deps.conversationLoop.permissionManager);
      }
    }
    return { ok };
  });

  ipcMain.handle(ROUTINES.triggerNow, async (e, id: string) => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, ROUTINES.triggerNow, e);
      return UNAUTHORIZED_FRAME;
    }
    if (!routinesStore) return { ok: false, error: "no-store" };
    if (!routinesScheduler) return { ok: false, error: "no-scheduler" };
    // Use scheduler dispatch so manual triggers preserve persistence and dedup semantics.
    const dispatched = await routinesScheduler.dispatchNow(id);
    if (dispatched === "plugins-missing") return { ok: false, error: "plugins-missing" };
    if (dispatched === "paused") return { ok: false, error: "paused" };
    if (!dispatched) return { ok: false, error: "routine-not-found" };
    return { ok: true };
  });

  ipcMain.handle(ROUTINES.pendingResults, async (e) => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, ROUTINES.pendingResults, e);
      return UNAUTHORIZED_FRAME;
    }
    if (!routinesStore) return [];
    const pending = routinesStore
      .list()
      .filter((routine) => routine.lastFiredAt && routine.lastResultAcknowledgedAt !== routine.lastFiredAt);
    const results: RoutineFiredPayload[] = [];
    for (const routine of pending) {
      const firedAt = routine.lastFiredAt!;
      const title = routine.title ?? routine.notificationTitle ?? routine.id.slice(0, 8);
      const result: RoutineFiredPayload = {
        id: routine.id,
        trigger: routine.trigger,
        execution: routine.execution,
        firedAt,
        title,
        summary: "",
      };
      if (routine.execution === "llm-session" && routine.lastRoutineSessionId) {
        const session = memoryManager
          .listSessionsByRoutine(routine.id)
          .find((candidate) => candidate.id === routine.lastRoutineSessionId);
        if (session) {
          result.routineSessionId = session.id;
          result.summary = session.preview;
        }
      }
      results.push(result);
    }
    // Ensure Suggestions exists before returning cards addressed to it.
    if (results.length > 0) ensureSuggestionsSession(memoryManager);
    return results;
  });

  ipcMain.handle(ROUTINES.acknowledgeResult, async (e, routineId: string, firedAt: string) => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, ROUTINES.acknowledgeResult, e);
      return UNAUTHORIZED_FRAME;
    }
    if (!routinesStore) return { ok: false, error: "no-store" };
    const updated = await routinesStore.acknowledgeResult(routineId, firedAt);
    if (!updated) return { ok: false, error: "routine-not-found" };
    return { ok: true };
  });

  ipcMain.handle(ROUTINES.acknowledgeFailure, async (e, routineId: unknown, failureFiredAt: unknown) => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, ROUTINES.acknowledgeFailure, e);
      return UNAUTHORIZED_FRAME;
    }
    if (typeof routineId !== "string" || typeof failureFiredAt !== "string") return { ok: false, error: "invalid-input" };
    if (!routinesStore) return { ok: false, error: "no-store" };
    const outcome = await routinesStore.acknowledgeFailure(routineId, failureFiredAt);
    if (outcome === "not-found") return { ok: false, error: "routine-not-found" };
    // A newer failure replaced the one the user saw; the card re-lists on the change signal and shows that one instead.
    if (outcome === "stale") return { ok: false, error: "routine-failure-stale" };
    return { ok: true };
  });

  ipcMain.handle(
    ROUTINES.add,
    async (
      e,
      input: Pick<AddRoutineInput, "trigger" | "schedule" | "execution" | "prePrompt" | "title" | "notificationTitle" | "notificationBody" | "projectRoot">,
    ) => {
      if (!validateHostRendererSender(e)) {
        auditUnauthorized(auditLogger, ROUTINES.add, e);
        return UNAUTHORIZED_FRAME;
      }
      if (!routinesStore) return { ok: false, error: "no-store" };
      try {
        // The renderer form is the user's own action; only the host's tool path may record an agent as creator.
        const record = await routinesStore.add({ ...input, createdBy: "user" });
        return { ok: true, routine: record };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    },
  );

  ipcMain.handle(ROUTINES.update, async (e, id: unknown, patch: unknown) => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, ROUTINES.update, e);
      return UNAUTHORIZED_FRAME;
    }
    if (!routinesStore) return { ok: false, error: "no-store" };
    if (typeof id !== "string" || !patch || typeof patch !== "object" || Array.isArray(patch)) return { ok: false, error: "invalid-input" };
    try {
      const routine = await routinesStore.edit(id, patch as RoutineEditPatch);
      return routine ? { ok: true, routine } : { ok: false, error: "routine-not-found" };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  // Pause and resume from the panel are the user's own actions: they apply at once, with no confirmation.
  for (const [channel, apply] of [
    [ROUTINES.pause, (id: string) => routinesStore?.pause(id, "user")],
    [ROUTINES.resume, (id: string) => routinesStore?.resume(id)],
  ] as const) {
    ipcMain.handle(channel, async (e, id: unknown) => {
      if (!validateHostRendererSender(e)) {
        auditUnauthorized(auditLogger, channel, e);
        return UNAUTHORIZED_FRAME;
      }
      if (!routinesStore) return { ok: false, error: "no-store" };
      if (typeof id !== "string") return { ok: false, error: "invalid-input" };
      const routine = await apply(id);
      return routine ? { ok: true, routine } : { ok: false, error: "routine-not-found" };
    });
  }

  ipcMain.handle(ROUTINES.listOccurrences, (e, query: unknown): RoutineOccurrencesResult | typeof UNAUTHORIZED_FRAME => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, ROUTINES.listOccurrences, e);
      return UNAUTHORIZED_FRAME;
    }
    const q = (query && typeof query === "object" ? query : {}) as Record<string, unknown>;
    const from = typeof q.from === "string" ? Date.parse(q.from) : Number.NaN;
    const to = typeof q.to === "string" ? Date.parse(q.to) : Number.NaN;
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from || to - from > MAX_OCCURRENCE_RANGE_MS) {
      return { ok: false, error: "invalid-range" };
    }
    if (!routinesStore) return { ok: true, occurrences: [], runs: [] };
    const projectRoot = projectRootFilter(q);
    const { routines } = projectRoot === undefined ? routinesStore.listForDisplay() : routinesStore.listForDisplay({ projectRoot });
    const runs: RoutineRun[] = [];
    for (const routine of routines) {
      const inRange = (iso: string | undefined): iso is string => {
        const t = iso ? Date.parse(iso) : Number.NaN;
        return Number.isFinite(t) && t >= from && t < to;
      };
      const statusOf = (firedAt: string): RoutineRun["status"] => (routine.lastFailure?.firedAt === firedAt ? "failed" : "done");
      const seen = new Set<string>();
      if (routine.execution === "llm-session") {
        for (const session of memoryManager.listSessionsByRoutine(routine.id)) {
          if (!inRange(session.routineFiredAt) || seen.has(session.routineFiredAt)) continue;
          seen.add(session.routineFiredAt);
          runs.push({ routineId: routine.id, firedAt: session.routineFiredAt, status: statusOf(session.routineFiredAt), sessionId: session.id });
        }
      }
      // A failed run may have no session, and a notification item never has one.
      if (inRange(routine.lastFiredAt) && !seen.has(routine.lastFiredAt)) {
        runs.push({ routineId: routine.id, firedAt: routine.lastFiredAt, status: statusOf(routine.lastFiredAt) });
      }
    }
    runs.sort((a, b) => a.firedAt.localeCompare(b.firedAt));
    return { ok: true, occurrences: listRoutineOccurrences(routines, { from, to, now: Date.now() }), runs };
  });

  // Return the sidebar's shared run-row shape so panels and sidebar describe the same sessions.
  ipcMain.handle(ROUTINES.listSessions, async (e, routineId: string, limit?: number) => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, ROUTINES.listSessions, e);
      return UNAUTHORIZED_FRAME;
    }
    return memoryManager
      .listSessionsByRoutine(routineId, limit ?? 10)
      .flatMap((session): RoutineRunRow[] => {
        const row = toSessionListRow("main", session);
        return row === null ? [] : [{ ...row, preview: session.preview }];
      });
  });
}
