/** Prepare scheduling now, but start only after IPC listeners attach so overdue routines are not lost. */
import { ROUTINES } from "../../shared/ipc-channels.js";
import { t } from "../../i18n/index.js";
import { createLogger } from "../../lib/logger.js";
import type { BootContext } from "../context.js";
import { stageInSuggestionsSession } from "../../main/suggestions-session.js";
import { fanOutToAllWindows } from "../../ipc/window-fanout.js";

const log = createLogger("ave");

export function wireRoutinesScheduler(ctx: BootContext): void {
  const { routinesScheduler, routineEngine, routinesStore, getMainWindow, notificationService, memoryManager } = ctx;
  // Routine state is app-wide: every open main window shows it.
  const appWindows = () => ctx.host.desktop?.getAppWindows() ?? [getMainWindow()];
  // Create and promote the Suggestions conversation in the same tick as each card send.
  const announce = (channel: string, payload: unknown): void => {
    stageInSuggestionsSession(memoryManager);
    fanOutToAllWindows(appWindows(), channel, payload);
  };

  routinesScheduler.onLlmSession(({ routine }) => {
    // Routine loops are isolated but persist through the normal session repository.
    void (async () => {
      const firedAt = routine.lastFiredAt ?? new Date().toISOString();
      const title = routine.title ?? routine.notificationTitle ?? routine.id.slice(0, 8);

      // Emit running state immediately; completed events add the routine session id.
      try {
        announce(ROUTINES.runningStarted, {
          routineId: routine.id,
          firedAt,
          title,
        });
      } catch {
        // non-fatal
      }

      let runSummary = "";
      let routineSessionId: string | undefined;
      try {
        const runResult = await routineEngine.runRoutine({
          id: routine.id,
          trigger: routine.trigger,
          prePrompt: routine.prePrompt ?? "",
          title: routine.title,
          scope: routine.scope,
          firedAt,
        });
        runSummary = runResult.summary;
        routineSessionId = runResult.sessionId;
        if (routineSessionId) {
          const updated = await routinesStore.update(routine.id, { lastRoutineSessionId: routineSessionId });
          if (!updated) {
            log.warn("routines llm-session session id persist failed: routine not found (%s)", routine.id);
          }
        }
      } catch (err) {
        log.warn("routines llm-session run failed: %s", (err as Error).message);
        try {
          announce(ROUTINES.failed, {
            routineId: routine.id,
            error: (err as Error).message,
          });
        } catch {
          // non-fatal
        }
      } finally {
      // Clear running state on both success and failure.
        try {
          fanOutToAllWindows(appWindows(), ROUTINES.runningFinished, routine.id);
        } catch {
          // non-fatal
        }
      }
      const summary = runSummary;
      // Allow-list event fields; spreading the routine could expose private content.
      try {
        announce(ROUTINES.fired, {
          id: routine.id,
          trigger: routine.trigger,
          execution: routine.execution,
          firedAt,
          title,
          summary,
          ...(routineSessionId ? { routineSessionId } : {}),
        } satisfies import("../../shared/routines-types.js").RoutineFiredPayload);
      } catch (err) {
        log.warn("routines llm-session emit failed: %s", (err as Error).message);
      }
    })();
  });
  routinesScheduler.onNotification(({ routine }) => {
    try {
      notificationService.fire({
        kind: "routine",
        title: routine.notificationTitle ?? routine.title ?? t("be_boot.routineNotificationFallbackTitle"),
        body: routine.notificationBody ?? "",
        contextRef: { routineId: routine.id },
      });
    } catch (err) {
      log.warn("routines notification emit failed: %s", (err as Error).message);
    }
    // Allow-list fields so prompts and notification bodies cannot leak into events.
    try {
      const firedAt = routine.lastFiredAt ?? new Date().toISOString();
      const title = routine.title ?? routine.notificationTitle ?? routine.id.slice(0, 8);
      announce(ROUTINES.fired, {
        id: routine.id,
        trigger: routine.trigger,
        execution: routine.execution,
        firedAt,
        title,
        summary: "",
      } satisfies import("../../shared/routines-types.js").RoutineFiredPayload);
    } catch (err) {
      log.warn("routines notification fired emit failed: %s", (err as Error).message);
    }
  });
}
