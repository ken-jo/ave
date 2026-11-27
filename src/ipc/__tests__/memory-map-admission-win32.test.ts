import { mkdtemp, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IpcMainInvokeEvent } from 'electron';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { deferred } from '../../__tests__/support/deferred.js';
import { setProcessPlatform } from '../../__tests__/support/process-platform.js';
import { createTmpDirTracker } from '../../__tests__/support/tmp-dir-teardown.js';
import { CHANNELS } from '../../contract/app-contract.js';
import { ManagedExitUnconfirmedError } from '../../main/managed-child-processes.js';
import { MxcProcessCleanupError } from '../../permissions/mxc-extension-errors.js';
import { buildGraph } from '../../main/memory-map/graph.js';
import type { MemoryWorkerExit } from '../../main/memory-map/build-teardown-win32.js';
import * as localRuntime from '../../main/memory-map/local-runtime-win32.js';
import type { MemoryWorkerTask } from '../../main/memory-map/worker-client.js';
import { registerMxcReleaseGateEvidence } from '../../permissions/mxc-extension-admission.js';
import { __resetSandboxHomesUnavailableForTest, markSandboxHomesUnavailable } from '../../permissions/sandbox-capability.js';
import { invalidateWindowsBackendEvidence } from '../../permissions/windows-confinement-evidence.js';
import type { SandboxWindowsExtensionPlan, SandboxWindowsSubstrateInfo } from '../../shared/sandbox-capability-info.js';
import { TOOL_TIMEOUT_POLICY } from '../../shared/tool-timeout-policy.js';
import { registerWindowsMemoryMapHandlers } from '../domains/memory-map-win32.js';
import type { IpcDeps } from '../types.js';

const state = vi.hoisted(() => ({
  root: '',
  account: false,
  operational: true,
  plan: undefined as Partial<SandboxWindowsExtensionPlan> | undefined,
  substrate: null as Partial<SandboxWindowsSubstrateInfo> | null,
  handle: undefined as ((event: IpcMainInvokeEvent, raw: unknown) => Promise<unknown>) | undefined,
  get: undefined as ((event: IpcMainInvokeEvent) => Promise<unknown>) | undefined,
  cancel: undefined as ((event: IpcMainInvokeEvent, raw: unknown) => Promise<unknown>) | undefined,
  runWorker: vi.fn<(folder: string, task: MemoryWorkerTask, signal: AbortSignal, progress?: unknown, admission?: unknown, exit?: MemoryWorkerExit) => Promise<unknown>>(),
  beforeCommit: undefined as (() => Promise<unknown>) | undefined,
  afterRead: undefined as (() => void) | undefined,
}));
vi.mock('electron', () => ({ dialog: {}, ipcMain: { handle: (channel: string, handler: typeof state.handle) => {
  if (channel === CHANNELS.memoryMap.build) state.handle = handler;
  if (channel === CHANNELS.memoryMap.get) state.get = handler && (event => handler(event, undefined));
  if (channel === CHANNELS.memoryMap.cancel) state.cancel = handler;
} } }));
vi.mock('../../permissions/asrt-sandbox.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../permissions/asrt-sandbox.js')>(),
  getWindowsConfinementRoute: () => [state.account],
  getWindowsAccountConfinementHelperIdentity: () => 'account-helper',
  isOfflineProcessConfinementActive: () => state.account,
  isWindowsBackgroundConfinementRuntimeActive: () => state.account || state.substrate?.shells === 'mxc',
  isWindowsAccountConfinementOperational: async () => state.operational,
  checkAsrtDependencies: async () => ({ errors: [], warnings: [], accountBackendAbsent: !state.account }),
}));
vi.mock('../../permissions/mxc-windows.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../permissions/mxc-windows.js')>(),
  detectHostMxcPrerequisites: async () => ({
    state: 'unavailable', reason: 'container-unavailable', containerBackendAbsent: true, baseContainerApiPresent: false,
  }),
}));
vi.mock('../../permissions/sandbox-capability.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../permissions/sandbox-capability.js')>(),
  getWindowsExtensionBackendPlan: () => state.plan,
  getWindowsSandboxSubstrate: () => state.substrate,
  isSandboxGateUndecidedAtBoot: () => false,
}));
vi.mock('../../permissions/mxc-runtime-root.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../permissions/mxc-runtime-root.js')>(),
  mxcSandboxHomesParent: () => 'C:/example/ave-runtime/homes',
}));
vi.mock('../../shared/ave-home.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../shared/ave-home.js')>(),
  isAveHomePrivacyVerifiedAtBoot: () => true,
}));
vi.mock('../../main/memory-map/worker-client-win32.js', () => ({ runMemoryWorker: state.runWorker }));
vi.mock('../../main/memory-map/model-manager-win32.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../main/memory-map/model-manager-win32.js')>(),
  LocalModelManager: class { async validatedPath() { return state.root; } },
}));
vi.mock('../../main/storage/feature-namespace.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../main/storage/feature-namespace.js')>();
  return { ...actual, openFeatureNamespace: (name: string, root?: string) => {
    if (name !== 'memory-map') return actual.openFeatureNamespace(name, root);
    const handle = actual.openFeatureNamespace(name, state.root);
    return { ...handle,
      readJson: async <T>(name: string, fallback: T) => {
        const saved = await handle.readJson(name, fallback);
        state.afterRead?.();
        return saved;
      },
      childDir: async (name: string) => {
        const path = await handle.childDir(name);
        await state.beforeCommit?.();
        return path;
      },
    };
  } };
});

const HOST_PLATFORM = process.platform;
const roots = createTmpDirTracker();
let unregister: (() => void) | undefined;
afterEach(async () => {
  unregister?.();
  unregister = undefined;
  invalidateWindowsBackendEvidence();
  __resetSandboxHomesUnavailableForTest();
  setProcessPlatform(HOST_PLATFORM);
  await roots.cleanup();
});

describe.each(['container', 'unconfined', 'account', 'projection'] as const)('%s Cancel', route => {
  const outcomes = route === 'projection' ? ['confirmed', 'deadline'] as const : ['confirmed', 'refused', 'deadline'] as const;
  it.each(outcomes)('first, concurrent, and retry replies require this build exit (%s)', async outcome => {
    state.root = roots.track(await mkdtemp(join(tmpdir(), 'memory-map-admission-')));
    setProcessPlatform('win32');
    state.account = route === 'account';
    state.operational = true;
    state.beforeCommit = state.afterRead = undefined;
    const container = route === 'container' || route === 'projection';
    state.plan = container ? { selectedBackend: 'mxc', readiness: 'ready' } : { selectedBackend: 'none', readiness: 'off' };
    state.substrate = container ? { srtWinReady: false, shells: 'mxc', mxc: { state: 'available' } } : {
      srtWinReady: state.account, shells: state.account ? 'approved-host' : 'none',
      ...(route === 'unconfined' ? { accountBackendAbsent: true } : {}),
      mxc: { state: 'unavailable', reason: 'container-unavailable', containerBackendAbsent: true },
    };
    if (route !== 'account') unregister = registerMxcReleaseGateEvidence({
      ownProxySucceeded: true, otherListenerRefused: true, directEgressRefused: true,
      forgedLabelsAttributed: true, noWorkerPort: true, reparseSubstitutionRefused: true,
    });

    const started = deferred<AbortSignal>();
    const stopping = deferred<void>();
    const finishTeardown = deferred<void>();
    let confirmExit: (() => void) | undefined;
    state.runWorker.mockReset().mockImplementation(async (_folder, task, signal, _progress, _admission, exit) => {
      exit?.starting?.();
      if (route === 'projection' && task.kind === 'embed-batch') {
        exit?.confirmed();
        return task.texts.map(() => [1, ...Array<number>(383).fill(0)]);
      }
      if (route === 'projection') expect(task.kind).toBe('project');
      confirmExit = exit?.confirmed;
      signal.addEventListener('abort', () => stopping.resolve(), { once: true });
      started.resolve(signal);
      await finishTeardown.promise;
      if (outcome === 'refused') throw route === 'container' ? new MxcProcessCleanupError('Tree exit unconfirmed') : new ManagedExitUnconfirmedError();
      confirmExit?.();
      signal.throwIfAborted();
    });
    const note = { id: '11111111-1111-4111-8111-111111111111', filename: 'example.md', title: 'Example', content: 'Memory' };
    registerWindowsMemoryMapHandlers({
      auditLogger: { log: vi.fn() },
      settingsService: { get: (key: string) => key === 'memoryEmbedding'
        ? { localModelPath: state.root, localInferenceWithoutSandbox: true } : undefined },
      memoryManager: { readMemoryPanelCatalog: () => ({ notes: [note] }) },
    } as unknown as IpcDeps, () => ({ ok: true, options: {} }));
    const event = { senderFrame: { url: 'file:///app/index.html' }, sender: { send: vi.fn(), isDestroyed: () => false } } as unknown as IpcMainInvokeEvent;
    if (!state.handle || !state.cancel) throw new Error('Memory-map IPC is not registered');

    const buildId = randomUUID();
    const build = state.handle(event, { buildId });
    const cancel = state.cancel;
    try {
      const signal = await Promise.race([started.promise, build.then(() => { throw new Error('Worker did not start'); })]);
      expect(await state.get?.(event)).toMatchObject({ ok: true, value: { status: 'building', snapshotId: buildId } });
      if (outcome === 'deadline') vi.useFakeTimers();
      const replied = vi.fn();
      const firstCancel = cancel(event, buildId).then(replied);
      const secondCancel = cancel(event, buildId).then(replied);
      await stopping.promise;
      if (outcome === 'deadline') await vi.advanceTimersByTimeAsync(0);
      else await new Promise<void>(resolve => setImmediate(resolve));
      expect.soft(signal.aborted).toBe(true);
      expect.soft(replied).not.toHaveBeenCalled();

      if (outcome === 'deadline') {
        await vi.advanceTimersByTimeAsync(TOOL_TIMEOUT_POLICY.windowsMemoryBuildCancelMs);
        expect.soft(replied).toHaveBeenCalledTimes(2);
        if (replied.mock.calls.length !== 2) return;
      } else {
        finishTeardown.resolve();
        expect(await build).toMatchObject({ ok: false });
      }
      await Promise.all([firstCancel, secondCancel]);
      const reply = outcome === 'confirmed' ? { ok: true, value: null } : { ok: false, error: 'build-exit-unconfirmed' };
      expect.soft(replied.mock.calls).toEqual([[reply], [reply]]);
      expect.soft(await cancel(event, buildId)).toEqual(reply);
      if (outcome === 'deadline') {
        finishTeardown.resolve();
        expect(await build).toMatchObject({ ok: false });
        expect(await cancel(event, buildId)).toEqual({ ok: true, value: null });
      } else if (outcome === 'refused' && route === 'unconfined') {
        confirmExit?.();
        expect(await cancel(event, buildId)).toEqual({ ok: true, value: null });
      } else if (outcome === 'refused' && route === 'account') {
        const nextId = randomUUID();
        const nextStarted = deferred<void>();
        const nextExit = deferred<void>();
        const nextReply = vi.fn((reply: unknown) => reply);
        state.runWorker.mockImplementationOnce(async (_folder, _task, signal, _progress, _admission, exit) => {
          exit?.starting();
          nextStarted.resolve();
          await nextExit.promise;
          exit?.confirmed();
          signal.throwIfAborted();
        });
        const nextBuild = state.handle(event, { buildId: nextId });
        try {
          await Promise.race([nextStarted.promise, nextBuild.then(() => { throw new Error('Second worker did not start'); })]);
          const nextCancel = cancel(event, nextId).then(nextReply);
          await new Promise<void>(resolve => setImmediate(resolve));
          expect(nextReply).not.toHaveBeenCalled();
          nextExit.resolve();
          expect(await nextCancel).toEqual({ ok: true, value: null });
          expect(await cancel(event, nextId)).toEqual({ ok: true, value: null });
          expect(await cancel(event, buildId)).toEqual(reply);
        } finally {
          nextExit.resolve();
          await nextBuild;
        }
      }
    } finally {
      finishTeardown.resolve();
      await build;
      vi.useRealTimers();
    }
  });
});

it('keeps the live projection cancellable when a replacement catalog scan fails', async () => {
  state.root = roots.track(await mkdtemp(join(tmpdir(), 'memory-map-admission-')));
  setProcessPlatform('win32');
  state.account = false;
  state.plan = { selectedBackend: 'mxc', readiness: 'ready' };
  state.substrate = { srtWinReady: false, shells: 'mxc', mxc: { state: 'available' } };
  state.beforeCommit = state.afterRead = undefined;

  unregister = registerMxcReleaseGateEvidence({
    ownProxySucceeded: true, otherListenerRefused: true, directEgressRefused: true,
    forgedLabelsAttributed: true, noWorkerPort: true, reparseSubstitutionRefused: true,
  });

  const projecting = deferred<AbortSignal>();
  const finishTeardown = deferred<void>();
  state.runWorker.mockReset().mockImplementation(async (_folder, task, signal, _progress, _admission, exit) => {
    exit?.starting();
    if (task.kind === 'embed-batch') {
      exit?.confirmed();
      return task.texts.map(() => [1, ...Array<number>(383).fill(0)]);
    }
    if (task.kind !== 'project') throw new Error('Expected projection');
    projecting.resolve(signal);
    await finishTeardown.promise;
    exit?.confirmed();
    signal.throwIfAborted();
    return buildGraph(task.input, {
      embed: async () => { throw new Error('Projection requires cached vectors'); },
      dispose: async () => {},
    }, () => {});
  });
  const note = { id: randomUUID(), filename: 'example.md', title: 'Example', content: 'Memory' };
  const readCatalog = vi.fn(() => ({ notes: [note] }));
  registerWindowsMemoryMapHandlers({
    auditLogger: { log: vi.fn() },
    settingsService: { get: (key: string) => key === 'memoryEmbedding' ? { localModelPath: state.root } : undefined },
    memoryManager: { readMemoryPanelCatalog: readCatalog },
  } as unknown as IpcDeps, () => ({ ok: true, options: {} }));
  const event = { senderFrame: { url: 'file:///app/index.html' }, sender: { send: vi.fn(), isDestroyed: () => false } } as unknown as IpcMainInvokeEvent;
  if (!state.handle || !state.cancel || !state.get) throw new Error('Memory-map IPC is not registered');

  const firstId = randomUUID();
  const secondId = randomUUID();
  const build = state.handle(event, { buildId: firstId });
  try {
    const signal = await Promise.race([projecting.promise, build.then(() => { throw new Error('Projection did not start'); })]);
    readCatalog.mockImplementationOnce(() => { throw Object.assign(new Error('Cannot read catalog'), { code: 'EACCES' }); });
    expect(await state.handle(event, { buildId: secondId })).toEqual({ ok: false, error: 'graph-build-failed' });
    expect(await state.get(event)).toMatchObject({ ok: true, value: { status: 'building', snapshotId: firstId } });
    expect(await state.cancel(event, secondId)).toEqual({ ok: true, value: null });
    expect(signal.aborted).toBe(false);

    const replied = vi.fn((reply: unknown) => reply);
    const canceled = state.cancel(event, firstId).then(replied);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect.soft(signal.aborted).toBe(true);
    expect(replied).not.toHaveBeenCalled();
    finishTeardown.resolve();
    expect(await canceled).toEqual({ ok: true, value: null });
    expect(await build).toEqual({ ok: false, error: 'request-stale' });
    expect(await state.get(event)).toEqual({ ok: true, value: null });
  } finally {
    finishTeardown.resolve();
    await build;
  }
});

describe.each(['account', 'container'] as const)('%s admission', backend => {
  describe.each([backend, 'sandbox home'] as const)('%s proof', proof => it.each(['before projection', 'during projection', 'before atomic commit'] as const)(
    `refuses a cached IPC build on ${proof} proof loss %s`, async boundary => {
      const loseProof = () => {
        if (proof === 'sandbox home') markSandboxHomesUnavailable();
        else if (proof === 'container') unregister?.();
        else state.operational = false;
      };
      state.root = roots.track(await mkdtemp(join(tmpdir(), 'memory-map-admission-')));
      setProcessPlatform('win32');
      state.account = backend === 'account';
      state.operational = true;
      state.beforeCommit = state.afterRead = undefined;
      state.plan = state.account ? { selectedBackend: 'none', readiness: 'off' } : { selectedBackend: 'mxc', readiness: 'ready' };
      state.substrate = state.account ? { srtWinReady: true, shells: 'approved-host', mxc: { state: 'unavailable', reason: 'container-unavailable' } }
        : { srtWinReady: false, shells: 'mxc', mxc: { state: 'available' } };
      if (!state.account) unregister = registerMxcReleaseGateEvidence({
        ownProxySucceeded: true, otherListenerRefused: true, directEgressRefused: true,
        forgedLabelsAttributed: true, noWorkerPort: true, reparseSubstitutionRefused: true,
      });
      const projected = deferred<void>();
      const release = deferred<void>();
      let hold = false;
      state.runWorker.mockReset().mockImplementation(async (_folder, task) => {
        if (task.kind === 'embed-batch') return task.texts.map(() => [1, ...Array<number>(383).fill(0)]);
        if (task.kind !== 'project') throw new Error('Unexpected inference task');
        if (hold) { projected.resolve(); await release.promise; }
        return buildGraph(task.input, {
          embed: async () => { throw new Error('Projection requires cached vectors'); }, dispose: async () => {},
        }, () => {});
      });
      const note = { id: '11111111-1111-4111-8111-111111111111', filename: 'example.md', title: 'Example', content: 'Memory' };
      registerWindowsMemoryMapHandlers({
        auditLogger: { log: vi.fn() },
        settingsService: { get: (key: string) => key === 'memoryEmbedding' ? { localModelPath: state.root } : undefined },
        memoryManager: { readMemoryPanelCatalog: () => ({ notes: [note] }) },
      } as unknown as IpcDeps, () => ({ ok: true, options: {} }));
      const event = { senderFrame: { url: 'file:///app/index.html' }, sender: { send: vi.fn(), isDestroyed: () => false } } as unknown as IpcMainInvokeEvent;
      const handle = state.handle;
      if (handle === undefined) throw new Error('Memory-map build IPC is not registered');
      const build = () => handle(event, { buildId: randomUUID() });
      expect(await build()).toMatchObject({ ok: true, value: { status: 'ready' } });
      const path = join(state.root, 'memory-map', 'snapshot.json');
      const previous = await readFile(path);
      state.runWorker.mockClear();
      hold = boundary === 'during projection';
      if (boundary === 'before projection') state.afterRead = loseProof;
      if (boundary === 'before atomic commit') state.beforeCommit = async () => {
        loseProof();
        await localRuntime.refreshLocalInferenceAdmission();
      };

      const result = build();
      if (hold) {
        await Promise.race([projected.promise, result]);
        loseProof();
        release.resolve();
      }
      expect.soft(await result).toEqual({ ok: false, error: 'local-runtime-unavailable' });
      expect.soft(state.runWorker.mock.calls.map(([, task]) => task.kind)).toEqual(boundary === 'before projection' ? [] : ['project']);
      expect(await readFile(path)).toEqual(previous);
    },
  ));
});
