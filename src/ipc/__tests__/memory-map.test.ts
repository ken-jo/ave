import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { IpcMainInvokeEvent } from 'electron';
import type { IpcDeps } from '../types.js';
import type { MemoryMapApi } from '../../shared/memory-map.js';
import type { MemoryEmbeddingConfig } from '../../shared/memory-embedding-config.js';
import { CHANNELS } from '../../contract/app-contract.js';
import { graphMemoryRevision, type ReadMemoryMapCatalog } from '../../main/memory-map/catalog.js';
const state = vi.hoisted(() => ({
  handles: new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>>(),
  get: vi.fn(async (_readCatalog: ReadMemoryMapCatalog) => null), build: vi.fn(async () => ({ snapshotId: 'snapshot' })), cancel: vi.fn(), invalidate: vi.fn(), retrieve: vi.fn(async () => ({ queryId: 'query' })),
  status: vi.fn(async () => ({ status: 'unconfigured' })), download: vi.fn(async () => ({ status: 'ready' })), modelCancel: vi.fn(), useExisting: vi.fn(async () => ({ status: 'ready' })),
  dialog: vi.fn(async () => ({ canceled: true, filePaths: [] as string[] })), audit: vi.fn(), localConfined: true,
}));
vi.mock('electron', () => ({ ipcMain: { handle: (channel: string, handler: never) => state.handles.set(channel, handler) }, dialog: { showOpenDialog: state.dialog } }));
vi.mock('../../main/memory-map/host.js', async importOriginal => ({ ...await importOriginal<typeof import('../../main/memory-map/host.js')>(), MemoryMapHost: class { get = state.get; build = state.build; cancel = state.cancel; invalidate = state.invalidate; retrieve = state.retrieve; } }));
vi.mock('../../main/memory-map/model-manager.js', async importOriginal => ({ ...await importOriginal<typeof import('../../main/memory-map/model-manager.js')>(), LocalModelManager: class { status = state.status; download = state.download; cancel = state.modelCancel; useExisting = state.useExisting; } }));
vi.mock('../../main/memory-map/local-runtime.js', async () => {
  const { MemoryMapHostError } = await import('../../main/memory-map/errors.js');
  return { assertLocalEmbeddingRuntime: () => { if (!state.localConfined) throw new MemoryMapHostError('local-runtime-unavailable'); } };
});
import { registerMemoryMapHandlers } from '../domains/memory-map.js';
const hostEvent = { senderFrame: { url: 'file:///app/index.html' }, sender: { send: vi.fn(), isDestroyed: () => false } } as unknown as IpcMainInvokeEvent;
const invoke = (key: keyof typeof CHANNELS.memoryMap, raw?: unknown, event = hostEvent) => state.handles.get(CHANNELS.memoryMap[key])!(event, ...(raw === undefined ? [] : [raw]));
async function providerEndpointId() {
  const result = await invoke('settingsGet') as Awaited<ReturnType<MemoryMapApi['settingsGet']>>;
  const endpointId = result.ok && result.value.providers.find(entry => entry.id === 'openai')?.route?.endpointId;
  if (!endpointId) throw new Error('Missing provider route');
  return endpointId;
}
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
if (!originalPlatform) throw new Error('Missing platform descriptor');
beforeEach(() => {
  Object.defineProperty(process, 'platform', { ...originalPlatform, value: 'linux' });
  vi.clearAllMocks(); state.handles.clear(); state.localConfined = true;
  state.status.mockReset().mockResolvedValue({ status: 'unconfigured' });
  registerMemoryMapHandlers({ auditLogger: { log: state.audit }, settingsService: { get: () => undefined, set: vi.fn(), hasStoredSecret: vi.fn(async () => false) } } as unknown as IpcDeps,
    raw => (raw as { projectRoot?: string } | undefined)?.projectRoot === '/denied' ? { ok: false, error: 'project-not-allowed' } : { ok: true, options: {} });
});
afterEach(() => { Object.defineProperty(process, 'platform', originalPlatform); });
describe('memory map host boundary', () => {
  it.each([undefined, '/example/verified-model'])('refuses local operations while the OS sandbox cannot confine inference, with model folder %s', async localModelPath => {
    state.localConfined = false;
    state.status.mockResolvedValue({ status: localModelPath ? 'ready' : 'unconfigured' });
    let config: MemoryEmbeddingConfig = { source: 'local', localModelPath };
    const set = vi.fn(async (_key: string, value: MemoryEmbeddingConfig) => { config = value; });
    registerMemoryMapHandlers({
      auditLogger: { log: state.audit },
      settingsService: {
        get: (key: string) => key === 'memoryEmbedding' ? config : undefined,
        hasStoredSecret: async (name: string) => name === 'llm.apiKey.openai',
        set,
      },
    } as unknown as IpcDeps, () => ({ ok: true, options: {} }));
    const unavailable = { ok: false, error: 'local-runtime-unavailable' };
    expect(await invoke('modelStatus')).toEqual(unavailable);
    expect(await invoke('modelDownload')).toEqual(unavailable);
    expect(await invoke('modelUseExisting')).toEqual(unavailable);
    expect(await invoke('build')).toEqual(unavailable);
    expect(await invoke('modelStatus')).toEqual(unavailable);
    expect(state.status).not.toHaveBeenCalled();
    expect(state.download).not.toHaveBeenCalled();
    expect(state.dialog).not.toHaveBeenCalled();
    expect(state.useExisting).not.toHaveBeenCalled();
    expect(state.build).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();

    expect(await invoke('settingsSet', { source: 'provider', providerId: 'openai', modelId: 'text-embedding-3-small',
      endpointId: await providerEndpointId(), consent: true })).toMatchObject({ ok: true, value: { source: 'provider' } });
    expect(config.localModelPath).toBe(localModelPath);
    expect(await invoke('build')).toMatchObject({ ok: true });
    expect(state.build).toHaveBeenCalledOnce();
  });
  it('locates a selected revision through its authorized graph scope and refuses edited or revoked sources', async () => {
    const note = { id: '11111111-1111-4111-8111-111111111111', filename: 'selected.md', title: 'Selected', content: 'Original body' };
    const revision = graphMemoryRevision(note);
    const readManagedMemoryAt = vi.fn(() => note);
    const readMemoryPanelCatalog = vi.fn(() => ({ notes: [note] }));
    const options = { projectRoot: 'D:/workspace/example' };
    let authorized = true;
    const readSource = registerMemoryMapHandlers({
      auditLogger: { log: state.audit },
      settingsService: { get: () => undefined },
      memoryManager: { readMemoryPanelCatalog, readManagedMemoryAt },
    } as unknown as IpcDeps, () => authorized ? { ok: true, options } : { ok: false, error: 'project-not-allowed' });
    state.get.mockImplementationOnce(async readCatalog => { readCatalog(); return null; });
    expect(await invoke('get', options)).toMatchObject({ ok: true });
    expect(readSource(note.id, options, revision)).toBe(note);
    expect(readManagedMemoryAt).toHaveBeenCalledWith(note.filename, note.id, options);
    note.content = 'Edited body';
    expect(readSource(note.id, options, revision)).toBeUndefined();
    authorized = false;
    expect(readSource(note.id, options, graphMemoryRevision(note))).toBeUndefined();
    expect(readManagedMemoryAt).toHaveBeenCalledTimes(2);
    expect(readMemoryPanelCatalog).toHaveBeenCalledOnce();
  });
  it('persists only host-versioned consent and clears it when returning to local', async () => {
    let config: unknown;
    const set = vi.fn(async (_key: string, value: unknown) => { config = value; });
    registerMemoryMapHandlers({ auditLogger: { log: state.audit }, settingsService: {
      get: (key: string) => key === 'memoryEmbedding' ? config : key === 'llm' ? {} : {}, set,
      hasStoredSecret: async (key: string) => key === 'llm.apiKey.openai',
    } } as unknown as IpcDeps, () => ({ ok: true, options: {} }));
    const selection = { source: 'provider', providerId: 'openai', modelId: 'text-embedding-3-small', endpointId: await providerEndpointId(), consent: false };
    expect(await invoke('settingsSet', selection)).toEqual({ ok: false, error: 'provider-consent-required' }); expect(set).not.toHaveBeenCalled();
    expect(await invoke('settingsSet', { ...selection, consent: true, timestamp: 'renderer-value' })).toEqual({ ok: false, error: 'invalid-input' });
    expect(await invoke('settingsSet', { ...selection, consent: true })).toMatchObject({ ok: true, value: { source: 'provider' } });
    expect(config).toMatchObject({ source: 'provider', providerId: selection.providerId, modelId: selection.modelId, consent: { version: 2, providerId: selection.providerId, modelId: selection.modelId, endpointId: expect.stringMatching(/^[a-f0-9]{64}$/), timestamp: expect.any(String) } });
    expect(state.invalidate).toHaveBeenCalledOnce();
    expect(await invoke('settingsSet', { source: 'local' })).toMatchObject({ ok: true, value: { source: 'local' } });
    expect(config).toEqual({ source: 'local' }); expect(state.cancel).toHaveBeenCalled();
  });
  it('orders pending settings writes so opt-out cannot be overwritten by an older provider save', async () => {
    let config: unknown; let release!: () => void; let started!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; }); const entered = new Promise<void>(resolve => { started = resolve; });
    const set = vi.fn(async (_key: string, value: { source: string }) => { if (value.source === 'provider') { started(); await waiting; } config = value; });
    registerMemoryMapHandlers({ auditLogger: { log: state.audit }, settingsService: { get: (key: string) => key === 'memoryEmbedding' ? config : {}, set, hasStoredSecret: async (key: string) => key === 'llm.apiKey.openai' } } as unknown as IpcDeps, () => ({ ok: true, options: {} }));
    const old = invoke('settingsSet', { source: 'provider', providerId: 'openai', modelId: 'text-embedding-3-small', endpointId: await providerEndpointId(), consent: true }); await entered;
    const local = invoke('settingsSet', { source: 'local' }); release();
    expect(await old).toEqual({ ok: false, error: 'request-stale' }); expect(await local).toMatchObject({ ok: true });
    expect(config).toEqual({ source: 'local' });
  });
  it('rechecks the acknowledged route after asynchronous provider validation', async () => {
    let baseUrl = 'https://api.openai.com/v1';
    let pause = false;
    let release!: () => void;
    let started!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const entered = new Promise<void>(resolve => { started = resolve; });
    const set = vi.fn();
    const transport = vi.fn();
    registerMemoryMapHandlers({ auditLogger: { log: state.audit }, singleHopNetworkFetch: transport, settingsService: {
      get: (key: string) => key === 'llm' ? { vendors: { openai: { baseUrl } } } : undefined,
      set,
      hasStoredSecret: async (name: string) => {
        if (name !== 'llm.apiKey.openai') return false;
        if (pause) { started(); await waiting; }
        return true;
      },
    } } as unknown as IpcDeps, () => ({ ok: true, options: {} }));
    const endpointId = await providerEndpointId();
    pause = true;
    const save = invoke('settingsSet', { source: 'provider', providerId: 'openai', modelId: 'text-embedding-3-small', endpointId, consent: true });
    await entered;
    baseUrl = 'https://api.mistral.ai/v1';
    release();
    expect(await save).toEqual({ ok: false, error: 'request-stale' });
    expect(set).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
  });
  it.each(['https://embeddings.example.com/v1', 'http://api.openai.com/v1'])('refuses a policy-ineligible provider route %s', async baseUrl => {
    const set = vi.fn();
    const transport = vi.fn();
    registerMemoryMapHandlers({
      auditLogger: { log: state.audit },
      singleHopNetworkFetch: transport,
      settingsService: {
        get: (key: string) => key === 'llm' ? {
          vendors: { openai: { baseUrl } },
          modelListCache: { saved: {
            vendor: 'openai', baseUrl, endpoint: `${baseUrl}/models`, models: ['embed-a'],
            modelEntries: [{ id: 'embed-a', outputModalities: ['embedding'] }],
          } },
        } : undefined,
        hasStoredSecret: async (name: string) => name === 'llm.apiKey.openai',
        set,
      },
    } as unknown as IpcDeps, () => ({ ok: true, options: {} }));
    const endpointId = await providerEndpointId();
    expect(await invoke('settingsGet')).toMatchObject({ ok: true, value: {
      providerAvailable: false,
      providers: [{ id: 'openai', models: [], reason: 'provider-route-ineligible' }],
    } });
    expect(await invoke('settingsSet', { source: 'provider', providerId: 'openai', modelId: 'embed-a', endpointId, consent: true }))
      .toEqual({ ok: false, error: 'provider-route-ineligible' });
    expect(set).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
  });
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
  it('allows validated host operations and rejects incomplete provider selections', async () => {
    expect(await invoke('build', {})).toEqual({ ok: true, value: { snapshotId: 'snapshot' } });
    expect(await invoke('retrieve', { question: 'Question', filters: {}, snapshotId: 's', queryId: 'q' })).toMatchObject({ ok: true });
    expect(await invoke('settingsGet')).toMatchObject({ ok: true, value: { source: 'local', providerAvailable: false, namespace: { source: 'local', dimensions: 384 } } });
    expect(await invoke('settingsSet', { source: 'provider' })).toEqual({ ok: false, error: 'invalid-input' });
    expect(await invoke('modelUseExisting')).toEqual({ ok: true, value: null });
    expect(state.useExisting).not.toHaveBeenCalled();
    state.dialog.mockResolvedValueOnce({ canceled: false, filePaths: ['/example/model'] });
    expect(await invoke('modelUseExisting')).toMatchObject({ ok: true }); expect(state.useExisting).toHaveBeenCalledWith('/example/model');
  });
});
