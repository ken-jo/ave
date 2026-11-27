import { EventEmitter } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
const state = vi.hoisted(() => ({ mainDir: '', threads: 0, spawns: 0, projectionWorker: undefined as EventEmitter | undefined }));
vi.mock('../../main-paths.js', () => ({ get mainDir() { return state.mainDir; } }));
vi.mock('node:worker_threads', async importOriginal => {
  const actual = await importOriginal<typeof import('node:worker_threads')>();
  return { ...actual, Worker: new Proxy(actual.Worker, {
    construct(target, args: ConstructorParameters<typeof actual.Worker>) {
      state.threads++;
      return state.projectionWorker ?? new target(...args);
    },
  }) };
});
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: (...args: Parameters<typeof actual.spawn>) => { state.spawns++; return actual.spawn(...args); } };
});
import { runMemoryWorker } from '../worker-client.js';
import { runMemoryWorker as runWindowsMemoryWorker } from '../worker-client-win32.js';
import { BuildRegistry } from '../build-registry-win32.js';
import { LOCAL_NAMESPACE } from '../graph.js';
import { TOOL_TIMEOUT_POLICY } from '../../../shared/tool-timeout-policy.js';
describe('memory worker lifecycle', () => {
  it.each(['embed', 'embed-batch'] as const)('refuses %s without the OS sandbox and starts neither a thread nor a process', async kind => {
    const root = await mkdtemp(join(tmpdir(), 'memory-worker-'));
    state.mainDir = root; state.threads = 0; state.spawns = 0;
    try {
      // A stand-in at both entries: whichever one a fallback reached would answer.
      await writeFile(join(root, 'memory-map-worker.js'), `require('node:worker_threads').parentPort.postMessage({ kind: 'result', value: 'in-process' });`);
      await writeFile(join(root, 'memory-map-child.js'), `process.stdout.write(JSON.stringify({ kind: 'result', value: 'unconfined' }) + '\\n');`);
      const task = kind === 'embed' ? { kind, text: 'question' } : { kind, texts: ['note'], jobId: 'job' };
      await expect(runMemoryWorker(root, task, new AbortController().signal)).rejects.toMatchObject({ code: 'local-runtime-unavailable' });
      expect(state.threads).toBe(0);
      expect(state.spawns).toBe(0);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('keeps projection available, forwards counts and terminates cancelled workers', async () => {
    const root = await mkdtemp(join(tmpdir(), 'memory-worker-')); state.mainDir = root;
    try {
      await writeFile(join(root, 'memory-map-worker.js'), `const { parentPort, workerData } = require('node:worker_threads');
        if (workerData.task.input.jobId === 'wait') { setInterval(() => {}, 1000); }
        else { parentPort.postMessage({ kind: 'progress', progress: { jobId: 'job', phase: 'embedding', completed: 1, total: 1 } }); parentPort.postMessage({ kind: 'result', value: workerData.task.kind }); }`);
      const callback = vi.fn();
      const input = { jobId: 'job', records: [], cache: {}, excluded: 0, authorizationScopeId: 'scope', namespace: LOCAL_NAMESPACE };
      expect(await runMemoryWorker(root, { kind: 'project', input }, new AbortController().signal, callback)).toBe('project');
      expect(callback).toHaveBeenCalledOnce();
      const controller = new AbortController(); const pending = runMemoryWorker(root, { kind: 'project', input: { ...input, jobId: 'wait' } }, controller.signal); controller.abort();
      await expect(pending).rejects.toThrow('cancelled');
      const windowsController = new AbortController();
      const exit = { confirmed: vi.fn(), lost: vi.fn() };
      const beginWorker = vi.fn(() => exit);
      const windowsPending = runWindowsMemoryWorker(root, { kind: 'project', input: { ...input, jobId: 'wait' } },
        windowsController.signal, undefined, undefined, beginWorker);
      expect(beginWorker).toHaveBeenCalledExactlyOnceWith('projection');
      expect(exit.confirmed).not.toHaveBeenCalled();
      windowsController.abort();
      await expect(windowsPending).rejects.toThrow('cancelled');
      expect(exit.confirmed).toHaveBeenCalledOnce();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.each([
    { trigger: 'cancel', receipt: 'before deadline' },
    { trigger: 'cancel', receipt: 'after deadline' },
    { trigger: 'result', receipt: 'after deadline' },
    { trigger: 'termination refusal', receipt: 'after deadline' },
  ] as const)('requires the Windows projection exit event with $trigger and receipt $receipt', async ({ trigger, receipt }) => {
    const worker = Object.assign(new EventEmitter(), { terminate: vi.fn(async () => 0) });
    const terminationError = new Error('Termination request failed');
    if (trigger === 'termination refusal') worker.terminate.mockRejectedValue(terminationError);
    state.projectionWorker = worker;
    vi.useFakeTimers();
    try {
      const registry = new BuildRegistry();
      const owner = registry.register('job', { scopeId: 'scope', assertAdmitted: () => {} });
      owner.takeover(() => {});
      const input = { jobId: 'job', records: [], cache: {}, excluded: 0, authorizationScopeId: 'scope', namespace: LOCAL_NAMESPACE };
      const finished = vi.fn();
      const pending = runWindowsMemoryWorker('', { kind: 'project', input }, owner.signal, undefined, undefined, owner.beginWorker).then(finished, finished);
      if (trigger === 'result') worker.emit('message', { kind: 'result', value: 'projected' });
      owner.stop('user');
      const replied = vi.fn();
      const firstCancel = owner.waitForExit().then(replied);
      const concurrentCancel = owner.waitForExit().then(replied);
      const deadline = TOOL_TIMEOUT_POLICY.windowsMemoryBuildCancelMs;
      await vi.advanceTimersByTimeAsync(deadline - 1);
      expect(worker.terminate).toHaveBeenCalledOnce();
      expect(finished).not.toHaveBeenCalled();
      expect(replied).not.toHaveBeenCalled();
      if (receipt === 'after deadline') {
        await vi.advanceTimersByTimeAsync(1);
        await Promise.all([firstCancel, concurrentCancel]);
        expect(replied.mock.calls).toEqual([[false], [false]]);
        expect(await owner.waitForExit()).toBe(false);
      }
      worker.emit('exit', 0);
      await Promise.all([pending, firstCancel, concurrentCancel]);
      expect(replied.mock.calls).toEqual(receipt === 'before deadline' ? [[true], [true]] : [[false], [false]]);
      expect(await owner.waitForExit()).toBe(true);
      expect(finished.mock.calls).toEqual([[trigger === 'result' ? 'projected'
        : trigger === 'termination refusal' ? terminationError : new Error('Memory worker cancelled')]]);
    } finally {
      worker.emit('exit', 0);
      state.projectionWorker = undefined;
      vi.useRealTimers();
    }
  });
});
