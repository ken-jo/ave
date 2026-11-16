import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
const state = vi.hoisted(() => ({ mainDir: '' }));
vi.mock('../../main-paths.js', () => ({ get mainDir() { return state.mainDir; } }));
import { runMemoryWorker } from '../worker-client.js';
describe('memory worker lifecycle', () => {
  it('forces telemetry suppression before native loading, forwards counts and terminates cancelled workers', async () => {
    const root = await mkdtemp(join(tmpdir(), 'memory-worker-')); state.mainDir = root;
    const previous = process.env.ORT_DISABLE_TELEMETRY;
    try {
      await writeFile(join(root, 'memory-map-worker.js'), `const { parentPort, workerData } = require('node:worker_threads');
        if (workerData.task.text === 'wait') { setInterval(() => {}, 1000); }
        else { parentPort.postMessage({ kind: 'progress', progress: { jobId: 'job', phase: 'embedding', completed: 1, total: 1 } }); parentPort.postMessage({ kind: 'result', value: process.env.ORT_DISABLE_TELEMETRY }); }`);
      const callback = vi.fn();
      expect(await runMemoryWorker(root, { kind: 'embed', text: 'question' }, new AbortController().signal, callback)).toBe('1');
      expect(process.env.ORT_DISABLE_TELEMETRY).toBe('1'); expect(callback).toHaveBeenCalledOnce();
      const controller = new AbortController(); const pending = runMemoryWorker(root, { kind: 'embed', text: 'wait' }, controller.signal); controller.abort();
      await expect(pending).rejects.toThrow('cancelled');
    } finally { if (previous === undefined) delete process.env.ORT_DISABLE_TELEMETRY; else process.env.ORT_DISABLE_TELEMETRY = previous; await rm(root, { recursive: true, force: true }); }
  });
});
