import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IpcMainInvokeEvent } from 'electron';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { deferred } from '../../__tests__/support/deferred.js';
import { setProcessPlatform } from '../../__tests__/support/process-platform.js';
import { createTmpDirTracker } from '../../__tests__/support/tmp-dir-teardown.js';
import { CHANNELS } from '../../contract/app-contract.js';
import { buildGraph } from '../../main/memory-map/graph.js';
import * as localRuntime from '../../main/memory-map/local-runtime-win32.js';
import type { MemoryWorkerTask } from '../../main/memory-map/worker-client.js';
import { registerMxcReleaseGateEvidence } from '../../permissions/mxc-extension-admission.js';
import { __resetSandboxHomesUnavailableForTest, markSandboxHomesUnavailable } from '../../permissions/sandbox-capability.js';
import { invalidateWindowsBackendEvidence } from '../../permissions/windows-confinement-evidence.js';
import type { SandboxWindowsExtensionPlan, SandboxWindowsSubstrateInfo } from '../../shared/sandbox-capability-info.js';
import { registerWindowsMemoryMapHandlers } from '../domains/memory-map-win32.js';
import type { IpcDeps } from '../types.js';

const state = vi.hoisted(() => ({
  root: '',
  account: false,
  operational: true,
  plan: undefined as Partial<SandboxWindowsExtensionPlan> | undefined,
  substrate: null as Partial<SandboxWindowsSubstrateInfo> | null,
  handle: undefined as ((event: IpcMainInvokeEvent) => Promise<unknown>) | undefined,
  runWorker: vi.fn<(folder: string, task: MemoryWorkerTask) => Promise<unknown>>(),
  beforeCommit: undefined as (() => Promise<unknown>) | undefined,
  afterRead: undefined as (() => void) | undefined,
}));
vi.mock('electron', () => ({ dialog: {}, ipcMain: { handle: (channel: string, handler: typeof state.handle) => {
  if (channel === CHANNELS.memoryMap.build) state.handle = handler;
} } }));
vi.mock('../../permissions/asrt-sandbox.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../permissions/asrt-sandbox.js')>(),
  getWindowsConfinementRoute: () => [state.account],
  getWindowsAccountConfinementHelperIdentity: () => 'account-helper',
  isOfflineProcessConfinementActive: () => state.account,
  isWindowsAccountConfinementOperational: async () => state.operational,
}));
vi.mock('../../permissions/sandbox-capability.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../permissions/sandbox-capability.js')>(),
  getWindowsExtensionBackendPlan: () => state.plan,
  getWindowsSandboxSubstrate: () => state.substrate,
  isSandboxGateUndecidedAtBoot: () => false,
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
      const build = () => handle(event);
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
