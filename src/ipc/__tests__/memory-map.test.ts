import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IpcMainInvokeEvent } from 'electron';
import type { IpcDeps } from '../types.js';
import { CHANNELS } from '../../contract/app-contract.js';
const state = vi.hoisted(() => ({
  handles: new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>>(),
  get: vi.fn(async () => null), build: vi.fn(async () => ({ snapshotId: 'snapshot' })), cancel: vi.fn(), retrieve: vi.fn(async () => ({ queryId: 'query' })),
  status: vi.fn(async () => ({ status: 'unconfigured' })), download: vi.fn(async () => ({ status: 'ready' })), modelCancel: vi.fn(), useExisting: vi.fn(async () => ({ status: 'ready' })),
  dialog: vi.fn(async () => ({ canceled: true, filePaths: [] as string[] })), audit: vi.fn(),
}));
vi.mock('electron', () => ({ ipcMain: { handle: (channel: string, handler: never) => state.handles.set(channel, handler) }, dialog: { showOpenDialog: state.dialog } }));
vi.mock('../../main/memory-map/host.js', async importOriginal => ({ ...await importOriginal<typeof import('../../main/memory-map/host.js')>(), MemoryMapHost: class { get = state.get; build = state.build; cancel = state.cancel; retrieve = state.retrieve; } }));
vi.mock('../../main/memory-map/model-manager.js', async importOriginal => ({ ...await importOriginal<typeof import('../../main/memory-map/model-manager.js')>(), LocalModelManager: class { status = state.status; download = state.download; cancel = state.modelCancel; useExisting = state.useExisting; } }));
vi.mock('../../main/memory-map/catalog.js', () => ({ readGraphCatalog: () => ({ records: [], excluded: 0, authorizationScopeId: 'scope' }), memoryFacets: () => ({ sources: [], projects: [], playbooks: [] }) }));
import { registerMemoryMapHandlers } from '../domains/memory-map.js';
const hostEvent = { senderFrame: { url: 'file:///app/index.html' }, sender: { send: vi.fn(), isDestroyed: () => false } } as unknown as IpcMainInvokeEvent;
const invoke = (key: keyof typeof CHANNELS.memoryMap, raw?: unknown, event = hostEvent) => state.handles.get(CHANNELS.memoryMap[key])!(event, ...(raw === undefined ? [] : [raw]));
beforeEach(() => {
  vi.clearAllMocks(); state.handles.clear();
  registerMemoryMapHandlers({ auditLogger: { log: state.audit }, settingsService: { get: () => undefined, set: vi.fn() } } as unknown as IpcDeps,
    raw => (raw as { projectRoot?: string } | undefined)?.projectRoot === '/denied' ? { ok: false, error: 'project-not-allowed' } : { ok: true, options: {} });
});
describe('memory map host boundary', () => {
  it.each(Object.keys(CHANNELS.memoryMap).filter(key => !['progress','modelProgress'].includes(key)) as (keyof typeof CHANNELS.memoryMap)[])('rejects an untrusted frame before parsing %s', async key => {
    const event = { ...hostEvent, senderFrame: { url: 'ave-mcp-app://isolated/index.html' } } as unknown as IpcMainInvokeEvent;
    expect(await invoke(key, {}, event)).toEqual({ ok: false, error: 'unauthorized-frame' });
    expect(state.audit).toHaveBeenCalledOnce(); expect(state.download).not.toHaveBeenCalled(); expect(state.build).not.toHaveBeenCalled();
  });
  it('validates strict payloads and rejects unauthorized projects before catalog access', async () => {
    expect(await invoke('build', { projectRoot: '/denied' })).toEqual({ ok: false, error: 'project-not-allowed' });
    expect(await invoke('build', { arbitraryPath: '/example' })).toEqual({ ok: false, error: 'invalid-input' });
    expect(await invoke('get', null)).toEqual({ ok: false, error: 'invalid-input' });
    expect(await invoke('modelDownload', {})).toEqual({ ok: false, error: 'invalid-input' });
    expect(await invoke('retrieve', { question: '', filters: {}, snapshotId: 's', queryId: 'q' })).toEqual({ ok: false, error: 'invalid-input' });
    expect(await invoke('retrieve', { question: 'q', filters: { sources: ['other'] }, snapshotId: 's', queryId: 'q' })).toEqual({ ok: false, error: 'invalid-input' });
    expect(state.build).not.toHaveBeenCalled(); expect(state.download).not.toHaveBeenCalled();
  });
  it('allows validated host operations and keeps provider sends unavailable', async () => {
    expect(await invoke('build', {})).toEqual({ ok: true, value: { snapshotId: 'snapshot' } });
    expect(await invoke('retrieve', { question: 'Question', filters: {}, snapshotId: 's', queryId: 'q' })).toMatchObject({ ok: true });
    expect(await invoke('settingsGet')).toMatchObject({ ok: true, value: { source: 'local', providerAvailable: false, namespace: { source: 'local', dimensions: 384 } } });
    expect(await invoke('settingsSet', { source: 'provider' })).toEqual({ ok: false, error: 'provider-unavailable' });
    expect(await invoke('modelUseExisting')).toEqual({ ok: true, value: null });
    expect(state.useExisting).not.toHaveBeenCalled();
    state.dialog.mockResolvedValueOnce({ canceled: false, filePaths: ['/example/model'] });
    expect(await invoke('modelUseExisting')).toMatchObject({ ok: true }); expect(state.useExisting).toHaveBeenCalledWith('/example/model');
  });
});
