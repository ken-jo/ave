// Require a session id; task reads and clears must not choose among a window's conversations.
import { ipcMain } from "electron";
import { validateHostRendererSender, UNAUTHORIZED_FRAME, auditUnauthorized } from "../gated.js";
import { CHANNELS } from "../../contract/app-contract.js";
import type { IpcDeps } from "../types.js";
import { fanOutToAllWindows } from "../window-fanout.js";
import { isValidSessionId } from "../../memory/memory-manager.js";
import { createLogger } from "../../lib/logger.js";
const log = createLogger("ave");

// Malformed or absent ids return a refusal rather than addressing an implicit session sidecar.
function namedSession(sessionId: unknown): string | null {
  return isValidSessionId(sessionId) ? sessionId : null;
}

export function registerSessionTasksHandlers(deps: IpcDeps): void {
  const { sessionTasksStore, auditLogger, getMainWindow } = deps;

  ipcMain.handle(CHANNELS.sessionTasks.list, (e, sessionId: unknown) => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, CHANNELS.sessionTasks.list, e);
      return UNAUTHORIZED_FRAME;
    }
    const sid = namedSession(sessionId);
    if (sid === null) {
      log.warn("session-tasks list without a session id");
      return [];
    }
    if (!sessionTasksStore) return [];
    return sessionTasksStore.list(sid);
  });
  ipcMain.handle(CHANNELS.sessionTasks.clear, async (e, sessionId: unknown) => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, CHANNELS.sessionTasks.clear, e);
      return UNAUTHORIZED_FRAME;
    }
    const sid = namedSession(sessionId);
    if (sid === null) {
      log.warn("session-tasks clear without a session id");
      return { ok: false, error: "session-id-required" };
    }
    if (!sessionTasksStore) return { ok: false, error: "no-session-tasks-store" };
    await sessionTasksStore.clear(sid);
    return { ok: true };
  });
  if (sessionTasksStore) {
    sessionTasksStore.onChange((sessionId, items) => {
      try {
        fanOutToAllWindows(deps.getAppWindows?.() ?? [getMainWindow()], CHANNELS.sessionTasks.changed, {
          sessionId,
          items,
        });
      } catch (err) {
        log.warn("session-tasks emit failed: %s", (err as Error).message);
      }
    });
  }
}
