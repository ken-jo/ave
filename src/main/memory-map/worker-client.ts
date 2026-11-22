import { Worker } from 'node:worker_threads';
import { join } from 'node:path';
import { mainDir } from '../main-paths.js';
import { assertLocalEmbeddingRuntime } from './local-runtime.js';
import type { MemoryMapProgress } from '../../shared/memory-map.js';
import type { GraphBuildInput } from './graph.js';
export type MemoryWorkerTask = { kind: 'build' | 'project'; input: GraphBuildInput } | { kind: 'embed'; text: string };
export type MemoryWorkerRunner = <T>(folder: string, task: MemoryWorkerTask, signal: AbortSignal, onProgress?: (progress: MemoryMapProgress) => void) => Promise<T>;
export const runMemoryWorker: MemoryWorkerRunner = async <T>(folder: string, task: MemoryWorkerTask, signal: AbortSignal, onProgress?: (progress: MemoryMapProgress) => void): Promise<T> => {
  signal.throwIfAborted();
  if (task.kind !== 'project') assertLocalEmbeddingRuntime();
  const entry = join(mainDir, 'memory-map-worker.js');
  const worker = new Worker(entry, { workerData: { folder, task }, env: { ...process.env, ORT_DISABLE_TELEMETRY: '1' } });
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, result?: T) => {
      if (settled) return; settled = true;
      signal.removeEventListener('abort', abort); void worker.terminate();
      if (error) reject(error); else resolve(result!);
    };
    const abort = () => finish(new Error('Memory worker cancelled'));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    worker.on('message', message => {
      if (settled) return;
      if (message.kind === 'progress') onProgress?.(message.progress);
      else if (message.kind === 'result') finish(undefined, message.value as T);
      else finish(new Error('Memory worker failed'));
    });
    worker.on('error', error => finish(error instanceof Error ? error : new Error('Memory worker failed')));
    worker.on('exit', () => finish(new Error('Memory worker exited before completion')));
  });
};
