import { vi } from 'vitest';
import type { MemoryMapApi } from '../../shared/memory-map.js';

export function createMemoryMapApi() {
  return {
    get: vi.fn<MemoryMapApi['get']>().mockResolvedValue({ ok: true, value: null }),
    build: vi.fn<MemoryMapApi['build']>().mockResolvedValue({ ok: false, error: 'graph-build-failed' }),
    cancel: vi.fn<MemoryMapApi['cancel']>().mockResolvedValue({ ok: true, value: null }),
    facets: vi.fn<MemoryMapApi['facets']>().mockResolvedValue({ ok: true, value: { sources: [], projects: [], playbooks: [] } }),
    retrieve: vi.fn<MemoryMapApi['retrieve']>().mockResolvedValue({ ok: false, error: 'graph-unavailable' }),
    modelStatus: vi.fn<MemoryMapApi['modelStatus']>().mockResolvedValue({ ok: true, value: { status: 'unconfigured', receivedBytes: 0, totalBytes: 135430650, completedFiles: 0, totalFiles: 4 } }),
    modelDownload: vi.fn<MemoryMapApi['modelDownload']>().mockResolvedValue({ ok: false, error: 'model-download-failed' }),
    modelCancel: vi.fn<MemoryMapApi['modelCancel']>().mockResolvedValue({ ok: true, value: null }),
    modelUseExisting: vi.fn<MemoryMapApi['modelUseExisting']>().mockResolvedValue({ ok: false, error: 'model-folder-invalid' }),
    settingsGet: vi.fn<MemoryMapApi['settingsGet']>().mockResolvedValue({ ok: true, value: { source: 'local', providerAvailable: false, providers: [], namespace: { source: 'local', modelId: 'local', modelRevision: 'revision-1', preprocessingRevision: 'v1', dimensions: 384 } } }),
    settingsSet: vi.fn<MemoryMapApi['settingsSet']>().mockResolvedValue({ ok: false, error: 'provider-unavailable' }),
    onProgress: vi.fn<MemoryMapApi['onProgress']>().mockReturnValue(vi.fn()),
    onModelProgress: vi.fn<MemoryMapApi['onModelProgress']>().mockReturnValue(vi.fn()),
  };
}
