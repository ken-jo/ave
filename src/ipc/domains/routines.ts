import { ipcMain } from "electron";
import { validateHostRendererSender, UNAUTHORIZED_FRAME, auditUnauthorized } from "../gated.js";
import type { IpcDeps } from "../types.js";
import type { RoutineExecution, RoutineFiredPayload, RoutineListResult, RoutineSchedule } from "../../shared/routines-types.js";
import { ROUTINES } from "../../shared/ipc-channels.js";
import { toSessionListRow } from "../../memory/memory-manager.js";
import type { RoutineRunRow } from "../../shared/session-lookup.js";
import { ensureSuggestionsSession } from "../../main/suggestions-session.js";

export function registerRoutineHandlers(deps: IpcDeps): void {
  const { routinesStore, routinesScheduler, memoryManager, auditLogger } = deps;

  ipcMain.handle(ROUTINES.list, (e) => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, ROUTINES.list, e);
      return UNAUTHORIZED_FRAME;
    }
    if (!routinesStore) return { routines: [], invalid: [] } satisfies RoutineListResult;
    return routinesStore.listForDisplay();
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
    const updated = await routinesStore.update(routineId, { lastResultAcknowledgedAt: firedAt });
    if (!updated) return { ok: false, error: "routine-not-found" };
    return { ok: true };
  });

  ipcMain.handle(
    ROUTINES.add,
    async (
      e,
      input: {
        trigger: "shutdown" | "schedule";
        schedule?: RoutineSchedule;
        execution: RoutineExecution;
        prePrompt?: string;
        title?: string;
        notificationTitle?: string;
        notificationBody?: string;
      },
    ) => {
      if (!validateHostRendererSender(e)) {
        auditUnauthorized(auditLogger, ROUTINES.add, e);
        return UNAUTHORIZED_FRAME;
      }
      if (!routinesStore) return { ok: false, error: "no-store" };
      try {
        const record = await routinesStore.add(input);
        return { ok: true, routine: record };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    },
  );

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
