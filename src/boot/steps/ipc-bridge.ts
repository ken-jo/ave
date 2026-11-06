/** Coalesce transcript events; flush final events immediately and dispose subscriptions with the window. */
import type { BrowserWindow } from "electron";
import type { PluginRuntime } from "../../plugins/runtime.js";
import { subscribeOwnPluginUiEvents } from "../../plugins/ui-events.js";
import { createLogger } from "../../lib/logger.js";
import { CHANNELS } from "../../contract/app-contract.js";
const log = createLogger("ave");

export function isTranscriptEvent(type: string): boolean {
  return type.endsWith(".transcript.updated");
}

/** The delivery callback owns window-liveness checks. */
export function makeCoalescingSend(
  sendFn: (data: unknown) => void,
): (data: unknown) => void {
  let lastData: unknown = undefined;
  let flushTimer: ReturnType<typeof setTimeout> | undefined;

  const flush = (data: unknown) => {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = undefined; }
    sendFn(data);
  };

  return (data: unknown) => {
    const payload = data as Record<string, unknown> | undefined;
    const isFinal = payload?.isFinal === true;
    if (isFinal) {
      flush(data);
      lastData = undefined;
    } else {
      lastData = data;
      if (!flushTimer) {
        flushTimer = setTimeout(() => {
          flushTimer = undefined;
          if (lastData !== undefined) flush(lastData);
        }, 100);
      }
    }
  };
}

/** Returns a disposer and also unsubscribes when the window closes. */
export function registerPluginEventBridge(
  pluginRuntime: PluginRuntime,
  win: BrowserWindow | null,
): () => void {
  if (!win) return () => {};
  const unsubs: Array<() => void> = [];
  for (const { pluginId } of pluginRuntime.listPluginManifests()) {
    const transcriptSenders = new Map<string, (data: unknown) => void>();
    const send = (type: string, data: unknown) => {
      if (win.isDestroyed()) return;
      try {
        win.webContents.send(CHANNELS.pluginBridge.event, type, data);
      } catch (error) {
        log.warn({ pluginId, error }, "plugin UI event delivery failed");
      }
    };
    unsubs.push(subscribeOwnPluginUiEvents(pluginId, (type, data) => {
      if (!isTranscriptEvent(type)) { send(type, data); return; }
      let sender = transcriptSenders.get(type);
      if (!sender) {
        sender = makeCoalescingSend((payload) => send(type, payload));
        transcriptSenders.set(type, sender);
      }
      sender(data);
    }));
  }

  const unsubscribeAll = () => { for (const u of unsubs) u(); };
  win.once("closed", unsubscribeAll);
  return unsubscribeAll;
}
