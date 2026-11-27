import { afterEach, beforeEach, expect, it, onTestFinished, vi } from 'vitest';
import { deferred } from '../../__tests__/support/deferred.js';
import { collectPermissionEvents } from '../../__tests__/support/permission-events.js';
import { installNativeChatWindow, invokeNativeChatHandler, nativeChatFrameEvent } from '../../__tests__/support/native-chat-window.js';
import { setProcessPlatform } from '../../__tests__/support/process-platform.js';
import { CHANNELS } from '../../contract/app-contract.js';
import { MemoryMapHostError } from '../../main/memory-map/errors.js';
import { WindowsSessionRepository } from '../../memory/session-repository-win32.js';
import { registerChatHandlers } from '../domains/chat.js';
import { registerMemoryMapHandlers } from '../domains/memory-map.js';
import { UNAUTHORIZED_FRAME } from '../gated.js';
import type { IpcDeps } from '../types.js';

const state = vi.hoisted(() => ({
  handles: new Map<string, (...args: unknown[]) => unknown>(),
  posixRuntime: vi.fn(), windowsRuntime: vi.fn(),
  getGraph: vi.fn(), modelStatus: vi.fn(), openFolder: vi.fn(), download: vi.fn(), adopt: vi.fn(),
  suspend: vi.fn(), resume: vi.fn(), issueConsent: vi.fn(), search: vi.fn(),
}));
vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, handler: (...args: unknown[]) => unknown) => state.handles.set(channel, handler) },
}));
vi.mock('../../main/memory-map/host.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../main/memory-map/host.js')>(),
  MemoryMapHost: class { get = state.getGraph; cancel() {} },
}));
vi.mock('../../main/memory-map/model-manager.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../main/memory-map/model-manager.js')>(),
  LocalModelManager: class { status = state.modelStatus; download = state.download; adoptExistingFolder = state.adopt; },
}));
vi.mock('../../main/memory-map/local-runtime.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../main/memory-map/local-runtime.js')>(),
  assertLocalEmbeddingRuntime: () => 'offline-sandbox',
  refreshLocalInferenceAdmission: async () => ({ areSwitchesAvailable: () => false, isBackendOperational: () => false }),
}));
vi.mock('../../main/desktop-approval-presentation.js', () => ({ pickNativeFiles: state.openFolder }));
vi.mock('../../main/memory-map/provider-embeddings.js', () => ({
  ProviderEmbeddings: class {
    suspend = state.suspend;
    resume = state.resume;
    issueConsent = state.issueConsent;
    assertCurrentEndpoint() {}
  },
}));
vi.mock('../domains/memory-map-runtime.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../domains/memory-map-runtime.js')>();
  return {
    ...actual,
    createMemoryMapRuntime: (...args: Parameters<typeof actual.createMemoryMapRuntime>) => {
      state.posixRuntime();
      return actual.createMemoryMapRuntime(...args);
    },
  };
});
vi.mock('../domains/memory-map-runtime-win32.js', () => ({
  createMemoryMapRuntime: () => { state.windowsRuntime(); return { get: () => 'windows-graph', buildView: () => 'windows-build-view' }; },
}));

const platform = process.platform;
const deps = {
  conversationLoop: { getSessionId: () => "fixture-session", getHistory: () => ({ length: 0, getMessages: () => [] }) },
  memoryManager: { sessions: { searchSessions: state.search, searchSessionsWithCurrentPolicy: async () => [] } },
  settingsService: { get: () => ({ source: 'provider' }), set: vi.fn() },
  getMainWindow: () => null,
} as unknown as IpcDeps;

beforeEach(async () => {
  vi.clearAllMocks();
  state.handles.clear();
  state.getGraph.mockReset();
  setProcessPlatform('linux');
  await installNativeChatWindow();
});
afterEach(() => setProcessPlatform(platform));

it.each(['darwin', 'linux', 'win32'] as const)('loads only the selected Memory Map runtime on %s', async selected => {
  setProcessPlatform(selected);
  state.getGraph.mockResolvedValueOnce('main-graph');
  registerChatHandlers(deps);
  expect(state.posixRuntime).not.toHaveBeenCalled();
  expect(state.windowsRuntime).not.toHaveBeenCalled();
  await expect(invokeNativeChatHandler(state.handles, CHANNELS.memoryMap.get)).resolves.toEqual({
    ok: true, value: selected === 'win32' ? 'windows-graph' : 'main-graph',
  });
  expect(state.posixRuntime).toHaveBeenCalledTimes(selected === 'win32' ? 0 : 1);
  expect(state.windowsRuntime).toHaveBeenCalledTimes(selected === 'win32' ? 1 : 0);
  expect(state.handles.has(CHANNELS.memoryMap.buildView)).toBe(selected === 'win32');
  if (selected === 'win32') await expect(invokeNativeChatHandler(state.handles, CHANNELS.memoryMap.buildView)).resolves.toEqual({ ok: true, value: 'windows-build-view' });
  state.getGraph.mockReset();
});

it('returns the scoped action result when scope changes after admission', async () => {
  let options = { projectRoot: '/example/first' };
  registerMemoryMapHandlers(deps, () => ({ ok: true, options }));
  const entered = deferred<void>();
  const result = deferred<string>();
  state.getGraph.mockImplementationOnce(() => { entered.resolve(); return result.promise; });
  const pending = invokeNativeChatHandler(state.handles, CHANNELS.memoryMap.get);
  await Promise.race([entered.promise, Promise.resolve(pending).then(() => { throw new Error('IPC returned before entering the action'); })]);
  options = { projectRoot: '/example/second' };
  result.resolve('original-graph');
  await expect(pending).resolves.toEqual({ ok: true, value: 'original-graph' });
});

it('returns model status when the initiating frame navigates after admission', async () => {
  registerMemoryMapHandlers(deps, () => ({ ok: true, options: {} }));
  const entered = deferred<void>();
  const status = deferred<{ status: string }>();
  state.modelStatus.mockImplementationOnce(() => { entered.resolve(); return status.promise; });
  const pending = invokeNativeChatHandler(state.handles, CHANNELS.memoryMap.modelStatus);
  await entered.promise;
  const frame = nativeChatFrameEvent().senderFrame as unknown as { url: string };
  frame.url = 'https://example.test';
  status.resolve({ status: 'ready' });
  await expect(pending).resolves.toEqual({ ok: true, value: { status: 'ready' } });
});

it('adopts the picked folder after a newer download request', async () => {
  registerMemoryMapHandlers(deps, () => ({ ok: true, options: {} }));
  const opening = deferred<void>();
  const picker = deferred<{ canceled: boolean; filePaths: string[] }>();
  state.openFolder.mockImplementationOnce(() => { opening.resolve(); return picker.promise; });
  state.download.mockResolvedValueOnce({ status: 'ready' });
  state.adopt.mockResolvedValueOnce({ status: 'ready' });
  const pending = invokeNativeChatHandler(state.handles, CHANNELS.memoryMap.modelUseExisting);
  await Promise.race([opening.promise, Promise.resolve(pending).then(() => { throw new Error('IPC returned before opening the picker'); })]);
  await invokeNativeChatHandler(state.handles, CHANNELS.memoryMap.modelDownload);
  picker.resolve({ canceled: false, filePaths: ['/example/model'] });
  await expect(pending).resolves.toEqual({ ok: true, value: { status: 'ready' } });
  expect(state.adopt).toHaveBeenCalledWith('/example/model');
});

it('rejects a switch-only Memory Map setting as invalid input', async () => {
  registerMemoryMapHandlers(deps, () => ({ ok: true, options: {} }));
  await expect(invokeNativeChatHandler(state.handles, CHANNELS.memoryMap.settingsSet, { localInferenceWithoutSandbox: false }))
    .resolves.toEqual({ ok: false, error: 'invalid-input' });
});

it('leaves provider work suspended when model consent fails', async () => {
  registerMemoryMapHandlers(deps, () => ({ ok: true, options: {} }));
  state.issueConsent.mockRejectedValueOnce(new MemoryMapHostError('provider-no-embedding-model'));
  await expect(invokeNativeChatHandler(state.handles, CHANNELS.memoryMap.settingsSet, {
    source: 'provider', providerId: 'openai', modelId: 'fixture-invalid', endpointId: 'a'.repeat(64), consent: true,
  })).resolves.toEqual({ ok: false, error: 'provider-no-embedding-model' });
  expect(state.suspend).toHaveBeenCalledOnce();
  expect(state.resume).not.toHaveBeenCalled();
});

it('returns session search results synchronously on POSIX', () => {
  const rows = [{ sessionId: 'fixture-session' }];
  state.search.mockReturnValueOnce(rows);
  registerChatHandlers(deps);
  expect(invokeNativeChatHandler(state.handles, CHANNELS.memory.sessionsSearch, 'search term')).toBe(rows);
});

it('refuses the Windows session search reply when its sender navigates during the search', async () => {
  setProcessPlatform('win32');
  const logs = collectPermissionEvents();
  onTestFinished(logs.restore);
  const result = deferred<Array<{ sessionId: string }>>();
  const sessions: WindowsSessionRepository = Object.assign(Object.create(WindowsSessionRepository.prototype), {
    searchSessionsWithCurrentPolicy: async () => result.promise,
  });
  registerChatHandlers({ ...deps, memoryManager: { ...deps.memoryManager, sessions } });
  const pending = invokeNativeChatHandler(state.handles, CHANNELS.memory.sessionsSearch, 'search term');
  const frame = nativeChatFrameEvent().senderFrame as unknown as { url: string };
  frame.url = 'https://example.test';
  result.resolve([{ sessionId: 'fixture-session' }]);

  await expect(pending).resolves.toEqual(UNAUTHORIZED_FRAME);
  expect(logs.events).toContainEqual({ event: 'ipc_sender_refused', channel: CHANNELS.memory.sessionsSearch });
});
