import { ipcRenderer } from 'electron';
import { CHANNELS } from '../contract/app-contract.js';
import type { MemoryMapApi } from '../shared/memory-map.js';
import { MemoryMapProgressSchema, MemoryModelStatusSchema } from '../shared/memory-map-validation.js';
import type { z } from 'zod';
function subscribe<T>(channel: string, schema: z.ZodType<T>, callback: (value: T) => void): () => void {
  const listener = (_event: unknown, value: unknown) => { const parsed = schema.safeParse(value); if (parsed.success) callback(parsed.data); };
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}
export const memoryMapApiSurface: MemoryMapApi = {
  get: scope => ipcRenderer.invoke(CHANNELS.memoryMap.get, scope),
  build: scope => ipcRenderer.invoke(CHANNELS.memoryMap.build, scope),
  cancel: () => ipcRenderer.invoke(CHANNELS.memoryMap.cancel),
  facets: scope => ipcRenderer.invoke(CHANNELS.memoryMap.facets, scope),
  retrieve: request => ipcRenderer.invoke(CHANNELS.memoryMap.retrieve, request),
  modelStatus: () => ipcRenderer.invoke(CHANNELS.memoryMap.modelStatus),
  modelDownload: () => ipcRenderer.invoke(CHANNELS.memoryMap.modelDownload),
  modelCancel: () => ipcRenderer.invoke(CHANNELS.memoryMap.modelCancel),
  modelUseExisting: () => ipcRenderer.invoke(CHANNELS.memoryMap.modelUseExisting),
  settingsGet: () => ipcRenderer.invoke(CHANNELS.memoryMap.settingsGet),
  settingsSet: settings => ipcRenderer.invoke(CHANNELS.memoryMap.settingsSet, settings),
  onProgress: callback => subscribe(CHANNELS.memoryMap.progress, MemoryMapProgressSchema, callback),
  onModelProgress: callback => subscribe(CHANNELS.memoryMap.modelProgress, MemoryModelStatusSchema, callback),
};
