// Require a session id; goal controls must not resolve an ambiguous default conversation.
import { ipcMain } from "electron";
import { validateHostRendererSender, UNAUTHORIZED_FRAME, auditUnauthorized } from "../gated.js";
import { CHANNELS } from "../../contract/app-contract.js";
import type { IpcDeps } from "../types.js";
import { fanOutToAllWindows } from "../window-fanout.js";
import { isValidSessionId } from "../../memory/memory-manager.js";
import {
  SessionGoalMissingError,
  type SessionGoalStore,
} from "../../main/session-goal-store.js";
import { createLogger } from "../../lib/logger.js";
const log = createLogger("ave");

function namedSession(sessionId: unknown): string | null {
  return isValidSessionId(sessionId) ? sessionId : null;
}

export function registerSessionGoalHandlers(deps: IpcDeps): void {
  const { sessionGoalStore, auditLogger, getMainWindow } = deps;

  ipcMain.handle(CHANNELS.sessionGoal.get, (e, sessionId: unknown) => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, CHANNELS.sessionGoal.get, e);
      return UNAUTHORIZED_FRAME;
    }
    const sid = namedSession(sessionId);
    if (sid === null) {
      log.warn("session-goal get without a session id");
      return null;
    }
    if (!sessionGoalStore) return null;
    return sessionGoalStore.get(sid);
  });

  const mutate = (
    channel: string,
    apply: (store: SessionGoalStore, sessionId: string) => Promise<unknown>,
  ): void => {
    ipcMain.handle(channel, async (e, sessionId: unknown) => {
      if (!validateHostRendererSender(e)) {
        auditUnauthorized(auditLogger, channel, e);
        return UNAUTHORIZED_FRAME;
      }
      const sid = namedSession(sessionId);
      if (sid === null) return { ok: false, error: "session-id-required" };
      if (!sessionGoalStore) return { ok: false, error: "no-session-goal-store" };
      try {
        await apply(sessionGoalStore, sid);
        return { ok: true };
      } catch (err) {
        if (err instanceof SessionGoalMissingError) {
          return { ok: false, error: "no-session-goal" };
        }
        throw err;
      }
    });
  };
  mutate(CHANNELS.sessionGoal.pause, (store, sid) => store.pause(sid));
  mutate(CHANNELS.sessionGoal.resume, (store, sid) => store.resume(sid));
  mutate(CHANNELS.sessionGoal.clear, (store, sid) => store.clear(sid));

  if (sessionGoalStore) {
    sessionGoalStore.onChange((sessionId, goal) => {
      try {
        fanOutToAllWindows(deps.getAppWindows?.() ?? [getMainWindow()], CHANNELS.sessionGoal.changed, { sessionId, goal });
      } catch (err) {
        log.warn("session-goal emit failed: %s", (err as Error).message);
      }
    });
  }
}
