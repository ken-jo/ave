import { retrieveMatches } from './retrieval.js';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { GraphSnapshot, MemoryMapProgress, MemoryMapFilters, RetrievalAnswer } from '../../shared/memory-map.js';
import { openFeatureNamespace, writeFileAtomicAtPathIf, type FeatureNamespaceHandle } from '../storage/feature-namespace.js';
import { catalogRevision, LOCAL_NAMESPACE, type VectorCache } from './graph.js';
import { runMemoryWorker, type MemoryWorkerRunner } from './worker-client.js';
import type { MemoryMapCatalog } from './catalog.js';
export class MemoryMapHostError extends Error {
  constructor(readonly code: 'graph-stale' | 'request-stale' | 'graph-unavailable' | 'graph-build-failed') { super(code); this.name = 'MemoryMapHostError'; }
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
  protected cache: VectorCache = {};
  private scopeId?: string;
  private queryGeneration = 0;
  private queryController?: AbortController;
  constructor(protected readonly options: HostOptions) {
    this.namespace = options.namespace ?? openFeatureNamespace('memory-map');
    this.runWorker = options.runWorker ?? runMemoryWorker;
  }
  cancel(): void { this.generation++; this.controller?.abort(); this.queryGeneration++; this.queryController?.abort(); }
  protected activate(catalog: MemoryMapCatalog): void {
    if (this.scopeId !== catalog.authorizationScopeId) { this.cancel(); this.snapshot = null; this.cache = {}; this.scopeId = catalog.authorizationScopeId; }
  }
  async get(readCatalog: () => MemoryMapCatalog): Promise<GraphSnapshot | null> {
    const catalog = readCatalog(); this.activate(catalog);
    if (this.snapshot && this.snapshot.catalogRevision !== catalogRevision(catalog.records)) {
      this.cancel(); this.snapshot = null; this.cache = {};
      await this.namespace.childDir('');
      await writeFileAtomicAtPathIf(join(this.namespace.dir, 'snapshot.json'), JSON.stringify({ cache: {}, snapshot: null }), () => this.snapshot === null);
    }
    return this.snapshot;
  }
  async build(readCatalog: () => MemoryMapCatalog): Promise<GraphSnapshot> {
    const catalog = readCatalog(); this.activate(catalog); this.cancel();
    const generation = this.generation; const controller = new AbortController(); this.controller = controller;
    const current = () => !controller.signal.aborted && generation === this.generation && catalog.authorizationScopeId === readCatalog().authorizationScopeId && catalogRevision(catalog.records) === catalogRevision(readCatalog().records);
    const folder = await this.options.validatedModelPath();
    if (!current()) throw new MemoryMapHostError('request-stale');
    const saved = await this.namespace.readJson<{ cache: VectorCache }>('snapshot.json', { cache: {} });
    const cache: VectorCache = {};
    for (const [key, vector] of Object.entries(saved?.cache ?? {})) {
      if (!/^[a-f0-9]{64}$/.test(key) || !Array.isArray(vector) || vector.length !== 384 || vector.some(n => typeof n !== 'number' || !Number.isFinite(n))) throw new Error('Invalid stored vector cache');
      cache[key] = vector;
    }
    const result = await this.runWorker<{ snapshot: GraphSnapshot; cache: VectorCache }>(folder, { kind: 'build', input: { ...catalog, cache, namespace: LOCAL_NAMESPACE, jobId: randomUUID() } }, controller.signal, progress => { if (generation === this.generation) this.options.onProgress?.(progress); });
    if (!current()) throw new MemoryMapHostError('request-stale');
    await this.namespace.childDir('');
    const committed = await writeFileAtomicAtPathIf(join(this.namespace.dir, 'snapshot.json'), JSON.stringify(result), current);
    if (!committed || !current()) throw new MemoryMapHostError('request-stale');
    this.cache = result.cache; this.snapshot = result.snapshot;
    return result.snapshot;
  }
  async retrieve(readCatalog: () => MemoryMapCatalog, request: { question: string; filters: MemoryMapFilters; snapshotId: string; queryId: string }): Promise<RetrievalAnswer> {
    const catalog = readCatalog(); this.activate(catalog);
    this.queryController?.abort();
    const queryGeneration = ++this.queryGeneration;
    const controller = new AbortController(); this.queryController = controller;
    const snapshot = await this.get(readCatalog);
    if (!snapshot || snapshot.snapshotId !== request.snapshotId) throw new MemoryMapHostError('graph-stale');
    const folder = await this.options.validatedModelPath();
    if (queryGeneration !== this.queryGeneration) throw new MemoryMapHostError('request-stale');
    const vector = await this.runWorker<number[]>(folder, { kind: 'embed', text: request.question }, controller.signal);
    if (controller.signal.aborted || queryGeneration !== this.queryGeneration || snapshot !== this.snapshot || catalogRevision(catalog.records) !== catalogRevision(readCatalog().records) || catalog.authorizationScopeId !== readCatalog().authorizationScopeId) throw new MemoryMapHostError('request-stale');
    return retrieveMatches(catalog.records, this.cache, vector, request.filters, { snapshotId: snapshot.snapshotId, catalogRevision: snapshot.catalogRevision, queryId: request.queryId });
  }

}
