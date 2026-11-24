import type { MemoryMapError } from '../../shared/memory-map.js';
export class MemoryMapHostError extends Error {
  constructor(readonly code: MemoryMapError) { super(code); this.name = 'MemoryMapHostError'; }
}
