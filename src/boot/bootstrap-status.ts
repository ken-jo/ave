/** Bootstrap failures are non-fatal; publish status and retain an in-memory snapshot for late renderers. */

import type { BrowserWindow } from "electron";
import { CHANNELS } from "../contract/app-contract.js";
import type { AppBootstrapStatus } from "../shared/bootstrap-status.js";

let recordedStatus: AppBootstrapStatus | null = null;

/** Serves the latest process-local status to renderers that mount after boot. */
export function latestBootstrapStatus(): AppBootstrapStatus | null {
  return recordedStatus;
}

/** Record even when the window is unavailable; sending is best-effort. */
export function notifyBootstrapStatus(
  mainWindow: BrowserWindow | null | undefined,
  status: AppBootstrapStatus,
): void {
  // Record before checking the window because cold boot has no listener.
  recordedStatus = status;
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    mainWindow.webContents.send(CHANNELS.bootstrap.status, status);
  } catch {
    // Best-effort: a destroyed/loading webContents shouldn't take down boot.
  }
}
