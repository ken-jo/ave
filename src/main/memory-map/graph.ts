import { createHash } from 'node:crypto';
import { UMAP } from 'umap-js';
import type { EmbeddingNamespace, GraphSnapshot, MemoryMapRecord, MemoryMapProgress } from '../../shared/memory-map.js';
import type { Embedder } from './embedding.js';
import { LOCAL_MODEL_ID, LOCAL_MODEL_REVISION, PREPROCESSING_REVISION } from './model-manifest.js';
export const LOCAL_NAMESPACE: EmbeddingNamespace = Object.freeze({ source: 'local', modelId: LOCAL_MODEL_ID, modelRevision: LOCAL_MODEL_REVISION, preprocessingRevision: PREPROCESSING_REVISION, dimensions: 384 });
export const PROJECTION_SEED = 42;
export interface VectorCache { [key: string]: number[] }
export const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
export const vectorKey = (record: MemoryMapRecord, namespace: EmbeddingNamespace): string => digest(JSON.stringify([record.memoryId, record.contentRevision, namespace]));
export const catalogRevision = (records: MemoryMapRecord[]): string => digest(JSON.stringify(records));
export function cosine(a: number[], b: number[]): number {
  if (a.length !== 384 || b.length !== 384) throw new Error('Expected 384 embedding dimensions');
  let value = 0; for (let i = 0; i < 384; i++) value += a[i]! * b[i]!;
  if (!Number.isFinite(value)) throw new Error('Non-finite similarity');
  return Math.max(-1, Math.min(1, value));
}
export function semanticLinks(records: MemoryMapRecord[], vectors: number[][], budget = 17000): GraphSnapshot['edges'] {
  if (vectors.length !== records.length) throw new Error('Memory and vector counts differ');
  const top: { index: number; score: number }[][] = records.map(() => []);
  const admit = (from: number, index: number, score: number) => {
    const row = top[from]!;
    const compare = (candidate: { index: number; score: number }) => candidate.score - score || records[index]!.memoryId.localeCompare(records[candidate.index]!.memoryId);
    if (row.length === 12 && compare(row[11]!) >= 0) return;
    let position = row.findIndex(candidate => compare(candidate) < 0);
    if (position === -1) position = row.length;
    row.splice(position, 0, { index, score });
    if (row.length > 12) row.pop();
  };
  for (let a = 0; a < records.length; a++) for (let b = a + 1; b < records.length; b++) {
    if (records[a]!.memoryId === records[b]!.memoryId) continue;
    const score = cosine(vectors[a]!, vectors[b]!); admit(a, b, score); admit(b, a, score);
  }
  const candidates = new Map<string, { a: string; b: string; similarity: number; reciprocal: boolean }>();
  for (let from = 0; from < top.length; from++) for (const neighbour of top[from]!) {
    const ids = [records[from]!.memoryId, records[neighbour.index]!.memoryId].sort();
    const key = JSON.stringify(ids);
    candidates.set(key, { a: ids[0]!, b: ids[1]!, similarity: neighbour.score, reciprocal: top[neighbour.index]!.some(row => row.index === from) });
  }
  const degrees = new Map<string, number>(); const edges: GraphSnapshot['edges'] = [];
  for (const pair of [...candidates.values()].sort((a, b) => Number(b.reciprocal) - Number(a.reciprocal) || b.similarity - a.similarity || a.a.localeCompare(b.a) || a.b.localeCompare(b.b))) {
    if (edges.length >= budget) break;
    if ((degrees.get(pair.a) ?? 0) >= 6 || (degrees.get(pair.b) ?? 0) >= 6) continue;
    edges.push({ a: pair.a, b: pair.b, similarity: pair.similarity, kind: 'semantic-neighbour' });
    degrees.set(pair.a, (degrees.get(pair.a) ?? 0) + 1); degrees.set(pair.b, (degrees.get(pair.b) ?? 0) + 1);
  }
  return edges;
}
function seededRandom(seed: number): () => number {
  return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let value = Math.imul(seed ^ seed >>> 15, 1 | seed); value ^= value + Math.imul(value ^ value >>> 7, 61 | value); return ((value ^ value >>> 14) >>> 0) / 4294967296; };
}
export interface GraphBuildInput { records: MemoryMapRecord[]; authorizationScopeId: string; excluded: number; cache: VectorCache; namespace: EmbeddingNamespace; jobId: string }
export async function buildGraph(input: GraphBuildInput, embedder: Embedder, onProgress: (progress: MemoryMapProgress) => void): Promise<{ snapshot: GraphSnapshot; cache: VectorCache }> {
  if (input.namespace.dimensions !== 384) throw new Error('Expected 384-dimensional namespace');
  const records = [...input.records].sort((a, b) => a.memoryId.localeCompare(b.memoryId));
  if (new Set(records.map(r => r.memoryId)).size !== records.length) throw new Error('Duplicate memory identity');
  const cache: VectorCache = {}; const vectors: number[][] = [];
  for (const record of records) {
    const key = vectorKey(record, input.namespace);
    const vector = input.cache[key] ?? await embedder.embed(record.title + '\n' + record.text);
    if (vector.length !== 384 || vector.some(n => !Number.isFinite(n)) || Math.abs(Math.hypot(...vector) - 1) > 0.001) throw new Error('Invalid normalized embedding');
    cache[key] = vector; vectors.push(vector);
    onProgress({ jobId: input.jobId, phase: 'embedding', completed: vectors.length, total: records.length, memoryId: record.memoryId });
  }
  onProgress({ jobId: input.jobId, phase: 'neighbours', completed: 0, total: records.length });
  const edges = semanticLinks(records, vectors);
  const parameters = { nNeighbors: Math.min(12, Math.max(0, records.length - 1)), minDist: 0.1, nEpochs: 200 };
  let coordinates: number[][];
  if (records.length < 3) coordinates = records.map((_, i) => [i, 0]);
  else coordinates = new UMAP({ ...parameters, nComponents: 2, random: seededRandom(PROJECTION_SEED), distanceFn: (a, b) => 1 - cosine(a, b) }).fit(vectors);
  onProgress({ jobId: input.jobId, phase: 'projection', completed: records.length, total: records.length });
  if (coordinates.some(row => row.length !== 2 || row.some(n => !Number.isFinite(n)))) throw new Error('Invalid projection coordinates');
  const revision = catalogRevision(records);
  return { cache, snapshot: {
    snapshotId: digest(JSON.stringify([input.authorizationScopeId, revision, input.namespace, PROJECTION_SEED])), catalogRevision: revision, authorizationScopeId: input.authorizationScopeId,
    model: { id: input.namespace.modelId, revision: input.namespace.modelRevision, dimensions: 384, preprocessingRevision: input.namespace.preprocessingRevision, namespace: input.namespace },
    projection: { algorithm: 'umap', dimensions: 2, version: '1.4.0', seed: PROJECTION_SEED, parameters }, status: 'ready',
    coverage: { eligible: records.length, embedded: records.length, pending: 0, excluded: input.excluded },
    points: records.map(({ text: _text, ...record }, i) => ({ ...record, x: coordinates[i]![0]!, y: coordinates[i]![1]! })), edges,
  } };
}
