import { MemoryMapHostError } from './errors.js';
import { MODEL_FILES } from './model-manifest.js';

// The prefix carries four big-endian uint32 lengths: task JSON and the three inference files.
export const INFERENCE_PREFIX_BYTES = 16;
export const INFERENCE_FILES = MODEL_FILES.slice(0, 3);
// JSON uses up to six bytes per UTF-16 unit, plus the escaped newline, quotes and comma.
// The budget covers 4,000 managed notes at the 120-unit title and 8,000-unit body limits.
export const MAX_INFERENCE_TASK_BYTES = 80 + 4_000 * (6 * (120 + 8_000) + 5);
const MAX_FRAME_BYTES = INFERENCE_PREFIX_BYTES + MAX_INFERENCE_TASK_BYTES + INFERENCE_FILES.reduce((sum, file) => sum + file.bytes, 0);

export function checkedInferenceFrameBytes(lengths: readonly number[]): number {
  const [taskBytes, ...fileBytes] = lengths;
  const total = lengths.reduce((sum, bytes) => sum + bytes, INFERENCE_PREFIX_BYTES);
  if (fileBytes.length !== INFERENCE_FILES.length || INFERENCE_FILES.some((file, index) => file.bytes !== fileBytes[index])) {
    throw new MemoryMapHostError('model-integrity-failed');
  }
  if (!Number.isInteger(taskBytes) || taskBytes <= 0) {
    throw new MemoryMapHostError('invalid-input');
  }
  if (taskBytes > MAX_INFERENCE_TASK_BYTES || total > MAX_FRAME_BYTES) throw new MemoryMapHostError('catalog-too-large');
  return total;
}
