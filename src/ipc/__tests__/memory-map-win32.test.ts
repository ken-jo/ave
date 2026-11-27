import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { ClientRequest, IncomingMessage } from 'node:http';
import type { RequestOptions } from 'node:https';
import { Readable } from 'node:stream';
import { promises as dns, type LookupAddress, type LookupAllOptions } from 'node:dns';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TOOL_TIMEOUT_POLICY } from '../../shared/tool-timeout-policy.js';
import { deferred } from '../../__tests__/support/deferred.js';
import type { IpcMainInvokeEvent } from 'electron';
import type { IpcDeps } from '../types.js';
import type { MemoryMapApi } from '../../shared/memory-map.js';
import type { WindowsMemoryEmbeddingConfig } from '../../shared/memory-embedding-config.js';
import { CHANNELS } from '../../contract/app-contract.js';
import { graphMemoryRevision, type ReadMemoryMapCatalog } from '../../main/memory-map/catalog.js';
import { MemoryMapHostError } from '../../main/memory-map/errors.js';
import { MODEL_FILES, modelFileUrl } from '../../main/memory-map/model-manifest.js';
import type { MemoryWorkerRunner } from '../../main/memory-map/worker-client-win32.js';
import { BuildRegistry, type BuildOwner, type MemoryWorkerExit } from '../../main/memory-map/build-registry-win32.js';
const state = vi.hoisted(() => ({
  artifactRequest: vi.fn<(url: URL, options: RequestOptions, respond: (incoming: IncomingMessage) => void) => ClientRequest>(),
  handles: new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>>(),
  get: vi.fn(async (_readCatalog: ReadMemoryMapCatalog) => null),
  build: vi.fn(async (_readCatalog: ReadMemoryMapCatalog, _owner: BuildOwner, _assertLocal: () => void) => ({ snapshotId: 'snapshot' })),
  cancel: vi.fn(), invalidate: vi.fn(), retrieve: vi.fn(async () => ({ queryId: 'query' })),
  status: vi.fn(async () => ({ status: 'unconfigured' })), download: vi.fn(async () => ({ status: 'ready' })), modelCancel: vi.fn(), adoptExistingFolder: vi.fn(async () => ({ status: 'ready' })),
  downloadFile: undefined as ConstructorParameters<typeof import('../../main/memory-map/model-manager-win32.js').LocalModelManager>[0]['downloadFile'],
  readModelPath: undefined as ((signal: AbortSignal) => Promise<string>) | undefined,
  validatedPath: vi.fn(async () => '/example/model'),
  startWorker: undefined as MemoryWorkerRunner | undefined,
  runWorker: vi.fn(),
  refreshAdmission: vi.fn<() => Promise<{ areSwitchesAvailable: () => boolean }>>(),
  dialog: vi.fn(async () => ({ canceled: true, filePaths: [] as string[] })), audit: vi.fn(), localConfined: true, releaseGateOpen: false,
}));
vi.mock('node:https', async importOriginal => ({ ...await importOriginal<typeof import('node:https')>(), request: state.artifactRequest }));
vi.mock('electron', () => ({ ipcMain: { handle: (channel: string, handler: never) => state.handles.set(channel, handler) }, dialog: { showOpenDialog: state.dialog } }));
vi.mock('../../main/memory-map/host-win32.js', async importOriginal => ({ ...await importOriginal<typeof import('../../main/memory-map/host-win32.js')>(), MemoryMapHost: class { constructor(options: { validatedModelPath: (signal: AbortSignal) => Promise<string>; runWorker: MemoryWorkerRunner }) { state.readModelPath = options.validatedModelPath; state.startWorker = options.runWorker; } get = state.get; build = state.build; cancel = state.cancel; invalidate = state.invalidate; retrieve = state.retrieve; } }));
vi.mock('../../main/memory-map/model-manager-win32.js', async importOriginal => ({ ...await importOriginal<typeof import('../../main/memory-map/model-manager-win32.js')>(), LocalModelManager: class { constructor(options: { downloadFile?: typeof state.downloadFile }) { state.downloadFile = options.downloadFile; } validatedPath = state.validatedPath; status = state.status; download = state.download; cancel = state.modelCancel; adoptExistingFolder = state.adoptExistingFolder; } }));
vi.mock('../../main/memory-map/worker-client-win32.js', () => ({ runMemoryWorker: state.runWorker }));
vi.mock('../../main/memory-map/local-runtime-win32.js', async importOriginal => {
  const { MemoryMapHostError } = await import('../../main/memory-map/errors.js');
  return {
    ...await importOriginal<typeof import('../../main/memory-map/local-runtime-win32.js')>(),
    refreshLocalInferenceAdmission: state.refreshAdmission,
    assertLocalEmbeddingRuntime: (enabled: boolean, admission?: { areSwitchesAvailable: () => boolean }) => {
      if (state.localConfined) return 'offline-sandbox';
      if (!(admission?.areSwitchesAvailable() ?? state.releaseGateOpen)) throw new MemoryMapHostError('local-runtime-unavailable');
      if (!enabled) throw new MemoryMapHostError('local-inference-disabled');
      return 'unconfined';
    },
  };
});
import { registerWindowsMemoryMapHandlers } from '../domains/memory-map-win32.js';
import { createMemoryMapInvoker } from './memory-map-fixtures.js';
const hostEvent = { senderFrame: { url: 'file:///app/index.html' }, sender: { send: vi.fn(), isDestroyed: () => false } } as unknown as IpcMainInvokeEvent;
const { invoke, providerEndpointId } = createMemoryMapInvoker(state.handles, hostEvent);
const stopBuilds = vi.spyOn(BuildRegistry.prototype, 'stopAll');
function invokeBuild(scope?: unknown, event?: IpcMainInvokeEvent) {
  return invoke('build', { scope, buildId: randomUUID() }, event);
}
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
if (!originalPlatform) throw new Error('Missing platform descriptor');
beforeEach(() => {
  Object.defineProperty(process, 'platform', { ...originalPlatform, value: 'linux' });
  vi.clearAllMocks(); state.artifactRequest.mockReset(); state.handles.clear(); state.localConfined = true; state.releaseGateOpen = false;
  state.downloadFile = undefined;
  state.readModelPath = undefined;
  state.startWorker = undefined;
  state.runWorker.mockReset();
  state.refreshAdmission.mockReset().mockImplementation(async () => ({ areSwitchesAvailable: () => state.releaseGateOpen }));
  state.status.mockReset().mockResolvedValue({ status: 'unconfigured' });
  registerWindowsMemoryMapHandlers({ auditLogger: { log: state.audit }, settingsService: { get: () => undefined, set: vi.fn(), hasStoredSecret: vi.fn(async () => false) } } as unknown as IpcDeps,
    raw => (raw as { projectRoot?: string } | undefined)?.projectRoot === '/denied' ? { ok: false, error: 'project-not-allowed' } : { ok: true, options: {} });
});
afterEach(() => { Object.defineProperty(process, 'platform', originalPlatform); });
describe('memory map host boundary', () => {
  it('routes Cancel to an older overlapping build without stopping the current owner', async () => {
    const firstId = randomUUID();
    const secondId = randomUUID();
    const unknownId = randomUUID();
    const firstStarted = deferred<BuildOwner>();
    const secondStarted = deferred<{ owner: BuildOwner; exit: MemoryWorkerExit }>();
    const firstSettled = deferred<void>();
    const secondSettled = deferred<void>();
    state.build.mockImplementationOnce(async (_catalog, owner, assertLocal) => {
      owner.takeover(assertLocal);
      const exit = owner.beginWorker('account');
      firstStarted.resolve(owner);
      await firstSettled.promise;
      exit.lost();
      owner.settle({ kind: 'cancelled' });
      throw new MemoryMapHostError('local-runtime-unavailable');
    }).mockImplementationOnce(async (_catalog, owner, assertLocal) => {
      owner.takeover(assertLocal);
      const exit = owner.beginWorker('account');
      secondStarted.resolve({ owner, exit });
      await secondSettled.promise;
      owner.settle({ kind: 'cancelled' });
      return { snapshotId: 'snapshot' };
    });
    const first = invoke('build', { buildId: firstId });
    let second: Promise<unknown> | undefined;
    try {
      const firstOwner = await firstStarted.promise;
      second = invoke('build', { buildId: secondId });
      const { owner: secondOwner, exit: secondExit } = await secondStarted.promise;
      const refusal = { ok: false, error: 'build-exit-unconfirmed' };
      expect(await invoke('cancel')).toEqual({ ok: false, error: 'invalid-input' });
      expect(await invoke('build', { buildId: secondId })).toEqual({ ok: false, error: 'invalid-input' });
      const firstCancel = invoke('cancel', firstId);
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(firstOwner.signal.aborted).toBe(true);
      firstSettled.resolve();
      expect(await firstCancel).toEqual(refusal);
      expect(await invoke('cancel', firstId)).toEqual(refusal);
      expect(secondOwner.signal.aborted).toBe(false);

      const replied = vi.fn((result: unknown) => result);
      const secondCancel = invoke('cancel', secondId).then(replied);
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(replied).not.toHaveBeenCalled();
      expect(secondOwner.signal.aborted).toBe(true);
      secondExit.confirmed();
      expect(await secondCancel).toEqual({ ok: true, value: null });
      expect(await invoke('cancel', unknownId)).toEqual({ ok: false, error: 'invalid-input' });
    } finally {
      firstSettled.resolve();
      secondSettled.resolve();
      await Promise.all([first, second]);
    }
  });

  const artifactDns: { lookup: (host: string, options: LookupAllOptions) => Promise<LookupAddress[]> } = dns;

  async function artifactDownloader(transport?: typeof fetch) {
    registerWindowsMemoryMapHandlers({ singleHopNetworkFetch: transport, settingsService: { get: () => undefined } } as unknown as IpcDeps,
      () => ({ ok: true, options: {} }));
    await invoke('modelStatus');
    assert.ok(state.downloadFile);
    return state.downloadFile;
  }

  function mockArtifactHttps(
    replies: { status: number; location?: string; body?: string }[],
    beforeSecure?: () => void,
  ) {
    const dial = vi.fn<(address: string) => void>();
    const send = vi.fn<(url: string) => void>();
    state.artifactRequest.mockImplementation((url, options, respond) => {
      const request = new EventEmitter();
      const socket = new EventEmitter();
      const destroy = (error: Error) => queueMicrotask(() => request.emit('error', error));
      const end = () => {
        send(url.href);
        const reply = replies.shift();
        assert.ok(reply);
        const incoming = Readable.from(reply.body ? [Buffer.from(reply.body)] : []);
        respond(Object.assign(incoming, {
          statusCode: reply.status,
          rawHeaders: reply.location ? ['Location', reply.location] : [],
        }) as IncomingMessage);
      };
      queueMicrotask(() => {
        assert.ok(options.lookup);
        const { autoSelectFamily } = options as { autoSelectFamily?: boolean };
        options.lookup(url.hostname, { all: autoSelectFamily !== false }, (error, answers) => {
          assert.ifError(error);
          const [first, ...fallback] = Array.isArray(answers) ? answers.map(answer => answer.address) : [answers];
          assert.ok(first);
          dial(first);
          request.emit('socket', socket);
          beforeSecure?.();
          for (const address of fallback) dial(address);
          socket.emit('secureConnect');
        });
      });
      return Object.assign(request, { destroy, end }) as unknown as ClientRequest;
    });
    return { dial, send };
  }

  it('refuses an artifact connection to a DNS answer outside the public network', async () => {
    const publicAddress = { address: '93.184.216.34', family: 4 };
    const refusedAddress = { address: '127.0.0.1', family: 4 };
    const lookup = vi.spyOn(artifactDns, 'lookup')
      .mockResolvedValueOnce([publicAddress]).mockResolvedValue([refusedAddress]);
    const redirectedUrl = 'https://artifacts.example.com/model';
    const { dial, send } = mockArtifactHttps([{ status: 302, location: redirectedUrl }]);
    const transport = vi.fn<typeof fetch>().mockImplementation(async input => {
      const [answer] = await artifactDns.lookup(new URL(String(input)).hostname, { all: true });
      if (answer) dial(answer.address);
      return new Response('unexpected');
    });
    try {
      const download = await artifactDownloader(transport);
      const result = await download(MODEL_FILES[0].name, new AbortController().signal, vi.fn()).catch(error => error);
      expect(dial).not.toHaveBeenCalledWith(refusedAddress.address);
      expect(dial).toHaveBeenCalledExactlyOnceWith(publicAddress.address);
      expect(send).toHaveBeenCalledOnce();
      expect(lookup.mock.calls.map(([host]) => host)).toEqual([new URL(modelFileUrl(MODEL_FILES[0].name)).hostname, 'artifacts.example.com']);
      expect(result).toBeInstanceOf(Error);
    } finally {
      lookup.mockRestore();
    }
  });

  it.each(['timeout', 'cancel'] as const)('settles a stalled artifact DNS lookup on %s', async outcome => {
    const lookupStarted = deferred<void>();
    const answers = deferred<LookupAddress[]>();
    const lookup = vi.spyOn(artifactDns, 'lookup').mockImplementation(() => {
      lookupStarted.resolve();
      return answers.promise;
    });
    const transport = vi.fn<typeof fetch>();
    const controller = new AbortController();
    const completed = vi.fn();
    vi.useFakeTimers();
    try {
      const download = await artifactDownloader(transport);
      const attempt = download(MODEL_FILES[0].name, controller.signal, vi.fn()).then(
        response => completed(response),
        error => completed(error),
      );
      await lookupStarted.promise;
      if (outcome === 'cancel') controller.abort();
      await vi.advanceTimersByTimeAsync(outcome === 'timeout' ? TOOL_TIMEOUT_POLICY.networkFetchDefaultMs : 0);
      expect(completed).toHaveBeenCalledWith(expect.objectContaining({ name: 'AbortError' }));
      await attempt;
      expect(transport).not.toHaveBeenCalled();
      expect(state.artifactRequest).not.toHaveBeenCalled();
    } finally {
      answers.resolve([]);
      lookup.mockRestore();
      vi.useRealTimers();
    }
  });

  it('does not send another artifact request for a non-redirect 304 with Location', async () => {
    const lookup = vi.spyOn(artifactDns, 'lookup').mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    const { send } = mockArtifactHttps([{ status: 304, location: 'https://artifacts.example.com/model' }]);
    try {
      const download = await artifactDownloader();
      await expect(download(MODEL_FILES[0].name, new AbortController().signal, vi.fn()))
        .rejects.toMatchObject({ code: 'model-download-failed' });
      expect(send).toHaveBeenCalledExactlyOnceWith(modelFileUrl(MODEL_FILES[0].name));
      expect(lookup).toHaveBeenCalledOnce();
    } finally {
      lookup.mockRestore();
    }
  });

  it('streams the pinned artifact through HTTPS and keeps cancellation attached', async () => {
    const address = { address: '93.184.216.34', family: 4 };
    const lookup = vi.spyOn(artifactDns, 'lookup').mockResolvedValue([address]);
    const redirectedUrl = 'https://artifacts.example.com/model';
    const { dial, send } = mockArtifactHttps([{ status: 302, location: redirectedUrl }, { status: 200, body: 'artifact' }]);
    try {
      const download = await artifactDownloader();
      const controller = new AbortController();
      const file = MODEL_FILES[0].name;
      const response = await download(file, controller.signal, vi.fn());
      expect(await response.text()).toBe('artifact');
      expect(send.mock.calls.map(([url]) => url)).toEqual([modelFileUrl(file), redirectedUrl]);
      expect(dial.mock.calls).toEqual([[address.address], [address.address]]);
      expect(lookup).toHaveBeenCalledTimes(2);
      const requestOptions = state.artifactRequest.mock.calls[1][1];
      expect(requestOptions).toMatchObject({ agent: false, rejectUnauthorized: true });
      controller.abort();
      expect(requestOptions.signal?.aborted).toBe(true);
    } finally {
      lookup.mockRestore();
    }
  });

  it('checks artifact admission after resolving a redirect and before connecting', async () => {
    const revoked = new MemoryMapHostError('local-runtime-unavailable');
    let admitted = true;
    const lookup = vi.spyOn(artifactDns, 'lookup').mockImplementation(async host => {
      if (host === 'artifacts.example.com') admitted = false;
      return [{ address: '93.184.216.34', family: 4 }];
    });
    const { send } = mockArtifactHttps([{ status: 302, location: 'https://artifacts.example.com/model' }]);
    try {
      const download = await artifactDownloader();
      await expect(download(MODEL_FILES[0].name, new AbortController().signal, () => {
        if (!admitted) throw revoked;
      })).rejects.toBe(revoked);
      expect(state.artifactRequest).toHaveBeenCalledOnce();
      expect(send).toHaveBeenCalledOnce();
    } finally {
      lookup.mockRestore();
    }
  });

  it('checks artifact admission again at the HTTP send after TLS connects', async () => {
    const revoked = new MemoryMapHostError('local-runtime-unavailable');
    let admitted = true;
    const lookup = vi.spyOn(artifactDns, 'lookup').mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    const { dial, send } = mockArtifactHttps([], () => { admitted = false; });
    try {
      const download = await artifactDownloader();
      await expect(download(MODEL_FILES[0].name, new AbortController().signal, () => {
        if (!admitted) throw revoked;
      })).rejects.toBe(revoked);
      expect(dial).toHaveBeenCalledOnce();
      expect(send).not.toHaveBeenCalled();
    } finally {
      lookup.mockRestore();
    }
  });

  it('prevents an artifact fallback dial when admission is withdrawn after the first attempt', async () => {
    const revoked = new MemoryMapHostError('local-runtime-unavailable');
    let admitted = true;
    const first = { address: '2606:4700:4700::1111', family: 6 };
    const second = { address: '93.184.216.34', family: 4 };
    const lookup = vi.spyOn(artifactDns, 'lookup').mockResolvedValue([first, second]);
    const { dial, send } = mockArtifactHttps([], () => {
      expect(dial).toHaveBeenCalledExactlyOnceWith(first.address);
      admitted = false;
    });
    try {
      const download = await artifactDownloader();
      await expect(download(MODEL_FILES[0].name, new AbortController().signal, () => {
        if (!admitted) throw revoked;
      })).rejects.toBe(revoked);
      expect(dial).toHaveBeenCalledExactlyOnceWith(first.address);
      expect(send).not.toHaveBeenCalled();
      expect(state.artifactRequest).toHaveBeenCalledOnce();
      expect(state.artifactRequest.mock.calls[0]?.[1]).toMatchObject({ autoSelectFamily: false });
    } finally {
      lookup.mockRestore();
    }
  });

  it.each(['sender', 'scope'] as const)('checks the original %s before delivering its protected result', async change => {
    let live = true;
    const senderFrame = { url: 'file:///app/index.html' };
    const event = { ...hostEvent, senderFrame } as unknown as IpcMainInvokeEvent;
    registerWindowsMemoryMapHandlers({ auditLogger: { log: state.audit }, settingsService: { get: () => undefined } } as unknown as IpcDeps,
      () => ({ ok: true, options: { projectRoot: live ? '/example/first' : '/example/replacement' } }));
    if (change === 'sender') {
      state.build.mockImplementationOnce(async () => {
        queueMicrotask(() => { senderFrame.url = 'ave-mcp-app://isolated/index.html'; });
        return { snapshotId: 'snapshot' };
      });
      await expect(invokeBuild(undefined, event)).resolves.toMatchObject({ ok: false, error: 'unauthorized-frame' });
    } else {
      state.get.mockImplementationOnce(async () => {
        queueMicrotask(() => { live = false; });
        return null;
      });
      await expect(invoke('get', undefined, event)).resolves.toMatchObject({ ok: false, error: 'project-not-allowed' });
    }
  });

  it('rechecks switch eligibility when a queued settings write runs', async () => {
    const firstWrite = deferred<void>();
    const set = vi.fn(async () => {}).mockImplementationOnce(() => firstWrite.promise);
    registerWindowsMemoryMapHandlers({
      auditLogger: { log: state.audit },
      settingsService: { get: () => undefined, hasStoredSecret: async () => false, set },
    } as unknown as IpcDeps, () => ({ ok: true, options: {} }));
    state.releaseGateOpen = true;
    const first = invoke('settingsSet', { localInferenceWithoutSandbox: true });
    await vi.waitFor(() => expect(set).toHaveBeenCalledOnce());
    const queued = invoke('settingsSet', { localInferenceWithoutSandbox: false });
    try {
      await new Promise<void>(resolve => setImmediate(resolve));
      state.releaseGateOpen = false;
    } finally {
      firstWrite.resolve(undefined);
    }
    await expect(first).resolves.toMatchObject({ ok: true });
    await expect(queued).resolves.toEqual({ ok: false, error: 'local-runtime-unavailable' });
    expect(set).toHaveBeenCalledOnce();
  });

  it('exposes and persists the preference only with release readiness, and refuses local operations while off', async () => {
    const localModelPath = '/example/model';
    let config: WindowsMemoryEmbeddingConfig = { source: 'local', localModelPath };
    const set = vi.fn(async (_key: string, value: WindowsMemoryEmbeddingConfig) => { config = value; });
    registerWindowsMemoryMapHandlers({
      auditLogger: { log: state.audit },
      settingsService: { get: (key: string) => key === 'memoryEmbedding' ? config : undefined, hasStoredSecret: async () => false, set },
    } as unknown as IpcDeps, () => ({ ok: true, options: {} }));
    state.localConfined = false;
    const preference = { localInferenceWithoutSandbox: false };
    const change = () => invoke('settingsSet', preference);
    const unreleased = await invoke('settingsGet') as Awaited<ReturnType<MemoryMapApi['settingsGet']>>;
    expect(unreleased.ok).toBe(true);
    if (unreleased.ok) expect(unreleased.value).not.toHaveProperty('localInferenceWithoutSandbox');
    await expect(change()).resolves.toEqual({ ok: false, error: 'local-runtime-unavailable' });
    expect(set).not.toHaveBeenCalled();

    state.releaseGateOpen = true;
    await expect(invoke('settingsSet', { localInferenceWithoutSandbox: 'false' })).resolves.toEqual({ ok: false, error: 'invalid-input' });
    await expect(invoke('settingsGet')).resolves.toMatchObject({ ok: true, value: { localInferenceWithoutSandbox: true } });
    await expect(invokeBuild()).resolves.toMatchObject({ ok: true });
    await expect(change()).resolves.toMatchObject({ ok: true, value: preference });
    expect(set).toHaveBeenCalledWith('memoryEmbedding', { source: 'local', localModelPath, ...preference },
      expect.objectContaining({ field: ['memoryEmbedding', 'localInferenceWithoutSandbox'] }));
    expect(stopBuilds).toHaveBeenCalledExactlyOnceWith('settings');
    await expect(invoke('modelStatus')).resolves.toEqual({ ok: false, error: 'local-inference-disabled' });
    await expect(invokeBuild()).resolves.toEqual({ ok: false, error: 'local-inference-disabled' });
    await expect(invoke('settingsSet', { source: 'local' })).resolves.toMatchObject({ ok: true, value: preference });
    await expect(invoke('settingsSet', { localInferenceWithoutSandbox: true })).resolves.toMatchObject({ ok: true, value: { localInferenceWithoutSandbox: true } });
    await expect(invoke('modelStatus')).resolves.toMatchObject({ ok: true });
  });

  it.each(['build', 'modelStatus', 'modelDownload'] as const)('recovers from unknown evidence before %s', async operation => {
    state.localConfined = false;
    state.refreshAdmission.mockResolvedValue({ areSwitchesAvailable: () => true });
    expect(await (operation === 'build' ? invokeBuild() : invoke(operation))).toMatchObject({ ok: true });
    expect(state.refreshAdmission).toHaveBeenCalled();
  });

  it.each([
    ['build', state.build], ['modelStatus', state.status], ['modelDownload', state.download],
  ] as const)('refuses stale absence before %s', async (operation, effect) => {
    state.localConfined = false;
    state.releaseGateOpen = true;
    state.refreshAdmission.mockResolvedValue({ areSwitchesAvailable: () => false });
    expect(await (operation === 'build' ? invokeBuild() : invoke(operation))).toEqual({ ok: false, error: 'local-runtime-unavailable' });
    expect(effect).not.toHaveBeenCalled();
  });

  it('takes a fresh decision before validating a configured model path', async () => {
    const config: WindowsMemoryEmbeddingConfig = { source: 'local', localModelPath: '/example/model' };
    registerWindowsMemoryMapHandlers({
      auditLogger: { log: state.audit },
      settingsService: { get: (key: string) => key === 'memoryEmbedding' ? config : undefined, set: vi.fn() },
    } as unknown as IpcDeps, () => ({ ok: true, options: {} }));
    state.localConfined = false;
    state.releaseGateOpen = true;
    state.refreshAdmission.mockResolvedValue({ areSwitchesAvailable: () => false });
    state.retrieve.mockImplementationOnce(async () => { await state.readModelPath?.(new AbortController().signal); return { queryId: 'query' }; });
    expect(await invoke('retrieve', { question: 'Question', filters: {}, snapshotId: 's', queryId: 'q' }))
      .toEqual({ ok: false, error: 'local-runtime-unavailable' });
    expect(state.validatedPath).not.toHaveBeenCalled();
  });

  it('refreshes folder adoption again after the directory dialog', async () => {
    state.localConfined = false;
    state.releaseGateOpen = true;
    const selection = deferred<{ canceled: boolean; filePaths: string[] }>();
    state.dialog.mockReturnValueOnce(selection.promise);
    state.refreshAdmission.mockResolvedValueOnce({ areSwitchesAvailable: () => true })
      .mockResolvedValue({ areSwitchesAvailable: () => false });
    const adoption = invoke('modelUseExisting');
    try {
      await vi.waitFor(() => expect(state.dialog).toHaveBeenCalledOnce());
    } finally {
      selection.resolve({ canceled: false, filePaths: ['/example/model'] });
    }
    expect(await adoption).toEqual({ ok: false, error: 'local-runtime-unavailable' });
    expect(state.adoptExistingFolder).not.toHaveBeenCalled();
    expect(state.refreshAdmission).toHaveBeenCalledTimes(2);
  });

  it('blocks a waiting host start as soon as a disable request joins the shared probe', async () => {
    let config: WindowsMemoryEmbeddingConfig = { source: 'local', localInferenceWithoutSandbox: true };
    const set = vi.fn(async (_key: string, value: WindowsMemoryEmbeddingConfig) => { config = value; });
    registerWindowsMemoryMapHandlers({
      auditLogger: { log: state.audit },
      settingsService: { get: (key: string) => key === 'memoryEmbedding' ? config : undefined, set, hasStoredSecret: async () => false },
    } as unknown as IpcDeps, () => ({ ok: true, options: {} }));
    state.localConfined = false;
    state.releaseGateOpen = true;
    await invoke('settingsGet');
    assert.ok(state.startWorker);
    state.refreshAdmission.mockClear();
    const shared = deferred<{ areSwitchesAvailable: () => boolean }>();
    state.refreshAdmission.mockReturnValue(shared.promise);
    const startHost = vi.fn();
    state.runWorker.mockImplementationOnce(async (_folder, _task, _signal, _progress, _onAdmission, _exit, preference: () => boolean) => {
      const admission = await shared.promise;
      if (admission.areSwitchesAvailable() && preference()) startHost();
    });
    const inference = state.startWorker('/example/model', { kind: 'embed', text: 'fixture' }, new AbortController().signal);
    const disable = invoke('settingsSet', { localInferenceWithoutSandbox: false });
    try {
      await vi.waitFor(() => expect(state.refreshAdmission).toHaveBeenCalledOnce());
      expect(set).not.toHaveBeenCalled();
    } finally {
      shared.resolve({ areSwitchesAvailable: () => true });
    }
    await inference;
    expect(startHost).not.toHaveBeenCalled();
    await expect(disable).resolves.toMatchObject({ ok: true, value: { localInferenceWithoutSandbox: false } });
  });

  it('returns a distinct error for an oversized local build', async () => {
    state.build.mockRejectedValueOnce(new MemoryMapHostError('catalog-too-large'));
    await expect(invokeBuild()).resolves.toEqual({ ok: false, error: 'catalog-too-large' });
  });

  it.each([undefined, '/example/verified-model'])('refuses local operations while the OS sandbox cannot confine inference, with model folder %s', async localModelPath => {
    state.localConfined = false;
    state.status.mockResolvedValue({ status: localModelPath ? 'ready' : 'unconfigured' });
    let config: WindowsMemoryEmbeddingConfig = { source: 'local', localModelPath };
    const set = vi.fn(async (_key: string, value: WindowsMemoryEmbeddingConfig) => { config = value; });
    registerWindowsMemoryMapHandlers({
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
    expect(await invokeBuild()).toEqual(unavailable);
    expect(await invoke('modelStatus')).toEqual(unavailable);
    expect(state.status).not.toHaveBeenCalled();
    expect(state.download).not.toHaveBeenCalled();
    expect(state.dialog).not.toHaveBeenCalled();
    expect(state.adoptExistingFolder).not.toHaveBeenCalled();
    expect(state.build).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();

    expect(await invoke('settingsSet', { source: 'provider', providerId: 'openai', modelId: 'text-embedding-3-small',
      endpointId: await providerEndpointId(), consent: true })).toMatchObject({ ok: true, value: { source: 'provider' } });
    expect(config.localModelPath).toBe(localModelPath);
    expect(await invokeBuild()).toMatchObject({ ok: true });
    expect(state.build).toHaveBeenCalledOnce();
  });
  it('locates a selected revision through its authorized graph scope and refuses edited or revoked sources', async () => {
    const note = { id: '11111111-1111-4111-8111-111111111111', filename: 'selected.md', title: 'Selected', content: 'Original body' };
    const revision = graphMemoryRevision(note);
    const readManagedMemoryAt = vi.fn(() => note);
    const readMemoryPanelCatalog = vi.fn(() => ({ notes: [note] }));
    const options = { projectRoot: 'D:/workspace/example' };
    let authorized = true;
    const readSource = registerWindowsMemoryMapHandlers({
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
    expect(readMemoryPanelCatalog).toHaveBeenCalledTimes(3);
  });
  it('persists only host-versioned consent and clears it when returning to local', async () => {
    let config: unknown;
    const set = vi.fn(async (_key: string, value: unknown) => { config = value; });
    registerWindowsMemoryMapHandlers({ auditLogger: { log: state.audit }, settingsService: {
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
    expect(config).toEqual({ source: 'local' }); expect(stopBuilds).toHaveBeenCalledWith('settings');
  });
  it('orders pending settings writes so opt-out cannot be overwritten by an older provider save', async () => {
    let config: unknown; let release!: () => void; let started!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; }); const entered = new Promise<void>(resolve => { started = resolve; });
    const set = vi.fn(async (_key: string, value: { source: string }) => { if (value.source === 'provider') { started(); await waiting; } config = value; });
    registerWindowsMemoryMapHandlers({ auditLogger: { log: state.audit }, settingsService: { get: (key: string) => key === 'memoryEmbedding' ? config : {}, set, hasStoredSecret: async (key: string) => key === 'llm.apiKey.openai' } } as unknown as IpcDeps, () => ({ ok: true, options: {} }));
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
    registerWindowsMemoryMapHandlers({ auditLogger: { log: state.audit }, singleHopNetworkFetch: transport, settingsService: {
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
    registerWindowsMemoryMapHandlers({
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
    expect(await invoke(key, { invalid: true }, event)).toEqual({ ok: false, error: 'unauthorized-frame' });
    expect(state.audit).toHaveBeenCalledOnce(); expect(state.download).not.toHaveBeenCalled(); expect(state.build).not.toHaveBeenCalled();
  });
  it('validates strict payloads and rejects unauthorized projects before catalog access', async () => {
    expect(await invokeBuild({ projectRoot: '/denied' })).toEqual({ ok: false, error: 'project-not-allowed' });
    expect(await invokeBuild({ arbitraryPath: '/example' })).toEqual({ ok: false, error: 'invalid-input' });
    expect(await invoke('get', null)).toEqual({ ok: false, error: 'invalid-input' });
    expect(await invoke('modelDownload', {})).toEqual({ ok: false, error: 'invalid-input' });
    expect(await invoke('retrieve', { question: '', filters: {}, snapshotId: 's', queryId: 'q' })).toEqual({ ok: false, error: 'invalid-input' });
    expect(await invoke('retrieve', { question: 'q', filters: { sources: ['other'] }, snapshotId: 's', queryId: 'q' })).toEqual({ ok: false, error: 'invalid-input' });
    expect(state.build).not.toHaveBeenCalled(); expect(state.download).not.toHaveBeenCalled();
  });
  it('allows validated host operations and rejects incomplete provider selections', async () => {
    expect(await invokeBuild({})).toEqual({ ok: true, value: { snapshotId: 'snapshot' } });
    expect(await invoke('retrieve', { question: 'Question', filters: {}, snapshotId: 's', queryId: 'q' })).toMatchObject({ ok: true });
    expect(await invoke('settingsGet')).toMatchObject({ ok: true, value: { source: 'local', providerAvailable: false, namespace: { source: 'local', dimensions: 384 } } });
    expect(await invoke('settingsSet', { source: 'provider' })).toEqual({ ok: false, error: 'invalid-input' });
    expect(await invoke('modelUseExisting')).toEqual({ ok: true, value: null });
    expect(state.adoptExistingFolder).not.toHaveBeenCalled();
    state.dialog.mockResolvedValueOnce({ canceled: false, filePaths: ['/example/model'] });
    expect(await invoke('modelUseExisting')).toMatchObject({ ok: true }); expect(state.adoptExistingFolder).toHaveBeenCalledWith('/example/model', expect.any(Function), expect.any(Function));
  });
});
