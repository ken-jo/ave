import { logPermissionEvent, permissionLogId } from "../lib/permission-log.js";
import type { MainWindow } from "../main/main-window-host.js";
// Reuse safe-send for destroyed windows and send races so one failed delivery cannot block peers.

import { sendToWindow, type SafeSendLogger } from "./safe-send.js";
import type { IpcDeps } from "./types.js";

export interface FanOutOptions {
  logger?: SafeSendLogger;
  // Optional audit records channel and delivered count; audit failures must not interrupt fan-out.
  auditSessionId?: string;
}

// Return successful delivery count; null, destroyed, and raced windows are skipped.
export function fanOutToAllWindows(
  windows: Array<MainWindow | null | undefined>,
  channel: string,
  payload: unknown,
  options: FanOutOptions = {},
): number {
  let delivered = 0;
  for (const win of windows) {
    if (sendToWindow(win, channel, payload, options.logger)) {
      delivered += 1;
    }
  }
  if (options.auditSessionId) {
    logPermissionEvent("ipc_broadcast", { sessionId: permissionLogId(options.auditSessionId), channel, delivered });
  }
  return delivered;
}

function appRendererWindows(
  deps: Pick<IpcDeps, "getAppWindows" | "getMainWindow">,
): Array<MainWindow | null | undefined> {
  return deps.getAppWindows?.() ?? [deps.getMainWindow()];
}

export function broadcastToAppWindows(
  deps: Pick<IpcDeps, "getAppWindows" | "getMainWindow">,
  channel: string,
  payload?: unknown,
  options?: FanOutOptions,
): number {
  return fanOutToAllWindows(appRendererWindows(deps), channel, payload, options);
}
