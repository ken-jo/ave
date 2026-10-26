// Reuse safe-send for destroyed windows and send races so one failed delivery cannot block peers.
import type { BrowserWindow } from "electron";
import { sendToWindow, type SafeSendLogger } from "./safe-send.js";
import type { IpcDeps } from "./types.js";

interface BroadcastAuditLogger {
  log: (entry: {
    timestamp: string;
    sessionId: string;
    type: "info";
    input: string;
  }) => void;
}

export interface FanOutOptions {
  logger?: SafeSendLogger;
  // Optional audit records channel and delivered count; audit failures must not interrupt fan-out.
  auditLogger?: BroadcastAuditLogger;
  auditSessionId?: string;
}

// Return successful delivery count; null, destroyed, and raced windows are skipped.
export function fanOutToAllWindows(
  windows: Array<BrowserWindow | null | undefined>,
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
  if (options.auditLogger) {
    try {
      options.auditLogger.log({
        timestamp: new Date().toISOString(),
        sessionId: options.auditSessionId ?? "ipc",
        type: "info",
        input: `[broadcast] channel=${channel} delivered=${delivered}/${windows.length}`,
      });
    } catch {
    }
  }
  return delivered;
}

function appRendererWindows(
  deps: Pick<IpcDeps, "getAppWindows" | "getMainWindow">,
): Array<BrowserWindow | null | undefined> {
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
