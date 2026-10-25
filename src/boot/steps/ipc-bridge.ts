/** Coalesce transcript events; flush final events immediately and dispose subscriptions with the window. */
import type { BrowserWindow } from "electron";
import type { PluginRuntime } from "../../plugins/runtime.js";
import { onEvent } from "../types.js";
import { classifySubscription } from "../../plugins/capabilities.js";
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

/** Filter private namespaces before registration so neither renderer bridge consumer can receive them. */
function collectPluginEventTypes(pluginRuntime: PluginRuntime): Set<string> {
  const types = new Set<string>();
  const addBridgeable = (candidate: string, pluginId: unknown): void => {
    const type = candidate.trim();
    if (!type) return;
    if (classifySubscription(type) === "private") {
      log.warn(
        `boot: plugin:${String(pluginId)} emittedEvents["${type}"] is private-namespace — bridge skipped`,
      );
      return;
    }
    types.add(type);
  };
  for (const { manifest } of pluginRuntime.listPluginManifests()) {
    const raw = manifest as unknown as Record<string, unknown>;
    if (Array.isArray(raw["emittedEvents"])) {
      for (const t of raw["emittedEvents"] as unknown[]) {
        if (typeof t === "string") addBridgeable(t, raw["id"]);
      }
    }
    // Derive auth events from the literal manifest id; never normalize dashes and underscores.
    const id = manifest.id;
    if (raw["auth"] && typeof id === "string" && id.length > 0) {
      addBridgeable(`${id}.auth.changed`, id);
    }
  }
  return types;
}

/** Returns a disposer and also unsubscribes when the window closes. */
export function registerPluginEventBridge(
  pluginRuntime: PluginRuntime,
  win: BrowserWindow | null,
): () => void {
  if (!win) return () => {};
  const unsubs: Array<() => void> = [];
  const eventTypes = collectPluginEventTypes(pluginRuntime);

  for (const type of eventTypes) {
    const guardedSend = (data: unknown) => {
      if (win.isDestroyed()) return;
      try {
        win.webContents.send(CHANNELS.pluginBridge.event, type, data);
      } catch (e) {
        log.warn(`boot: ${type} send failed: %s`, (e as Error).message);
      }
    };
    const sendFn = isTranscriptEvent(type)
      ? makeCoalescingSend(guardedSend)
      : guardedSend;
    unsubs.push(onEvent(type, sendFn));
  }

  const unsubscribeAll = () => { for (const u of unsubs) u(); };
  win.once("closed", unsubscribeAll);
  return unsubscribeAll;
}
