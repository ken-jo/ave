import { captureRoutineRun } from "../engine/routine-run-metrics.js";
import type { Routine, RoutineResult } from "../routines/routine-engine.js";
import { createLogger } from "../lib/logger.js";
import { t } from "../i18n/index.js";
import type { FireOptions } from "./notification-service.js";
import type { RoutineRecord, RoutineRunOutcome, RoutineRunMetrics } from "../shared/routines-types.js";
import { errorMessage } from "../shared/error-message.js";

const log = createLogger("ave");

type ShutdownRoutinesStore = {
  listActive: () => RoutineRecord[];
  markFired: (id: string) => Promise<RoutineRecord | null>;
  update: (
    id: string,
    patch: Partial<Pick<RoutineRecord, "lastRoutineSessionId">>,
  ) => Promise<RoutineRecord | null>;
  recordNotificationRunMetrics: (id: string, firedAt: string, metrics: RoutineRunMetrics) => Promise<RoutineRecord | null>;
  recordRunOutcome: (id: string, firedAt: string, outcome: RoutineRunOutcome, metrics?: RoutineRunMetrics, sessionId?: string) => Promise<RoutineRecord | null>;
};

type ShutdownRoutineEngine = {
  runRoutine: (input: Routine) => Promise<RoutineResult>;
};

type ShutdownNotificationService = {
  fire: (opts: FireOptions) => void;
};

export interface ShutdownRoutineServices {
  routinesStore?: ShutdownRoutinesStore;
  routineEngine?: ShutdownRoutineEngine;
  notificationService?: ShutdownNotificationService;
}

export async function runShutdownRoutines(
  svc: ShutdownRoutineServices,
  timeoutMs = 5000,
): Promise<void> {
  if (!svc.routinesStore || !svc.routineEngine) return;

  const routineEngine = svc.routineEngine;
  try {
    const shutdownRoutines = svc.routinesStore.listActive().filter(
      (routine) => routine.trigger === "shutdown" && !routine.pausedAt,
    );
    for (const routine of shutdownRoutines) {
      let routineSessionId: string | undefined;
      let outcome: RoutineRunOutcome = { ok: true };
      const captured = captureRoutineRun(async () => {
        if (routine.execution === "llm-session") {
          const run = await runLlmShutdownRoutine(routineEngine, routine, timeoutMs);
          if (run.timedOut) outcome = { ok: false, kind: "shutdown-timeout" };
          else routineSessionId = run.sessionId;
        } else {
          svc.notificationService?.fire({
            kind: "routine",
            title: routine.notificationTitle ?? routine.title ?? t("be_shutdownRoutines.shutdownRoutineNotificationTitle"),
            body: routine.notificationBody ?? "",
            contextRef: { routineId: routine.id },
          });
        }
      });
      try {
        await captured.result;
      } catch (err) {
        log.warn("before-quit: shutdown routine failed (id=%s): %s", routine.id, errorMessage(err));
        outcome = { ok: false, kind: "error", reason: errorMessage(err) };
      }

      let fired: RoutineRecord | null = null;
      try {
        fired = await svc.routinesStore.markFired(routine.id);
        if (fired && routineSessionId) {
          const updated = await svc.routinesStore.update(routine.id, { lastRoutineSessionId: routineSessionId });
          if (!updated) {
            log.warn("before-quit: shutdown routine session id persist failed (id=%s)", routine.id);
          }
        }
      } catch (markErr) {
        log.warn(
          "before-quit: markFired failed (id=%s): %s — routine may re-fire on next launch",
          routine.id,
          errorMessage(markErr),
        );
      }
      // Persist the outcome so the next launch shows a failed shutdown run instead of losing it to the log.
      if (fired?.lastFiredAt) {
        try {
          if (routine.execution === "llm-session") {
            await svc.routinesStore.recordRunOutcome(routine.id, fired.lastFiredAt, outcome, captured.metrics(), routineSessionId ?? captured.sessionId());
          } else {
            await svc.routinesStore.recordNotificationRunMetrics(routine.id, fired.lastFiredAt, captured.metrics());
          }
        } catch (outcomeErr) {
          log.warn("before-quit: shutdown routine outcome persist failed (id=%s): %s", routine.id, errorMessage(outcomeErr));
        }
      }
    }
  } catch (err) {
    log.warn("before-quit: shutdown routines setup failed: %s", errorMessage(err));
  }
}

async function runLlmShutdownRoutine(
  routineEngine: ShutdownRoutineEngine,
  routine: RoutineRecord,
  timeoutMs: number,
): Promise<{ timedOut: true } | { timedOut: false; sessionId: string | undefined }> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort("shutdown timeout"), timeoutMs);
  try {
    const runResult = await routineEngine.runRoutine({
      id: routine.id,
      trigger: routine.trigger,
      prePrompt: routine.prePrompt ?? "",
      title: routine.title,
      scope: routine.scope,
      signal: controller.signal,
    });
    return { timedOut: false, sessionId: runResult.sessionId };
  } catch (abortErr) {
    if (controller.signal.aborted) {
      log.warn("before-quit: shutdown routine aborted (5s timeout, id=%s)", routine.id);
      return { timedOut: true };
    }
    throw abortErr;
  } finally {
    clearTimeout(timeoutId);
  }
}
