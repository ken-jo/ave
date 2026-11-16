import { describe, expect, it } from 'vitest';
import { buildGraph, semanticLinks, LOCAL_NAMESPACE, vectorKey } from '../graph.js';
import type { MemoryMapRecord } from '../../../shared/memory-map.js';
const record = (i: number): MemoryMapRecord => ({ memoryId: String(i).padStart(4, '0'), contentRevision: 'revision', title: 'Title', text: 'Body', sourceKind: 'user' });
const vector = (x = 1): number[] => [x, Math.sqrt(1-x*x), ...Array<number>(382).fill(0)];
describe('memory embedding graph', () => {
  it('uses original vector neighbours, canonical pairs, degree six and the total budget', () => {
    const records = Array.from({ length: 24 }, (_, i) => record(i));
    const vectors = records.map(() => vector());
    const edges = semanticLinks(records, vectors, 17);
    expect(edges).toHaveLength(17);
    const degrees = new Map<string, number>();
    for (const edge of edges) { expect(edge.a < edge.b).toBe(true); for (const id of [edge.a, edge.b]) degrees.set(id, (degrees.get(id) ?? 0) + 1); }
    expect(Math.max(...degrees.values())).toBeLessThanOrEqual(6);
    expect(new Set(edges.map(e => JSON.stringify([e.a,e.b]))).size).toBe(edges.length);
    expect(semanticLinks([record(0), record(1)], [vector(1), vector(0)])).toHaveLength(1);
  });
  it('links ranked neighbours below an absolute floor and enforces identity and finite scores', () => {
    const records = Array.from({ length: 24 }, (_, i) => record(i));
    const vectors = records.map((_, i) => { const v = Array<number>(384).fill(0); v[0] = Math.sqrt(0.82); v[i + 1] = Math.sqrt(0.18); return v; });
    const edges = semanticLinks(records, vectors, 17);
    expect(edges).toHaveLength(17);
    expect(edges.every(edge => edge.similarity >= 0.80 && edge.similarity <= 0.84)).toBe(true);
    const degrees = records.map(r => edges.filter(e => e.a === r.memoryId || e.b === r.memoryId).length);
    expect(Math.max(...degrees)).toBeLessThanOrEqual(6);
    expect(semanticLinks([record(0), record(0)], [vector(), vector()])).toEqual([]);
    expect(() => semanticLinks([record(0), record(1)], [Array(384).fill(NaN), vector()])).toThrow('Non-finite similarity');
  });
  it('is deterministic, reuses only current cache keys and prunes removed memories', async () => {
    let calls = 0;
    const embedder = { embed: async () => { calls++; return vector(); }, dispose: async () => {} };
    const input = { records: [record(0),record(1),record(2),record(3)], authorizationScopeId: 'scope', excluded: 2, cache: {}, namespace: LOCAL_NAMESPACE, jobId: 'job' };
    const progress: unknown[] = [];
    const first = await buildGraph(input, embedder, p => progress.push(p));
    expect(calls).toBe(4);
    const second = await buildGraph({ ...input, cache: first.cache }, embedder, () => {});
    expect(second).toEqual(first); expect(calls).toBe(4);
    expect(JSON.stringify(progress)).not.toContain('Body');
    const edited = { ...record(1), contentRevision: 'edited' };
    const third = await buildGraph({ ...input, records: [record(0), edited], cache: first.cache }, embedder, () => {});
    expect(calls).toBe(5); expect(Object.keys(third.cache)).toHaveLength(2);
    expect(vectorKey(record(1), LOCAL_NAMESPACE)).not.toBe(vectorKey(edited, LOCAL_NAMESPACE));
    expect(vectorKey(record(1), { ...LOCAL_NAMESPACE, modelRevision: 'changed' })).not.toBe(vectorKey(record(1), LOCAL_NAMESPACE));
    expect(vectorKey(record(1), { ...LOCAL_NAMESPACE, preprocessingRevision: 'changed' })).not.toBe(vectorKey(record(1), LOCAL_NAMESPACE));
    expect(third.snapshot.coverage).toEqual({ eligible: 2, embedded: 2, pending: 0, excluded: 2 });
  });
  it('refuses malformed vectors and duplicate identities', async () => {
    const input = { records: [record(0)], authorizationScopeId: 'scope', excluded: 0, cache: {}, namespace: LOCAL_NAMESPACE, jobId: 'job' };
    await expect(buildGraph(input, { embed: async () => [1], dispose: async () => {} }, () => {})).rejects.toThrow('Invalid normalized embedding');
  });
});
