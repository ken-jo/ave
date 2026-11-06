/** Plugin notifications have one recipient: UI owned by the emitting plugin. */
import { EventEmitter } from "node:events";
import { canEmitEvent } from "./capabilities.js";

const events = new EventEmitter();
events.setMaxListeners(0);

export interface PluginUiEvent {
  pluginId: string;
  type: string;
  data: unknown;
}

export function emitPluginUiEvent(pluginId: string, type: string, data?: unknown): void {
  if (!canEmitEvent(type, pluginId)) {
    throw new Error(`Plugin '${pluginId}' may emit only its own UI events`);
  }
  events.emit("event", { pluginId, type, data } satisfies PluginUiEvent);
}

/** Host bridges observe routing metadata; plugins never subscribe to this bus. */
export function subscribePluginUiEvents(handler: (event: PluginUiEvent) => void): () => void {
  events.on("event", handler);
  return () => { events.off("event", handler); };
}

export function subscribeOwnPluginUiEvents(pluginId: string, handler: (type: string, data: unknown) => void): () => void {
  return subscribePluginUiEvents((event) => {
    if (event.pluginId === pluginId) handler(event.type, event.data);
  });
}
