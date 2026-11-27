import { Worker } from 'node:worker_threads';
import { join } from 'node:path';
import { mainDir } from '../main-paths.js';
import { runInferenceChild } from './inference-child.js';
import type { MemoryMapProgress } from '../../shared/memory-map.js';
import type { GraphBuildInput } from './graph.js';
export type MemoryInferenceTask = { kind: 'embed-batch'; texts: string[]; jobId: string } | { kind: 'embed'; text: string };
export type MemoryWorkerTask = MemoryInferenceTask | { kind: 'project'; input: GraphBuildInput };
export type MemoryWorkerRunner = <T>(folder: string, task: MemoryWorkerTask, signal: AbortSignal, onProgress?: (progress: MemoryMapProgress) => void) => Promise<T>;
export const runMemoryWorker: MemoryWorkerRunner = async <T>(folder: string, task: MemoryWorkerTask, signal: AbortSignal, onProgress?: (progress: MemoryMapProgress) => void): Promise<T> => {
  signal.throwIfAborted();
  // The local model loads only in the network-confined child; this thread projects cached vectors.
  if (task.kind !== 'project') return runInferenceChild<T>(folder, task, signal, onProgress);
  const entry = join(mainDir, 'memory-map-worker.js');
  const worker = new Worker(entry, { workerData: { task } });
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (...[error, result]: [error: Error] | [error: undefined, result: T]) => {
      if (settled) return; settled = true;
      signal.removeEventListener('abort', abort); void worker.terminate();
      if (error === undefined) resolve(result); else reject(error);
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
