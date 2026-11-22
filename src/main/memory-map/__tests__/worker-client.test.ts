import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
const state = vi.hoisted(() => ({ mainDir: '' }));
vi.mock('../../main-paths.js', () => ({ get mainDir() { return state.mainDir; } }));
import { runMemoryWorker } from '../worker-client.js';
import { LOCAL_NAMESPACE } from '../graph.js';
describe('memory worker lifecycle', () => {
  it('refuses the unqualified Windows runtime before starting a local embedding worker', async () => {
    const root = await mkdtemp(join(tmpdir(), 'memory-worker-'));
    state.mainDir = root;
    const platform = Object.getOwnPropertyDescriptor(process, 'platform');
    if (!platform) throw new Error('Missing platform descriptor');
    try {
      Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
      await writeFile(join(root, 'memory-map-worker.js'), `require('node:worker_threads').parentPort.postMessage({ kind: 'result', value: 'started' });`);
      await expect(runMemoryWorker(root, { kind: 'embed', text: 'question' }, new AbortController().signal))
        .rejects.toMatchObject({ code: 'local-runtime-unavailable' });
    } finally {
      Object.defineProperty(process, 'platform', platform);
      await rm(root, { recursive: true, force: true });
    }
  });
  it('keeps projection available, forwards counts and terminates cancelled workers', async () => {
    const root = await mkdtemp(join(tmpdir(), 'memory-worker-')); state.mainDir = root;
    try {
      await writeFile(join(root, 'memory-map-worker.js'), `const { parentPort, workerData } = require('node:worker_threads');
        if (workerData.task.input.jobId === 'wait') { setInterval(() => {}, 1000); }
        else { parentPort.postMessage({ kind: 'progress', progress: { jobId: 'job', phase: 'embedding', completed: 1, total: 1 } }); parentPort.postMessage({ kind: 'result', value: process.env.ORT_DISABLE_TELEMETRY }); }`);
      const callback = vi.fn();
      const input = { jobId: 'job', records: [], cache: {}, excluded: 0, authorizationScopeId: 'scope', namespace: LOCAL_NAMESPACE };
      expect(await runMemoryWorker(root, { kind: 'project', input }, new AbortController().signal, callback)).toBe('1');
      expect(callback).toHaveBeenCalledOnce();
      const controller = new AbortController(); const pending = runMemoryWorker(root, { kind: 'project', input: { ...input, jobId: 'wait' } }, controller.signal); controller.abort();
      await expect(pending).rejects.toThrow('cancelled');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
