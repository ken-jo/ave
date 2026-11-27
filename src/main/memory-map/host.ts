import { lstat } from 'node:fs/promises';
import { StoredMemoryGraphSchema } from '../../shared/memory-map-validation.js';
import { retrieveMatches } from './retrieval.js';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { GraphSnapshot, MemoryMapProgress, MemoryMapFilters, RetrievalAnswer, EmbeddingNamespace, MemoryMapRecord } from '../../shared/memory-map.js';
import { openFeatureNamespace, writeFileAtomicAtPathIf, type FeatureNamespaceHandle } from '../storage/feature-namespace.js';
import { catalogRevision, LOCAL_NAMESPACE, vectorKey, type VectorCache } from './graph.js';
import { runMemoryWorker, type MemoryWorkerRunner } from './worker-client.js';
import type { MemoryMapCatalog, ReadMemoryMapCatalog } from './catalog.js';
import { MemoryMapHostError } from './errors.js';
import { MAX_INFERENCE_TASK_BYTES } from './inference-request.js';
import { registerModelBuild } from './model-manager.js';
export { MemoryMapHostError } from './errors.js';
import type { ProviderEmbeddings } from './provider-embeddings.js';
const sameNamespace = (a: EmbeddingNamespace, b: EmbeddingNamespace) => a.source === b.source && a.providerId === b.providerId && a.modelId === b.modelId && a.modelRevision === b.modelRevision && a.preprocessingRevision === b.preprocessingRevision && (!b.dimensions || a.dimensions === b.dimensions);
interface HostOptions {
  provider?: ProviderEmbeddings;
  validatedModelPath: () => Promise<string>;
  namespace?: FeatureNamespaceHandle;
  runWorker?: MemoryWorkerRunner;
  watchAuthority?: (cancel: () => void) => () => void;
  onProgress?: (progress: MemoryMapProgress) => void;
}
interface GraphBuildResult { snapshot: GraphSnapshot; cache: VectorCache }
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
  async invalidate(): Promise<void> {
    this.cancel(); this.snapshot = null; this.cache = {}; this.hydrated = true;
    const generation = this.generation;
    await this.namespace.childDir('');
    await writeFileAtomicAtPathIf(join(this.namespace.dir, 'snapshot.json'), JSON.stringify({ cache: {}, snapshot: null }), () => generation === this.generation);
  }
  private selectedNamespace(): EmbeddingNamespace { return this.options.provider?.namespace() ?? LOCAL_NAMESPACE; }
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
  async get(readCatalog: ReadMemoryMapCatalog): Promise<GraphSnapshot | null> {
    const catalog = readCatalog(); this.activate(catalog);
    if (!this.hydrated) {
      const generation = this.generation;
      const saved = await this.readSaved();
      if (generation !== this.generation) throw new MemoryMapHostError('request-stale');
      this.hydrated = true;
      if (saved.snapshot) { this.snapshot = saved.snapshot; this.cache = saved.cache; }
    }
    if ((this.snapshot && (this.snapshot.catalogRevision !== catalogRevision(catalog.records) || this.snapshot.authorizationScopeId !== catalog.authorizationScopeId || !sameNamespace(this.snapshot.model.namespace, this.selectedNamespace()))) || (this.pending && (this.pending.catalogRevision !== catalogRevision(catalog.records) || !sameNamespace(this.pending.model.namespace, this.selectedNamespace())))) {
      this.cancel(); this.snapshot = null; this.cache = {};
      await this.namespace.childDir('');
      await writeFileAtomicAtPathIf(join(this.namespace.dir, 'snapshot.json'), JSON.stringify({ cache: {}, snapshot: null }), () => this.snapshot === null);
    }
    if (this.snapshot) this.validateSnapshot(this.snapshot, catalog);
    return this.pending ?? this.snapshot;
  }
  private async buildLocal(catalog: MemoryMapCatalog, folder: string, savedCache: VectorCache, signal: AbortSignal, report: (progress: MemoryMapProgress) => void, assertCurrent: () => void): Promise<GraphBuildResult> {
    const jobId = randomUUID();
    const total = catalog.records.length;
    const cache: VectorCache = {};
    const missing: { record: MemoryMapRecord; key: string }[] = [];
    for (const record of catalog.records) {
      const key = vectorKey(record, LOCAL_NAMESPACE);
      const vector = savedCache[key];
      if (vector) cache[key] = vector;
      else missing.push({ record, key });
    }
    const cached = total - missing.length;
    if (cached) report({ jobId, phase: 'embedding', completed: cached, total });
    for (let offset = 0; offset < missing.length;) {
      const start = offset;
      const texts: string[] = [];
      const task = { kind: 'embed-batch' as const, texts, jobId };
      let taskBytes = Buffer.byteLength(JSON.stringify(task));
      for (let index = start; index < missing.length; index++) {
        const { record } = missing[index];
        const text = `${record.title}\n${record.text}`;
        const bytes = Buffer.byteLength(JSON.stringify(text)) + (texts.length ? 1 : 0);
        if (taskBytes + bytes > MAX_INFERENCE_TASK_BYTES) break;
        taskBytes += bytes;
        texts.push(text);
      }
      if (!texts.length) throw new MemoryMapHostError('catalog-too-large');

      assertCurrent();
      const vectors = await this.runWorker<number[][]>(folder, task, signal, progress => {
        const completed = progress.completed;
        if (progress.phase === 'embedding' && texts[completed - 1] !== undefined) {
          const { record } = missing[start + completed - 1];
          report({ jobId, phase: 'embedding', completed: cached + start + completed, total, memoryId: record.memoryId });
        }
      });
      if (vectors.length !== texts.length) throw new Error('Memory and vector counts differ');
      vectors.forEach((vector, index) => { cache[missing[start + index].key] = vector; });
      offset += texts.length;
    }
    assertCurrent();
    return this.runWorker<GraphBuildResult>('', { kind: 'project', input: { ...catalog, cache, namespace: LOCAL_NAMESPACE, jobId } }, signal, progress => {
      if (progress.phase !== 'embedding') report(progress);
    });
  }
  async build(readCatalog: ReadMemoryMapCatalog): Promise<GraphSnapshot> {
    const catalog = readCatalog(); this.activate(catalog); this.cancel(); this.hydrated = true;
    const selected = this.selectedNamespace();
    const generation = this.generation; const controller = new AbortController(); this.controller = controller;
    const revision = catalogRevision(catalog.records);
    const active = () => sameNamespace(selected, this.selectedNamespace()) && !controller.signal.aborted && generation === this.generation;
    const current = () => {
      if (!active()) return false;
      const latest = readCatalog();
      return catalog.authorizationScopeId === latest.authorizationScopeId && revision === catalogRevision(latest.records);
    };
    const assertAuthority = (batch: readonly MemoryMapRecord[]) => {
      if (!active() || !(readCatalog.recordsAreCurrent
        ? readCatalog.recordsAreCurrent(catalog.authorizationScopeId, batch)
        : current())) {
        controller.abort();
        if (generation === this.generation) this.pending = null;
        throw new MemoryMapHostError('request-stale');
      }
    };
    let stopWatching: (() => void) | undefined;
    let releaseModel: (() => void) | undefined;
    this.pending = {
      snapshotId: randomUUID(), catalogRevision: revision, authorizationScopeId: catalog.authorizationScopeId,
      model: { id: selected.modelId, revision: selected.modelRevision, dimensions: selected.dimensions, preprocessingRevision: selected.preprocessingRevision, namespace: selected },
      projection: { algorithm: 'umap', dimensions: 2, version: '1.4.0', seed: 42, parameters: { nNeighbors: Math.min(12, Math.max(0, catalog.records.length - 1)), minDist: 0.1, nEpochs: 200 } },
      status: 'building', coverage: { eligible: catalog.records.length, embedded: 0, pending: catalog.records.length, excluded: catalog.excluded }, points: [], edges: [],
    };
    try {
    let folder = '';
    if (selected.source === 'local') {
      folder = await this.options.validatedModelPath();
      releaseModel = registerModelBuild(folder);
    }
    if (!current()) throw new MemoryMapHostError('request-stale');
    const saved = await this.readSaved();
    const cache: VectorCache = {};
    for (const [key, vector] of Object.entries(saved?.cache ?? {})) {
      if (!/^[a-f0-9]{64}$/.test(key) || !Array.isArray(vector) || vector.length !== saved.snapshot?.model.namespace.dimensions || vector.some(n => typeof n !== 'number' || !Number.isFinite(n))) throw new Error('Invalid stored vector cache');
      cache[key] = vector;
    }
    const report = (progress: MemoryMapProgress) => { if (generation === this.generation) { if (this.pending && progress.phase === 'embedding') this.pending.coverage = { ...this.pending.coverage, embedded: progress.completed, pending: progress.total - progress.completed }; this.options.onProgress?.(progress); } };
    if (selected.source === 'provider') stopWatching = this.options.watchAuthority?.(() => { if (active()) this.cancel(); });
    const result = selected.source === 'provider'
      ? await (this.options.provider as ProviderEmbeddings).build(catalog, selected, saved, controller.signal, report, assertAuthority)
      : await this.buildLocal(catalog, folder, cache, controller.signal, report, () => {
        if (!current()) throw new MemoryMapHostError('request-stale');
      });
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
    } finally {
      releaseModel?.();
      stopWatching?.();
    }
  }
  async retrieve(readCatalog: ReadMemoryMapCatalog, request: { question: string; filters: MemoryMapFilters; snapshotId: string; queryId: string }): Promise<RetrievalAnswer> {
    const catalog = readCatalog(); this.activate(catalog);
    this.queryController?.abort();
    const queryGeneration = ++this.queryGeneration;
    const controller = new AbortController(); this.queryController = controller;
    const snapshot = await this.get(readCatalog);
    if (snapshot?.status !== 'ready' || snapshot.snapshotId !== request.snapshotId) throw new MemoryMapHostError('graph-stale');
    const selected = snapshot.model.namespace;
    const folder = selected.source === 'local' ? await this.options.validatedModelPath() : '';
    if (queryGeneration !== this.queryGeneration) throw new MemoryMapHostError('request-stale');
    const assertAuthority = () => {
      if (controller.signal.aborted || queryGeneration !== this.queryGeneration || !(readCatalog.recordsAreCurrent
        ? readCatalog.recordsAreCurrent(catalog.authorizationScopeId, [])
        : catalog.authorizationScopeId === readCatalog().authorizationScopeId)) throw new MemoryMapHostError('request-stale');
    };
    const stopWatching = selected.source === 'provider' ? this.options.watchAuthority?.(() => controller.abort()) : undefined;
    let vector: number[];
    try { vector = selected.source === 'provider' ? (await (this.options.provider as ProviderEmbeddings).embed(selected, [request.question], controller.signal, assertAuthority))[0] : await this.runWorker<number[]>(folder, { kind: 'embed', text: request.question }, controller.signal); }
    catch (error) { if (controller.signal.aborted || queryGeneration !== this.queryGeneration) throw new MemoryMapHostError('request-stale'); throw error; }
    finally { stopWatching?.(); }
    if (controller.signal.aborted || queryGeneration !== this.queryGeneration || snapshot !== this.snapshot || catalogRevision(catalog.records) !== catalogRevision(readCatalog().records) || catalog.authorizationScopeId !== readCatalog().authorizationScopeId) throw new MemoryMapHostError('request-stale');
    return retrieveMatches(catalog.records, this.cache, vector, request.filters, { snapshotId: snapshot.snapshotId, catalogRevision: snapshot.catalogRevision, queryId: request.queryId }, selected);
  }

}
