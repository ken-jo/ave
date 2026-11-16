export type MemoryModelError = 'model-download-failed' | 'model-integrity-failed' | 'model-folder-invalid' | 'model-cancelled';
export type MemoryModelStatus = {
  status: 'unconfigured' | 'downloading' | 'ready' | 'failed';
  error?: MemoryModelError;
  receivedBytes: number;
  totalBytes: number;
  completedFiles: number;
  totalFiles: number;
};
