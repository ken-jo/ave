/**
 * Window fan-out — `fanOutToAllWindows`: send one channel to every window in a
 * list, and count the deliveries.
 *
 * It composes ON TOP of {@link sendToWindow} from `safe-send.ts` rather than
 * duplicating its destroyed-check + try/catch — `sendToWindow` already owns the
 * per-window "is this WebContents still alive, swallow a send race" contract,
 * so a send that fails on one window returns `false` there and the loop carries
 * on. This module adds only the fan-out concern: iterate, count, and — when the
 * caller passes an `auditLogger` — emit one audit row for the whole fan-out.
 *
 * {@link broadcastToAppWindows} is the domain-level entry: it resolves the app
 * renderer window set (`getAppWindows`, or the main window when a deps object
 * has no window list) and fans out through here, so every domain broadcast
 * shares one target rule and one per-window send contract.
 */
import type { BrowserWindow } from "electron";
import { sendToWindow, type SafeSendLogger } from "./safe-send.js";
import type { IpcDeps } from "./types.js";

/** Minimal audit sink — the subset of `AuditLogger.log` this module needs. */
export interface BroadcastAuditLogger {
  log: (entry: {
    timestamp: string;
    sessionId: string;
    type: "info";
    input: string;
  }) => void;
}

export interface FanOutOptions {
  /** Forwarded to `sendToWindow` for per-window send-race logging. */
  logger?: SafeSendLogger;
  /**
   * When provided, emit a single `info` audit row recording the channel +
   * how many windows received the payload. `sessionId` defaults to `"ipc"`.
   * Audit failures never break the broadcast.
   */
  auditLogger?: BroadcastAuditLogger;
  /** Audit row `sessionId`. Defaults to `"ipc"`. */
  auditSessionId?: string;
}

/**
 * Fan a one-way IPC `payload` out to every window in `windows`.
 *
 * Each send goes through {@link sendToWindow}, which returns `false` for a
 * null / destroyed window or a swallowed send race. Returns the number of
 * windows that actually received the payload.
 */
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
      /* audit must not break IPC fan-out */
    }
  }
  return delivered;
}

/** The app renderer windows a domain broadcast targets. */
function appRendererWindows(
  deps: Pick<IpcDeps, "getAppWindows" | "getMainWindow">,
): Array<BrowserWindow | null | undefined> {
  return deps.getAppWindows?.() ?? [deps.getMainWindow()];
}

/** Fan `payload` out on `channel` to every app renderer window. */
export function broadcastToAppWindows(
  deps: Pick<IpcDeps, "getAppWindows" | "getMainWindow">,
  channel: string,
  payload?: unknown,
  options?: FanOutOptions,
): number {
  return fanOutToAllWindows(appRendererWindows(deps), channel, payload, options);
}
