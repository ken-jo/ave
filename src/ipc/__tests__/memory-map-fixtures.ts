import assert from "node:assert/strict";
import type { IpcMainInvokeEvent } from "electron";
import { CHANNELS } from "../../contract/app-contract.js";
import type { MemoryMapApi } from "../../shared/memory-map.js";

type IpcHandler = (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>;

export function createMemoryMapInvoker(handles: ReadonlyMap<string, IpcHandler>, hostEvent: IpcMainInvokeEvent) {
  function invoke(key: keyof typeof CHANNELS.memoryMap, raw?: unknown, event = hostEvent) {
    const handler = handles.get(CHANNELS.memoryMap[key]);
    assert.ok(handler);
    return handler(event, ...(raw === undefined ? [] : [raw]));
  }

  async function providerEndpointId() {
    const result = (await invoke("settingsGet")) as Awaited<ReturnType<MemoryMapApi["settingsGet"]>>;
    const endpointId = result.ok && result.value.providers.find((entry) => entry.id === "openai")?.route?.endpointId;
    if (!endpointId) throw new Error("Missing provider route");
    return endpointId;
  }

  return { invoke, providerEndpointId };
}
