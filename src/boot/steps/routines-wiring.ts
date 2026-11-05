/** Prepare scheduling now, but start only after IPC listeners attach so overdue routines are not lost. */
import { ROUTINES } from "../../shared/ipc-channels.js";
import { t } from "../../i18n/index.js";
import { createLogger } from "../../lib/logger.js";
import type { BootContext } from "../context.js";
import { stageInSuggestionsSession } from "../../main/suggestions-session.js";
import { fanOutToAllWindows } from "../../ipc/window-fanout.js";
import { sanitizeRoutineFailureReason } from "../../main/routines-store.js";
import type { RoutineRecord, RoutineRunOutcome } from "../../shared/routines-types.js";
import { wakeRoutineChat } from "../../main/app-state.js";
import { turnExtensionPolicyContext, withholdSessionAuthorityFor } from "../../shared/turn-extension-policy.js";

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

  // The failure card is also a persisted record, so it survives a restart; a persist error is logged, never turned into a fake success.
  const persistRunOutcome = async (
    routineId: string,
    firedAt: string,
    outcome: RoutineRunOutcome,
  ): Promise<void> => {
    try {
      const updated = await routinesStore.recordRunOutcome(routineId, firedAt, outcome);
      if (!updated) log.warn("routines llm-session outcome persist failed: routine not found (%s)", routineId);
    } catch (err) {
      log.warn("routines llm-session outcome persist failed (%s): %s", routineId, (err as Error).message);
    }
  };

  type RunResult = { summary: string; sessionId?: string; skipped?: "chat-busy" };
  // A connected schedule enters its chat: the open tile's normal turn path when one holds it, otherwise a headless routine loop that loads
  // the chat under the unattended routine policy. Either way the turn does not inherit what the chat's earlier turns were allowed for
  // this session (permission tree, "Delegated work"); the host sets that here, never from model or tool input.
  // The chat's session is also withheld by id for as long as the wake runs, for lookups outside the turn's async context; every
  // exit (done, thrown, aborted, skipped) releases it.
  const runConnected = async (routine: RoutineRecord, targetSessionId: string, firedAt: string, title: string): Promise<RunResult> => {
    const release = withholdSessionAuthorityFor(targetSessionId);
    try {
      return await wakeConnected(routine, targetSessionId, firedAt, title);
    } finally {
      release();
    }
  };
  const wakeConnected = (routine: RoutineRecord, targetSessionId: string, firedAt: string, title: string): Promise<RunResult> => {
    const inherited = turnExtensionPolicyContext.getStore();
    return turnExtensionPolicyContext.run(Object.freeze({
      ...inherited,
      allowExternalHooks: inherited?.allowExternalHooks ?? true,
      remoteControllerAuthority: undefined,
      withholdSessionAuthority: true,
    }), async (): Promise<RunResult> => {
      const prompt = routine.prePrompt ?? "";
      const displayText = t("be_boot.routineWakeNote", { title, prompt });
      const live = await wakeRoutineChat(targetSessionId, { input: prompt, displayText });
      if (live.status === "ran") return { summary: "", sessionId: targetSessionId };
      if (live.status === "busy") return { summary: "", skipped: "chat-busy" };
      return routineEngine.runRoutine({
        id: routine.id,
        trigger: routine.trigger,
        prePrompt: prompt,
        title: routine.title,
        scope: routine.scope,
        firedAt,
        targetSessionId,
        displayText,
      });
    });
  };

  routinesScheduler.onLlmSession(({ routine }) => {
    // Routine loops are isolated but persist through the normal session repository.
    void (async () => {
      const firedAt = routine.lastFiredAt ?? new Date().toISOString();
      const title = routine.title ?? routine.notificationTitle ?? routine.id.slice(0, 8);
      const target = routine.targetSessionId;
      // The chat was deleted without the delete reaching this item: it becomes 대화 없음 and runs nowhere else.
      if (target !== undefined && !memoryManager.loadSessionMetadata(target)) {
        try {
          await routinesStore.markOrphaned(target);
        } catch (err) {
          log.warn("routines connected chat orphan persist failed (%s): %s", routine.id, (err as Error).message);
        }
        return;
      }

      // Emit running state immediately; completed events add the routine session id.
      routinesScheduler.markRunning(routine.id, firedAt);
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
      let runError: Error | undefined;
      let skipped = false;
      try {
        const runResult: RunResult = target !== undefined
          ? await runConnected(routine, target, firedAt, title)
          : await routineEngine.runRoutine({
            id: routine.id,
            trigger: routine.trigger,
            prePrompt: routine.prePrompt ?? "",
            title: routine.title,
            scope: routine.scope,
            firedAt,
          });
        skipped = runResult.skipped !== undefined;
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
        runError = err as Error;
        try {
          announce(ROUTINES.failed, {
            routineId: routine.id,
            // The same masked, home-redacted text the store keeps; raw provider errors can carry secrets or paths.
            error: sanitizeRoutineFailureReason((err as Error).message),
          });
        } catch {
          // non-fatal
        }
      } finally {
      // Clear running state on both success and failure.
        routinesScheduler.markStopped(routine.id);
        try {
          fanOutToAllWindows(appWindows(), ROUTINES.runningFinished, routine.id);
        } catch {
          // non-fatal
        }
      }
      // A busy chat took no turn: the fire is recorded as skipped, with no result card and no failure.
      if (skipped) {
        try {
          await routinesStore.markChatBusy(routine.id, firedAt);
        } catch (err) {
          log.warn("routines chat-busy skip persist failed (%s): %s", routine.id, (err as Error).message);
        }
        return;
      }
      await persistRunOutcome(routine.id, firedAt, runError ? { ok: false, kind: "error", reason: runError.message } : { ok: true });
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
