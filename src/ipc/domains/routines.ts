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
import { isRoutineScheduleShape } from "../../routines/schedule-advance.js";
import { ROUTINES } from "../../shared/ipc-channels.js";
import { toSessionListRow } from "../../memory/memory-manager.js";
import type { RoutineRunRow } from "../../shared/session-lookup.js";
import { ensureSuggestionsSession } from "../../main/suggestions-session.js";
import { isRoutineExecution, isRoutineTrigger, isValidRoutineScope, removeRoutineWithRuns } from "../../main/routines-store.js";
import { MAX_ROUTINE_SOURCE_LENGTH } from "../../shared/routines-types.js";
import { isValidSessionId } from "../../shared/session-id.js";
import { projectRootEquals } from "../../shared/project-identity.js";
import { defaultWorkspaceProject } from "../../main/project-root-authorization.js";

// The month grid spans at most six weeks; a little slack keeps a range that starts mid-day valid.
const MAX_OCCURRENCE_RANGE_MS = 43 * 24 * 60 * 60 * 1000;

const OPTIONAL_TEXT_FIELDS = ["title", "prePrompt", "notificationTitle", "notificationBody"] as const;

// Renderer input crosses a trust boundary: wrong types are refused here, before the store's value validation.
function hasValidFieldTypes(input: Record<string, unknown>, allowNullTitle: boolean): boolean {
  for (const field of OPTIONAL_TEXT_FIELDS) {
    const value = input[field];
    if (value === undefined || typeof value === "string") continue;
    if (field === "title" && allowNullTitle && value === null) continue;
    return false;
  }
  return input.schedule === undefined || isRoutineScheduleShape(input.schedule);
}

// The panel only records which installed template an item came from; other sources (plugin suggestions) are host-only.
const RENDERER_ROUTINE_SOURCE = /^(?:agent-plugin|extension):[^:\s]+:[^:\s]+$/;

function hasValidAddFields(input: Record<string, unknown>): boolean {
  if (!isRoutineTrigger(input.trigger) || !isRoutineExecution(input.execution)) return false;
  if (input.scope !== undefined && !isValidRoutineScope(input.scope)) return false;
  if (input.source === undefined) return true;
  return typeof input.source === "string" && input.source.length <= MAX_ROUTINE_SOURCE_LENGTH && RENDERER_ROUTINE_SOURCE.test(input.source);
}

function projectRootFilter(filter: unknown): string | undefined {
  if (!filter || typeof filter !== "object") return undefined;
  const projectRoot = (filter as Record<string, unknown>).projectRoot;
  return typeof projectRoot === "string" && projectRoot.trim() ? projectRoot : undefined;
}

export function registerRoutineHandlers(deps: IpcDeps): void {
  const { routinesStore, routinesScheduler, memoryManager, auditLogger } = deps;

  // 대화에 연결: the chat must exist and belong to the item's project. A chat outside any named project belongs to the default
  // workspace, like everywhere else. Null when the chat may be connected, else the error code.
  const chatLinkError = (targetSessionId: string, projectRoot: string | undefined): string | null => {
    const metadata = memoryManager.loadSessionMetadata(targetSessionId);
    // The same existence test the fire uses: a chat needs its metadata and its transcript.
    if (!metadata || !memoryManager.hasSessionTranscript(targetSessionId)) return "chat-not-found";
    const defaultRoot = () => defaultWorkspaceProject().projectRoot;
    return projectRootEquals(metadata.projectRoot ?? defaultRoot(), projectRoot ?? defaultRoot()) ? null : "chat-other-project";
  };

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
    const ok = await removeRoutineWithRuns(
      {
        routinesStore,
        memoryManager,
        endSessionScope: async (sessionId) => {
          const { endSessionScopedPermissions } = await import("../../permissions/session-scope-end.js");
          endSessionScopedPermissions(sessionId, deps.conversationLoop.permissionManager);
        },
      },
      id,
    );
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
    if (dispatched === "orphaned") return { ok: false, error: "orphaned" };
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
      input: Omit<AddRoutineInput, "createdBy">,
    ) => {
      if (!validateHostRendererSender(e)) {
        auditUnauthorized(auditLogger, ROUTINES.add, e);
        return UNAUTHORIZED_FRAME;
      }
      if (!routinesStore) return { ok: false, error: "no-store" };
      if (!input || typeof input !== "object" || Array.isArray(input)) return { ok: false, error: "invalid-input" };
      // Every new item belongs to a project; the panel passes the active one.
      if (typeof input.projectRoot !== "string" || !input.projectRoot.trim()) return { ok: false, error: "project-required" };
      const fields = input as unknown as Record<string, unknown>;
      if (!hasValidFieldTypes(fields, false) || !hasValidAddFields(fields)) return { ok: false, error: "invalid-input" };
      if (input.targetSessionId !== undefined) {
        if (!isValidSessionId(input.targetSessionId)) return { ok: false, error: "invalid-input" };
        const linkError = chatLinkError(input.targetSessionId, input.projectRoot);
        if (linkError) return { ok: false, error: linkError };
      }
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
    if (typeof id !== "string" || !patch || typeof patch !== "object" || Array.isArray(patch)
      || !hasValidFieldTypes(patch as Record<string, unknown>, true)) return { ok: false, error: "invalid-input" };
    const target = (patch as Record<string, unknown>).targetSessionId;
    if (target !== undefined && target !== null && !isValidSessionId(target)) return { ok: false, error: "invalid-input" };
    if (typeof target === "string") {
      const record = routinesStore.list().find((r) => r.id === id);
      if (!record) return { ok: false, error: "routine-not-found" };
      const linkError = chatLinkError(target, record.projectRoot);
      if (linkError) return { ok: false, error: linkError };
    }
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
    if (!routinesStore) return { ok: true, occurrences: [], runs: [], running: [] };
    const projectRoot = projectRootFilter(q);
    const filter = projectRoot === undefined ? undefined : { projectRoot };
    const { routines } = filter ? routinesStore.listForDisplay(filter) : routinesStore.listForDisplay();
    const runs: RoutineRun[] = [];
    // Past runs include dismissed items: a completed one-shot is dismissed by its own fire and must stay on the grid.
    for (const routine of filter ? routinesStore.list(filter) : routinesStore.list()) {
      const inRange = (iso: string | undefined): iso is string => {
        const t = iso ? Date.parse(iso) : Number.NaN;
        return Number.isFinite(t) && t >= from && t < to;
      };
      const statusOf = (firedAt: string): RoutineRun["status"] => (routine.lastFailure?.firedAt === firedAt ? "failed" : "done");
      const seen = new Set<string>();
      const canOpenSession = (sessionId: string): boolean =>
        !(routine.orphanedAt && sessionId === routine.targetSessionId)
        && memoryManager.loadSessionMetadata(sessionId) !== null
        && memoryManager.hasSessionTranscript(sessionId);
      for (const run of routine.runs ?? []) {
        if (!inRange(run.firedAt)) continue;
        const { sessionId, ...stored } = run;
        runs.push({ ...stored, ...(sessionId !== undefined && canOpenSession(sessionId) ? { sessionId } : {}) });
        seen.add(run.firedAt);
      }
      if (routine.execution === "llm-session") {
        for (const session of memoryManager.listSessionsByRoutine(routine.id)) {
          if (!inRange(session.routineFiredAt) || seen.has(session.routineFiredAt)) continue;
          seen.add(session.routineFiredAt);
          runs.push({ routineId: routine.id, firedAt: session.routineFiredAt, status: statusOf(session.routineFiredAt), sessionId: session.id });
        }
      }
      // A failed run may have no session, and a notification item never has one.
      // A connected item's run is a turn in its chat, which 대화 열기 opens.
      if (inRange(routine.lastFiredAt) && !seen.has(routine.lastFiredAt)) {
        const chat = routine.targetSessionId && !routine.orphanedAt && canOpenSession(routine.targetSessionId) ? { sessionId: routine.targetSessionId } : {};
        runs.push({ routineId: routine.id, firedAt: routine.lastFiredAt, status: statusOf(routine.lastFiredAt), ...chat });
      }
    }
    runs.sort((a, b) => a.firedAt.localeCompare(b.firedAt));
    // The runs in progress now, so a view opened mid-run shows them; later changes arrive as running events.
    const running = routinesScheduler?.runningNow() ?? [];
    return { ok: true, occurrences: listRoutineOccurrences(routines, { from, to, now: Date.now() }), runs, running };
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
