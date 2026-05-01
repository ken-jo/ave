/**
 * Misc domain IPC handlers — tasks, reminders, session-todo.
 */
import { ipcMain } from "electron";
import { validateSender, UNAUTHORIZED_FRAME, auditUnauthorized } from "../gated.js";
import type { IpcDeps } from "../types.js";

export function registerMiscHandlers(deps: IpcDeps): void {
  const { taskService, remindersStore, sessionTodoStore, conversationLoop, auditLogger, getMainWindow } = deps;

  // ─── Tasks ──────────────────────────────────────
  ipcMain.handle("ave:tasks:add", (e, task) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "ave:tasks:add", e); return UNAUTHORIZED_FRAME; }
    return taskService.add(task);
  });
  ipcMain.handle("ave:tasks:update", (e, id: string, patch) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "ave:tasks:update", e); return UNAUTHORIZED_FRAME; }
    return taskService.update(id, patch);
  });
  // read-only, sender guard optional
  ipcMain.handle("ave:tasks:get", (_e, id: string) => taskService.get(id));
  ipcMain.handle("ave:tasks:delete", (e, id: string) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "ave:tasks:delete", e); return UNAUTHORIZED_FRAME; }
    return taskService.delete(id);
  });
  // read-only, sender guard optional
  ipcMain.handle("ave:tasks:query", (_e, filter) => taskService.query(filter));
  // read-only, sender guard optional
  ipcMain.handle("ave:tasks:pending", () => taskService.getPendingByPriority());
  // read-only, sender guard optional
  ipcMain.handle("ave:tasks:overdue", () => taskService.getOverdue());
  // read-only, sender guard optional
  ipcMain.handle("ave:tasks:today", () => taskService.getDueToday());

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
        console.warn("[ave] session-todo emit failed:", (err as Error).message);
      }
    });
  }
}
