import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import type { MemoryMapProgress } from '../../shared/memory-map.js';
import { mainDir } from '../main-paths.js';
import type { MemoryWorkerTask } from './worker-client.js';
import { runInferenceChild } from './inference-child-win32.js';
import type { BeginMemoryWorker } from './build-registry-win32.js';

export type OnInferenceAdmission = (assertStillValid: () => void) => void;
export type MemoryWorkerRunner = <T>(folder: string, task: MemoryWorkerTask, signal: AbortSignal,
  onProgress?: (progress: MemoryMapProgress) => void, onAdmission?: OnInferenceAdmission, beginWorker?: BeginMemoryWorker) => Promise<T>;

function runProjectionWorker<T>(task: Extract<MemoryWorkerTask, { kind: 'project' }>, signal: AbortSignal,
  onProgress?: (progress: MemoryMapProgress) => void, beginWorker?: BeginMemoryWorker): Promise<T> {
  const exit = beginWorker?.('projection');
  let worker: Worker;
  try { worker = new Worker(join(mainDir, 'memory-map-worker.js'), { workerData: { task } }); }
  catch (error) { exit?.confirmed(); throw error; }
  return new Promise<T>((resolve, reject) => {
    let outcome: { error: Error } | { value: T } | undefined;
    const finish = (result: NonNullable<typeof outcome>) => {
      if (outcome) return;
      outcome = result;
      void worker.terminate().catch((error: unknown) => {
        outcome = { error: error instanceof Error ? error : new Error('Memory worker termination failed') };
      });
    };
    const abort = () => finish({ error: new Error('Memory worker cancelled') });
    worker.on('message', message => {
      if (outcome) return;
      if (message.kind === 'progress') onProgress?.(message.progress);
      else if (message.kind === 'result') finish({ value: message.value as T });
      else finish({ error: new Error('Memory worker failed') });
    });
    worker.on('error', error => finish({ error: error instanceof Error ? error : new Error('Memory worker failed') }));
    worker.once('exit', () => {
      exit?.confirmed();
      signal.removeEventListener('abort', abort);
      outcome ??= { error: new Error('Memory worker exited before completion') };
      if ('error' in outcome) reject(outcome.error);
      else resolve(outcome.value);
    });
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}

export const runMemoryWorker = async <T>(folder: string, task: MemoryWorkerTask, signal: AbortSignal,
  onProgress?: (progress: MemoryMapProgress) => void, onAdmission?: OnInferenceAdmission, beginWorker?: BeginMemoryWorker,
  readLocalInferencePreference?: () => boolean): Promise<T> => {
  signal.throwIfAborted();
  if (task.kind === 'project') return runProjectionWorker<T>(task, signal, onProgress, beginWorker);
  return runInferenceChild<T>(folder, task, signal, onProgress, readLocalInferencePreference, onAdmission, beginWorker);
};
