import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
const state = vi.hoisted(() => ({ mainDir: '', threads: 0, spawns: 0 }));
vi.mock('../../main-paths.js', () => ({ get mainDir() { return state.mainDir; } }));
vi.mock('node:worker_threads', async importOriginal => {
  const actual = await importOriginal<typeof import('node:worker_threads')>();
  return { ...actual, Worker: class extends actual.Worker { constructor(...args: ConstructorParameters<typeof actual.Worker>) { state.threads++; super(...args); } } };
});
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: (...args: Parameters<typeof actual.spawn>) => { state.spawns++; return actual.spawn(...args); } };
});
import { runMemoryWorker } from '../worker-client.js';
import { LOCAL_NAMESPACE } from '../graph.js';
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
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
