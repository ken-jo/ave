import assert from 'node:assert/strict';
import { describe, it, expect, vi } from 'vitest';
const state = vi.hoisted(() => ({ invoke: vi.fn(async () => ({ ok: true, value: null })), listeners: new Map<string, (...args: unknown[]) => void>(), remove: vi.fn() }));
vi.mock('electron', () => ({ ipcRenderer: { invoke: state.invoke, on: (channel: string, listener: (...args: unknown[]) => void) => state.listeners.set(channel, listener), removeListener: state.remove } }));
import { memoryMapApiSurface as api } from '../memory-map-api-surface.js';
import { CHANNELS } from '../../contract/app-contract.js';
describe('memory map preload bridge', () => {
  it('forwards typed operations without accepting a model folder from the renderer', async () => {
    await api.build({ projectRoot: '/example' }); expect(state.invoke).toHaveBeenLastCalledWith(CHANNELS.memoryMap.build, { projectRoot: '/example' });
    await api.modelUseExisting(); expect(state.invoke).toHaveBeenLastCalledWith(CHANNELS.memoryMap.modelUseExisting);
    await api.modelDownload(); expect(state.invoke).toHaveBeenLastCalledWith(CHANNELS.memoryMap.modelDownload);
    await api.settingsSet({ source: 'local' }); expect(state.invoke).toHaveBeenLastCalledWith(CHANNELS.memoryMap.settingsSet, { source: 'local' });
  });
  it('passes only bounded text-free progress events and unsubscribes the exact listener', () => {
    const callback = vi.fn(); const unsubscribe = api.onProgress(callback);
    const listener = state.listeners.get(CHANNELS.memoryMap.progress);
    assert.ok(listener);
    const progress = { jobId: 'job', phase: 'embedding', completed: 1, total: 2, memoryId: 'id' };
    listener({}, progress); listener({}, { ...progress, text: 'private' }); listener({}, { ...progress, completed: -1 });
    expect(callback).toHaveBeenCalledExactlyOnceWith(progress); unsubscribe(); expect(state.remove).toHaveBeenCalledWith(CHANNELS.memoryMap.progress, listener);
  });
});
