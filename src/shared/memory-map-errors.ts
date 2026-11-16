import type { MemoryMapError } from './memory-map.js';
import type { MessageCatalogKey } from '../i18n/messages/en.js';
export const MEMORY_MAP_ERROR_KEYS = {
  'invalid-input': 'memoryMap.error.invalid-input',
  'project-not-allowed': 'memoryMap.error.project-not-allowed',
  'model-unconfigured': 'memoryMap.error.model-unconfigured',
  'model-integrity-failed': 'memoryMap.error.model-integrity-failed',
  'graph-unavailable': 'memoryMap.error.graph-unavailable',
  'graph-stale': 'memoryMap.error.graph-stale',
  'graph-build-failed': 'memoryMap.error.graph-build-failed',
  'request-stale': 'memoryMap.error.request-stale',
  'provider-unavailable': 'memoryMap.error.provider-unavailable',
  'model-download-failed': 'memoryMap.error.model-download-failed',
  'model-folder-invalid': 'memoryMap.error.model-folder-invalid',
  'model-cancelled': 'memoryMap.error.model-cancelled',
  'unauthorized-frame': 'memoryMap.error.unauthorized-frame',
} as const satisfies Record<MemoryMapError, MessageCatalogKey>;
