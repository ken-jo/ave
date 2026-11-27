import type { MemoryMapProgress } from '../../shared/memory-map.js';
import { runMemoryWorker as runProjectionWorker, type MemoryWorkerTask } from './worker-client.js';
import { runInferenceChild } from './inference-child-win32.js';

export type OnInferenceAdmission = (assertStillValid: () => void) => void;
export type MemoryWorkerRunner = <T>(folder: string, task: MemoryWorkerTask, signal: AbortSignal,
  onProgress?: (progress: MemoryMapProgress) => void, onAdmission?: OnInferenceAdmission) => Promise<T>;
export const runMemoryWorker = async <T>(folder: string, task: MemoryWorkerTask, signal: AbortSignal,
  onProgress?: (progress: MemoryMapProgress) => void, onAdmission?: OnInferenceAdmission, readLocalInferencePreference?: () => boolean): Promise<T> => {
  signal.throwIfAborted();
  if (task.kind === 'project') return runProjectionWorker<T>(folder, task, signal, onProgress);
  return runInferenceChild<T>(folder, task, signal, onProgress, readLocalInferencePreference, onAdmission);
};
