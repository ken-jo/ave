import { MemoryMapHostError } from './errors.js';
import { MODEL_FILES } from './model-manifest.js';

// The prefix carries four big-endian uint32 lengths: task JSON and the three inference files.
export const INFERENCE_PREFIX_BYTES = 16;
export const INFERENCE_FILES = MODEL_FILES.slice(0, 3);
const MAX_TASK_BYTES = 32 * 1024 * 1024;
const MAX_FRAME_BYTES = INFERENCE_PREFIX_BYTES + MAX_TASK_BYTES + INFERENCE_FILES.reduce((sum, file) => sum + file.bytes, 0);

export function checkedInferenceFrameBytes(lengths: readonly number[]): number {
  const [taskBytes, ...fileBytes] = lengths;
  const total = lengths.reduce((sum, bytes) => sum + bytes, INFERENCE_PREFIX_BYTES);
  if (fileBytes.length !== INFERENCE_FILES.length || INFERENCE_FILES.some((file, index) => file.bytes !== fileBytes[index])) {
    throw new MemoryMapHostError('model-integrity-failed');
  }
  if (!Number.isInteger(taskBytes) || taskBytes <= 0 || taskBytes > MAX_TASK_BYTES || total > MAX_FRAME_BYTES) {
    throw new MemoryMapHostError('invalid-input');
  }
  return total;
}
