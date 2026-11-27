import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import type { MemoryMapProgress } from '../../shared/memory-map.js';
import { mainDir } from '../main-paths.js';
import type { MemoryWorkerTask } from './worker-client.js';
import { runInferenceChild } from './inference-child-win32.js';
import type { MemoryWorkerExit } from './build-teardown-win32.js';

export type OnInferenceAdmission = (assertStillValid: () => void) => void;
export type MemoryWorkerRunner = <T>(folder: string, task: MemoryWorkerTask, signal: AbortSignal,
  onProgress?: (progress: MemoryMapProgress) => void, onAdmission?: OnInferenceAdmission, exit?: MemoryWorkerExit) => Promise<T>;

function runProjectionWorker<T>(task: Extract<MemoryWorkerTask, { kind: 'project' }>, signal: AbortSignal,
  onProgress?: (progress: MemoryMapProgress) => void, exit?: MemoryWorkerExit): Promise<T> {
  const worker = new Worker(join(mainDir, 'memory-map-worker.js'), { workerData: { task } });
  exit?.starting();
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (...[error, result]: [error: Error] | [error: undefined, result: T]) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      void worker.terminate().then(() => {
        if (error === undefined) resolve(result);
        else reject(error);
      }, reject);
    };
    const abort = () => finish(new Error('Memory worker cancelled'));
    worker.on('message', message => {
      if (settled) return;
      if (message.kind === 'progress') onProgress?.(message.progress);
      else if (message.kind === 'result') finish(undefined, message.value as T);
      else finish(new Error('Memory worker failed'));
    });
    worker.on('error', error => finish(error instanceof Error ? error : new Error('Memory worker failed')));
    worker.once('exit', () => {
      exit?.confirmed();
      finish(new Error('Memory worker exited before completion'));
    });
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}

export const runMemoryWorker = async <T>(folder: string, task: MemoryWorkerTask, signal: AbortSignal,
  onProgress?: (progress: MemoryMapProgress) => void, onAdmission?: OnInferenceAdmission, exit?: MemoryWorkerExit,
  readLocalInferencePreference?: () => boolean): Promise<T> => {
  signal.throwIfAborted();
  if (task.kind === 'project') return runProjectionWorker<T>(task, signal, onProgress, exit);
  return runInferenceChild<T>(folder, task, signal, onProgress, readLocalInferencePreference, onAdmission, exit);
};
