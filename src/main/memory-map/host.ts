import { lstat } from 'node:fs/promises';
import { StoredMemoryGraphSchema } from '../../shared/memory-map-validation.js';
import { retrieveMatches } from './retrieval.js';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { GraphSnapshot, MemoryMapProgress, MemoryMapFilters, RetrievalAnswer, MemoryMapError } from '../../shared/memory-map.js';
import { openFeatureNamespace, writeFileAtomicAtPathIf, type FeatureNamespaceHandle } from '../storage/feature-namespace.js';
import { catalogRevision, LOCAL_NAMESPACE, type VectorCache } from './graph.js';
import { runMemoryWorker, type MemoryWorkerRunner } from './worker-client.js';
import type { MemoryMapCatalog } from './catalog.js';
export class MemoryMapHostError extends Error {
  constructor(readonly code: MemoryMapError) { super(code); this.name = 'MemoryMapHostError'; }
}
interface HostOptions {
  validatedModelPath: () => Promise<string>;
  namespace?: FeatureNamespaceHandle;
  runWorker?: MemoryWorkerRunner;
  onProgress?: (progress: MemoryMapProgress) => void;
}
export class MemoryMapHost {
  private readonly namespace: FeatureNamespaceHandle;
  protected readonly runWorker: MemoryWorkerRunner;
  private controller?: AbortController;
  protected generation = 0;
  protected snapshot: GraphSnapshot | null = null;
  private pending: GraphSnapshot | null = null;
  protected cache: VectorCache = {};
  private scopeId?: string;
  private hydrated = false;
  private queryGeneration = 0;
  private queryController?: AbortController;
  constructor(protected readonly options: HostOptions) {
    this.namespace = options.namespace ?? openFeatureNamespace('memory-map');
    this.runWorker = options.runWorker ?? runMemoryWorker;
  }
  cancel(): void { this.generation++; this.controller?.abort(); this.queryGeneration++; this.queryController?.abort(); this.pending = null; }
  protected activate(catalog: MemoryMapCatalog): void {
    if (this.scopeId !== catalog.authorizationScopeId) { this.cancel(); this.snapshot = null; this.cache = {}; this.scopeId = catalog.authorizationScopeId; this.hydrated = false; }
  }
  private async readSaved() {
    const absent = { cache: {}, snapshot: null };
    const raw = await this.namespace.readJson<unknown>('snapshot.json', absent);
    if (raw === absent) {
      try { await lstat(join(this.namespace.dir, 'snapshot.json')); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return absent; throw error; }
      throw new Error('Stored memory graph is unreadable');
    }
    const parsed = StoredMemoryGraphSchema.safeParse(raw);
    if (!parsed.success) throw new Error('Invalid stored memory graph');
    return parsed.data;
  }
  private validateSnapshot(snapshot: GraphSnapshot, catalog: MemoryMapCatalog): void {
    const records = new Map(catalog.records.map(record => [record.memoryId, record]));
    const ids = new Set<string>();
    if (snapshot.points.length !== records.size) throw new Error('Stored graph coverage differs from the catalog');
    for (const point of snapshot.points) {
      const record = records.get(point.memoryId);
      if (!record || ids.has(point.memoryId) || record.contentRevision !== point.contentRevision) throw new Error('Stored graph memory identity is invalid');
      ids.add(point.memoryId);
      point.title = record.title; point.sourceKind = record.sourceKind; point.projectId = record.projectId; point.projectName = record.projectName;
    }
    const pairs = new Set<string>(); const degrees = new Map<string, number>();
    for (const edge of snapshot.edges) {
      const pair = JSON.stringify([edge.a, edge.b]);
      if (!ids.has(edge.a) || !ids.has(edge.b) || edge.a >= edge.b || pairs.has(pair)) throw new Error('Stored graph edge identity is invalid');
      pairs.add(pair);
      for (const id of [edge.a, edge.b]) { const degree = (degrees.get(id) ?? 0) + 1; if (degree > 6) throw new Error('Stored graph degree exceeds its limit'); degrees.set(id, degree); }
    }
  }
  async get(readCatalog: () => MemoryMapCatalog): Promise<GraphSnapshot | null> {
    const catalog = readCatalog(); this.activate(catalog);
    if (!this.hydrated) {
      const generation = this.generation;
      const saved = await this.readSaved();
      if (generation !== this.generation) throw new MemoryMapHostError('request-stale');
      this.hydrated = true;
      if (saved.snapshot) { this.snapshot = saved.snapshot; this.cache = saved.cache; }
    }
    if ((this.snapshot && (this.snapshot.catalogRevision !== catalogRevision(catalog.records) || this.snapshot.authorizationScopeId !== catalog.authorizationScopeId || JSON.stringify(this.snapshot.model.namespace) !== JSON.stringify(LOCAL_NAMESPACE))) || (this.pending && this.pending.catalogRevision !== catalogRevision(catalog.records))) {
      this.cancel(); this.snapshot = null; this.cache = {};
      await this.namespace.childDir('');
      await writeFileAtomicAtPathIf(join(this.namespace.dir, 'snapshot.json'), JSON.stringify({ cache: {}, snapshot: null }), () => this.snapshot === null);
    }
    if (this.snapshot) this.validateSnapshot(this.snapshot, catalog);
    return this.pending ?? this.snapshot;
  }
  async build(readCatalog: () => MemoryMapCatalog): Promise<GraphSnapshot> {
    const catalog = readCatalog(); this.activate(catalog); this.cancel(); this.hydrated = true;
    const generation = this.generation; const controller = new AbortController(); this.controller = controller;
    const current = () => !controller.signal.aborted && generation === this.generation && catalog.authorizationScopeId === readCatalog().authorizationScopeId && catalogRevision(catalog.records) === catalogRevision(readCatalog().records);
    this.pending = {
      snapshotId: randomUUID(), catalogRevision: catalogRevision(catalog.records), authorizationScopeId: catalog.authorizationScopeId,
      model: { id: LOCAL_NAMESPACE.modelId, revision: LOCAL_NAMESPACE.modelRevision, dimensions: 384, preprocessingRevision: LOCAL_NAMESPACE.preprocessingRevision, namespace: LOCAL_NAMESPACE },
      projection: { algorithm: 'umap', dimensions: 2, version: '1.4.0', seed: 42, parameters: { nNeighbors: Math.min(12, Math.max(0, catalog.records.length - 1)), minDist: 0.1, nEpochs: 200 } },
      status: 'building', coverage: { eligible: catalog.records.length, embedded: 0, pending: catalog.records.length, excluded: catalog.excluded }, points: [], edges: [],
    };
    try {
    const folder = await this.options.validatedModelPath();
    if (!current()) throw new MemoryMapHostError('request-stale');
    const saved = await this.readSaved();
    const cache: VectorCache = {};
    for (const [key, vector] of Object.entries(saved?.cache ?? {})) {
      if (!/^[a-f0-9]{64}$/.test(key) || !Array.isArray(vector) || vector.length !== 384 || vector.some(n => typeof n !== 'number' || !Number.isFinite(n))) throw new Error('Invalid stored vector cache');
      cache[key] = vector;
    }
    const result = await this.runWorker<{ snapshot: GraphSnapshot; cache: VectorCache }>(folder, { kind: 'build', input: { ...catalog, cache, namespace: LOCAL_NAMESPACE, jobId: randomUUID() } }, controller.signal, progress => { if (generation === this.generation) { if (this.pending && progress.phase === 'embedding') this.pending.coverage = { ...this.pending.coverage, embedded: progress.completed, pending: progress.total - progress.completed }; this.options.onProgress?.(progress); } });
    if (!current()) throw new MemoryMapHostError('request-stale');
    this.validateSnapshot(result.snapshot, catalog);
    await this.namespace.childDir('');
    const committed = await writeFileAtomicAtPathIf(join(this.namespace.dir, 'snapshot.json'), JSON.stringify(result), current);
    if (!committed || !current()) throw new MemoryMapHostError('request-stale');
    this.cache = result.cache; this.snapshot = result.snapshot; this.pending = null;
    return result.snapshot;
    } catch (error) {
      if (generation !== this.generation || controller.signal.aborted) throw new MemoryMapHostError('request-stale');
      if (this.pending) this.pending = { ...this.pending, status: error instanceof MemoryMapHostError && error.code === 'model-unconfigured' ? 'unconfigured' : 'failed' };
      throw error;
    }
  }
  async retrieve(readCatalog: () => MemoryMapCatalog, request: { question: string; filters: MemoryMapFilters; snapshotId: string; queryId: string }): Promise<RetrievalAnswer> {
    const catalog = readCatalog(); this.activate(catalog);
    this.queryController?.abort();
    const queryGeneration = ++this.queryGeneration;
    const controller = new AbortController(); this.queryController = controller;
    const snapshot = await this.get(readCatalog);
    if (!snapshot || snapshot.status !== 'ready' || snapshot.snapshotId !== request.snapshotId) throw new MemoryMapHostError('graph-stale');
    const folder = await this.options.validatedModelPath();
    if (queryGeneration !== this.queryGeneration) throw new MemoryMapHostError('request-stale');
    let vector: number[];
    try { vector = await this.runWorker<number[]>(folder, { kind: 'embed', text: request.question }, controller.signal); }
    catch (error) { if (controller.signal.aborted || queryGeneration !== this.queryGeneration) throw new MemoryMapHostError('request-stale'); throw error; }
    if (controller.signal.aborted || queryGeneration !== this.queryGeneration || snapshot !== this.snapshot || catalogRevision(catalog.records) !== catalogRevision(readCatalog().records) || catalog.authorizationScopeId !== readCatalog().authorizationScopeId) throw new MemoryMapHostError('request-stale');
    return retrieveMatches(catalog.records, this.cache, vector, request.filters, { snapshotId: snapshot.snapshotId, catalogRevision: snapshot.catalogRevision, queryId: request.queryId });
  }

}
