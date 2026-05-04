/**
 * Misc domain IPC handlers — tasks, reminders, session-todo.
 */
import { ipcMain } from "electron";
import { validateSender, UNAUTHORIZED_FRAME, auditUnauthorized } from "../gated.js";
import type { IpcDeps } from "../types.js";
import { createLogger } from "../../lib/logger.js";
const log = createLogger("ave");

export function registerMiscHandlers(deps: IpcDeps): void {
  const { remindersStore, sessionTodoStore, conversationLoop, auditLogger, getMainWindow } = deps;

  // ─── Reminders ──────────────────────────────────
  ipcMain.handle("ave:reminders:list", (e) => {
    if (!validateSender(e)) {
      auditUnauthorized(auditLogger, "ave:reminders:list", e);
      return UNAUTHORIZED_FRAME;
    }
    if (!remindersStore) return [];
    return remindersStore.listActive();
  });
  ipcMain.handle("ave:reminders:dismiss", async (e, id: string) => {
    if (!validateSender(e)) {
      auditUnauthorized(auditLogger, "ave:reminders:dismiss", e);
      return UNAUTHORIZED_FRAME;
    }
    if (!remindersStore) return { ok: false, error: "no-store" };
    const ok = await remindersStore.dismiss(id);
    return { ok };
  });
  ipcMain.handle("ave:reminders:remove", async (e, id: string) => {
    if (!validateSender(e)) {
      auditUnauthorized(auditLogger, "ave:reminders:remove", e);
      return UNAUTHORIZED_FRAME;
    }
    if (!remindersStore) return { ok: false, error: "no-store" };
    const ok = await remindersStore.remove(id);
    return { ok };
  });

  // ─── Session Todo ────────────────────────────────
  ipcMain.handle("ave:session-todo:list", (e, sessionId?: string) => {
    if (!validateSender(e)) {
      auditUnauthorized(auditLogger, "ave:session-todo:list", e);
      return UNAUTHORIZED_FRAME;
    }
    if (!sessionTodoStore) return [];
    const sid = sessionId ?? conversationLoop.getSessionId();
    return sessionTodoStore.list(sid);
  });
  if (sessionTodoStore) {
    sessionTodoStore.onChange((sessionId, items) => {
      try {
        getMainWindow()?.webContents.send("ave:session-todo:changed", {
          sessionId,
          items,
        });
      } catch (err) {
        log.warn("session-todo emit failed: %s", (err as Error).message);
      }
    });
  }
}
