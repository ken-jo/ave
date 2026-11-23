import { describe, it, expect, vi } from 'vitest';
import { readGraphCatalog, memoryFacets } from '../catalog.js';
import type { MemoryManager } from '../../../memory/memory-manager.js';
import { normalizeMemoryEmbeddingConfig } from '../../../shared/memory-embedding-config.js';
import { MEMORY_MAP_ERROR_KEYS } from '../../../shared/memory-map-errors.js';
import { en } from '../../../i18n/messages/en.js';
import { ko } from '../../../i18n/messages/ko.js';
describe('memory map catalog boundary', () => {
  it('uses only the existing authorized catalog and excludes unmanaged and isolated records', () => {
    const reader = vi.fn(() => ({ notes: [
      { id: 'active', title: 'Title', content: 'Body', state: 'active', source: 'user' },
      { title: 'Instruction index', content: 'Index' },
      { id: 'child', title: 'Isolated', content: 'Body', origin: { store: 'subagent' } },
      { id: 'discarded', title: 'Discarded', content: 'Body', state: 'discarded' },
      { id: 'legacy', title: 'Legacy', content: 'Legacy body' },
    ] }));
    const catalog = readGraphCatalog({ readMemoryPanelCatalog: reader } as unknown as MemoryManager, {}, '/workspace/default');
    expect(reader).toHaveBeenCalledExactlyOnceWith({}, '/workspace/default');
    expect(catalog.records.map(r => r.memoryId)).toEqual(['active','legacy']); expect(catalog.excluded).toBe(3);
    expect(memoryFacets(catalog.records)).toEqual({ sources: [{ sourceKind: 'user', count: 1 }, { sourceKind: 'unknown', count: 1 }], projects: [], playbooks: [] });
  });
  it('keeps model settings narrow and has every error key in both locales', () => {
    expect(normalizeMemoryEmbeddingConfig({ localModelPath: '/example/model' })).toEqual({ localModelPath: '/example/model' });
    expect(normalizeMemoryEmbeddingConfig({ localModelPath: '/example/model', source: 'provider' })).toBeUndefined();
    expect(normalizeMemoryEmbeddingConfig({ localModelPath: 5 })).toBeUndefined();
    const selection = { source: 'provider', providerId: 'configured', modelId: 'embed', localModelPath: 'models/example' };
    const consent = { version: 2, endpointId: 'a'.repeat(64), providerId: 'configured', modelId: 'embed', timestamp: '2026-11-16T00:00:00.000Z' };
    expect(normalizeMemoryEmbeddingConfig({ ...selection, consent })).toEqual({ ...selection, consent });
    expect(normalizeMemoryEmbeddingConfig({ ...selection, consent: { ...consent, version: 1 } })).toEqual(selection);
    for (const key of Object.values(MEMORY_MAP_ERROR_KEYS)) { expect(en[key]).toBeTruthy(); expect(ko[key]).toBeTruthy(); }
  });
});
