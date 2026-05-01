/**
 * Audit domain IPC handlers.
 * Covers: ave:audit:*, ave:dlp:*
 */
import { ipcMain } from "electron";
import type { IpcDeps } from "../types.js";

export function registerAuditHandlers(deps: IpcDeps): void {
  const { auditLogger } = deps;

  // read-only, sender guard optional
  ipcMain.handle("ave:audit:search", async (_e, filter: Parameters<typeof auditLogger.search>[0]) => {
    return auditLogger.search(filter);
  });

  // read-only, sender guard optional
  ipcMain.handle("ave:audit:stats", async (_e, lastDays: number) => {
    return auditLogger.getStats(typeof lastDays === "number" ? lastDays : 7);
  });

  // TIER 3 read-only, sender guard optional
  ipcMain.handle("ave:dlp:stats", async (_e, days: number) => {
    const { getDlpStats } = await import("../../audit/dlp-stats.js");
    return getDlpStats(typeof days === "number" ? days : 7);
  });
}
