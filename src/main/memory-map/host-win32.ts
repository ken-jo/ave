import { lstat } from 'node:fs/promises';
import { StoredMemoryGraphSchema } from '../../shared/memory-map-validation.js';
import { retrieveMatches } from './retrieval.js';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { GraphSnapshot, MemoryBuildOutcome, MemoryBuildView, MemoryMapProgress, MemoryMapFilters, RetrievalAnswer, EmbeddingNamespace, MemoryMapRecord } from '../../shared/memory-map.js';
import { openFeatureNamespace, writeFileAtomicAtPathAdmitted, type FeatureNamespaceHandle } from '../storage/feature-namespace.js';
import { catalogRevision, LOCAL_NAMESPACE, vectorKey, type VectorCache } from './graph.js';
import { runMemoryWorker, type MemoryWorkerRunner, type OnInferenceAdmission } from './worker-client-win32.js';
import type { MemoryWorkerTask } from './worker-client.js';
import type { MemoryMapCatalog, ReadMemoryMapCatalog } from './catalog.js';
import { commitUnderAdmission } from '../../shared/admission-commit.js';
import { MemoryMapHostError } from './errors.js';
import { MAX_INFERENCE_TASK_BYTES } from './inference-request.js';
import { registerModelBuild } from './model-manager-win32.js';
import { ManagedExitUnconfirmedError } from '../managed-child-processes.js';
import { MxcProcessCleanupError } from '../../permissions/mxc-extension-errors.js';
import { BuildRegistry, type BuildOwner } from './build-registry-win32.js';
export { MemoryMapHostError } from './errors.js';
import type { ProviderEmbeddings } from './provider-embeddings-win32.js';
const sameNamespace = (a: EmbeddingNamespace, b: EmbeddingNamespace) => a.source === b.source && a.providerId === b.providerId && a.modelId === b.modelId && a.modelRevision === b.modelRevision && a.preprocessingRevision === b.preprocessingRevision && (!b.dimensions || a.dimensions === b.dimensions);
interface HostOptions {
  provider?: ProviderEmbeddings;
  validatedModelPath: (signal: AbortSignal, onAdmission?: (assertStillValid: () => void) => void) => Promise<string>;
  refreshLocalAdmission: () => Promise<() => void>;
  namespace?: FeatureNamespaceHandle;
  runWorker?: MemoryWorkerRunner;
  watchAuthority?: (cancel: () => void) => () => void;
  onProgress?: (progress: MemoryMapProgress) => void;
  registry?: BuildRegistry;
}
interface GraphBuildResult { snapshot: GraphSnapshot; cache: VectorCache }
export class MemoryMapHost {
  private readonly namespace: FeatureNamespaceHandle;
  protected readonly runWorker: MemoryWorkerRunner;
  private readonly registry: BuildRegistry;
  protected snapshot: GraphSnapshot | null = null;
  protected cache: VectorCache = {};
  private graphScope: { id?: string; hydrated: boolean } = { hydrated: false };
  private queryGeneration = 0;
  private queryController?: AbortController;
  constructor(protected readonly options: HostOptions) {
    this.namespace = options.namespace ?? openFeatureNamespace('memory-map');
    this.runWorker = options.runWorker ?? runMemoryWorker;
    this.registry = options.registry ?? new BuildRegistry();
  }
  cancel(): void { this.queryGeneration++; this.queryController?.abort(); }
  async invalidate(): Promise<void> {
    this.registry.stopAll('invalidate');
    this.cancel();
    this.clearGraph(this.graphScope.id, true);
    const scope = this.graphScope;
    await this.clearSaved(() => {
      if (this.graphScope !== scope) throw new MemoryMapHostError('request-stale');
    });
  }
  private clearGraph(id: string | undefined, hydrated: boolean): void {
    this.snapshot = null;
    this.cache = {};
    this.graphScope = { id, hydrated };
    this.registry.changed();
  }
  private async clearSaved(assertCurrent: () => void): Promise<void> {
    await this.namespace.childDir('', { assertStillValid: assertCurrent });
    const cleared = await writeFileAtomicAtPathAdmitted(join(this.namespace.dir, 'snapshot.json'), JSON.stringify({ cache: {}, snapshot: null }), () => {
      assertCurrent();
      return true;
    });
    if (!cleared) throw new MemoryMapHostError('request-stale');
    assertCurrent();
  }
  private selectedNamespace(): EmbeddingNamespace { return this.options.provider?.namespace() ?? LOCAL_NAMESPACE; }
  protected activate(catalog: MemoryMapCatalog): void {
    if (this.graphScope.id !== catalog.authorizationScopeId) {
      this.registry.stopCurrent('scope-switch');
      this.cancel();
      this.clearGraph(catalog.authorizationScopeId, false);
    }
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
    return this.readView(readCatalog, (_catalog, snapshot) => snapshot);
  }
  async buildView(readCatalog: ReadMemoryMapCatalog): Promise<MemoryBuildView> {
    return this.readView(readCatalog, (catalog, snapshot) => this.registry.view(catalog.authorizationScopeId, snapshot));
  }
  private matchesCatalog(snapshot: GraphSnapshot, catalog: MemoryMapCatalog): boolean {
    return snapshot.authorizationScopeId === catalog.authorizationScopeId
      && snapshot.catalogRevision === catalogRevision(catalog.records) && sameNamespace(snapshot.model.namespace, this.selectedNamespace());
  }
  private readySnapshot(catalog: MemoryMapCatalog): GraphSnapshot | null {
    if (!this.snapshot || !this.matchesCatalog(this.snapshot, catalog)) return null;
    this.validateSnapshot(this.snapshot, catalog);
    return this.snapshot;
  }
  private async readView<T>(readCatalog: ReadMemoryMapCatalog, read: (catalog: MemoryMapCatalog, snapshot: GraphSnapshot | null) => T): Promise<T> {
    const catalog = readCatalog(); this.activate(catalog);
    const revision = catalogRevision(catalog.records);
    const selected = this.selectedNamespace();
    const assertCurrent = (scope: typeof this.graphScope) => {
      if (scope !== this.graphScope || !sameNamespace(selected, this.selectedNamespace())) throw new MemoryMapHostError('request-stale');
      const latest = readCatalog();
      if (latest.authorizationScopeId !== catalog.authorizationScopeId || catalogRevision(latest.records) !== revision) throw new MemoryMapHostError('request-stale');
    };
    if (!this.graphScope.hydrated) {
      const scope = this.graphScope;
      const saved = await this.readSaved();
      commitUnderAdmission(() => assertCurrent(scope), () => {
        scope.hydrated = true;
        if (saved.snapshot) { this.snapshot = saved.snapshot; this.cache = saved.cache; }
        this.registry.changed();
      });
    }
    const building = this.registry.current?.snapshot;
    if (building && this.matchesCatalog(building, catalog)) return read(catalog, building);
    if ((this.snapshot && !this.matchesCatalog(this.snapshot, catalog)) || building) {
      this.registry.stopCurrent('catalog-changed');
      this.cancel();
      this.clearGraph(catalog.authorizationScopeId, true);
      const scope = this.graphScope;
      await this.clearSaved(() => assertCurrent(scope));
      assertCurrent(scope);
    }
    return read(catalog, this.readySnapshot(catalog));
  }
  private async embedLocal(catalog: MemoryMapCatalog, folder: string, savedCache: VectorCache, signal: AbortSignal, jobId: string, report: (progress: MemoryMapProgress) => void, assertCurrent: () => void, assertModelAdmission: () => void, runWorker: MemoryWorkerRunner): Promise<VectorCache> {
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
    const progressStride = Math.max(1, Math.ceil(total / 64));
    if (cached) {
      const progress: MemoryMapProgress = { jobId, phase: 'embedding', completed: cached, total };
      assertCurrent();
      commitUnderAdmission(assertModelAdmission, () => report(progress));
    }
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
      const vectors = await runWorker<number[][]>(folder, task, signal, progress => {
        const completed = progress.completed;
        const overall = cached + start + completed;
        if (progress.phase === 'embedding' && texts[completed - 1] !== undefined
          && (overall === cached + 1 || overall === total || overall % progressStride === 0)) {
          const { record } = missing[start + completed - 1];
          const update: MemoryMapProgress = { jobId, phase: 'embedding', completed: overall, total, memoryId: record.memoryId };
          try { report(update); } catch { /* Refused. */ }
        }
      });
      if (vectors.length !== texts.length) throw new Error('Memory and vector counts differ');
      vectors.forEach((vector, index) => { cache[missing[start + index].key] = vector; });
      offset += texts.length;
    }
    return cache;
  }
  async build(readCatalog: ReadMemoryMapCatalog, onAdmission?: (assertLive: () => void) => void,
    owner?: BuildOwner, assertLocal = () => {}): Promise<GraphSnapshot> {
    const catalog = readCatalog();
    owner ??= this.registry.register(randomUUID(), { scopeId: catalog.authorizationScopeId, assertAdmitted: () => {} });
    return this.buildOwned(owner, catalog, readCatalog, assertLocal, onAdmission);
  }

  private async buildOwned(owner: BuildOwner, catalog: MemoryMapCatalog, readCatalog: ReadMemoryMapCatalog,
    assertLocal: () => void, onAdmission?: (assertLive: () => void) => void): Promise<GraphSnapshot> {
    const runWorker: MemoryWorkerRunner = <T>(folder: string, task: MemoryWorkerTask, signal: AbortSignal,
      onProgress?: (progress: MemoryMapProgress) => void, onAdmission?: OnInferenceAdmission) =>
      this.runWorker<T>(folder, task, signal, onProgress, onAdmission, owner.beginWorker);
    const selected = this.selectedNamespace();
    const revision = catalogRevision(catalog.records);
    try { owner.takeover(assertLocal); }
    catch (error) { owner.fail(this.buildErrorCode(error)); throw error; }
    if (this.graphScope.id !== catalog.authorizationScopeId) {
      this.cancel();
      this.clearGraph(catalog.authorizationScopeId, true);
    } else this.graphScope = { id: catalog.authorizationScopeId, hydrated: true };
    const scope = this.graphScope;
    const signal = owner.signal;
    const active = () => owner.isRunning() && sameNamespace(selected, this.selectedNamespace());
    const current = () => {
      if (!active()) return false;
      const latest = readCatalog();
      return catalog.authorizationScopeId === latest.authorizationScopeId && revision === catalogRevision(latest.records);
    };
    const assertAuthority = (batch: readonly MemoryMapRecord[]) => {
      if (!active() || !(readCatalog.recordsAreCurrent
        ? readCatalog.recordsAreCurrent(catalog.authorizationScopeId, batch)
        : current())) {
        owner.stop('stale');
        throw new MemoryMapHostError('request-stale');
      }
    };
    const assertCurrent = () => {
      if (!current()) throw new MemoryMapHostError('request-stale');
    };
    let stopWatching: (() => void) | undefined;
    let releaseModel: (() => void) | undefined;
    owner.snapshot = {
      snapshotId: owner.id, catalogRevision: revision, authorizationScopeId: catalog.authorizationScopeId,
      model: { id: selected.modelId, revision: selected.modelRevision, dimensions: selected.dimensions, preprocessingRevision: selected.preprocessingRevision, namespace: selected },
      projection: { algorithm: 'umap', dimensions: 2, version: '1.4.0', seed: 42, parameters: { nNeighbors: Math.min(12, Math.max(0, catalog.records.length - 1)), minDist: 0.1, nEpochs: 200 } },
      status: 'building', coverage: { eligible: catalog.records.length, embedded: 0, pending: catalog.records.length, excluded: catalog.excluded }, points: [], edges: [],
    };
    let outcome: MemoryBuildOutcome = { kind: 'cancelled' };
    try {
      let folder = '';
      let assertModelAdmission: (() => void) | undefined;
      if (selected.source === 'local') {
        folder = await this.options.validatedModelPath(signal, (assertStillValid) => { assertModelAdmission = assertStillValid; });
        releaseModel = registerModelBuild(folder);
      }
      assertCurrent();
      const saved = await this.readSaved();
      const cache: VectorCache = {};
      for (const [key, vector] of Object.entries(saved.cache)) {
        if (!/^[a-f0-9]{64}$/.test(key) || !Array.isArray(vector) || vector.length !== saved.snapshot?.model.namespace.dimensions || vector.some(n => typeof n !== 'number' || !Number.isFinite(n))) throw new Error('Invalid stored vector cache');
        cache[key] = vector;
      }
      const publishProgress = (progress: MemoryMapProgress) => {
        const snapshot = owner.snapshot;
        if (snapshot && progress.phase === 'embedding') {
          owner.snapshot = { ...snapshot, coverage: { ...snapshot.coverage, embedded: progress.completed, pending: progress.total - progress.completed } };
          this.registry.changed();
        }
        owner.report(progress);
        this.options.onProgress?.(progress);
      };
      const report = (progress: MemoryMapProgress) => {
        commitUnderAdmission(assertCurrent, () => publishProgress(progress));
      };
      let assertBuildAdmission: (() => void) | undefined;
      let result: GraphBuildResult;
      if (selected.source === 'provider') {
        stopWatching = this.options.watchAuthority?.(() => owner.stop('authority'));
        const provider = this.options.provider as ProviderEmbeddings;
        assertBuildAdmission = provider.bindConsent(selected, signal);
        result = await provider.build(catalog, selected, saved, signal, report, assertAuthority, assertCurrent, owner.beginWorker);
      } else {
        if (assertModelAdmission === undefined) throw new MemoryMapHostError('local-runtime-unavailable');
        const jobId = owner.id;
        const vectors = await this.embedLocal(catalog, folder, cache, signal, jobId, report, assertCurrent, assertModelAdmission, runWorker);
        assertCurrent();
        assertBuildAdmission = await this.options.refreshLocalAdmission();
        assertCurrent();
        const assertProjection = assertBuildAdmission;
        let projecting!: Promise<GraphBuildResult>;
        commitUnderAdmission(assertProjection, () => { projecting = runWorker<GraphBuildResult>('', {
          kind: 'project', input: { ...catalog, cache: vectors, namespace: LOCAL_NAMESPACE, jobId },
        }, signal, progress => {
          if (progress.phase === 'embedding') return;
          try { commitUnderAdmission(assertProjection, () => report(progress)); } catch { /* Refused. */ }
        }); });
        result = await projecting;
        assertCurrent();
        assertBuildAdmission();
        assertBuildAdmission = await this.options.refreshLocalAdmission();
      }
      const assertCanPublish = () => {
        try { owner.assertAdmitted(); }
        catch (error) { owner.stop('scope-denied'); throw error; }
        assertCurrent();
        assertBuildAdmission?.();
      };
      assertCanPublish();
      this.validateSnapshot(result.snapshot, catalog);
      await this.namespace.childDir('', { assertStillValid: assertCanPublish });
      const canPublish = () => { assertCanPublish(); return true; };
      // The ready state is published in the step that replaces the file, under the same check.
      const committed = await writeFileAtomicAtPathAdmitted(join(this.namespace.dir, 'snapshot.json'), JSON.stringify(result), canPublish, () => {
        this.cache = result.cache; this.snapshot = result.snapshot; owner.snapshot = null;
        this.registry.changed();
      });
      if (!committed) throw new MemoryMapHostError('request-stale');
      return commitUnderAdmission(assertCanPublish, () => {
        onAdmission?.(() => {
          signal.throwIfAborted();
          if (this.graphScope !== scope || this.readySnapshot(readCatalog()) !== result.snapshot) throw new MemoryMapHostError('request-stale');
          assertBuildAdmission?.();
        });
        outcome = { kind: 'ready' };
        return result.snapshot;
      });
    } catch (error) {
      if (signal.aborted) {
        if (error instanceof ManagedExitUnconfirmedError || error instanceof MxcProcessCleanupError) throw error;
        throw new MemoryMapHostError('request-stale');
      }
      outcome = { kind: 'failed', code: this.buildErrorCode(error) };
      if (owner.exit === 'pending') owner.stop('stale');
      throw error;
    } finally {
      owner.snapshot = null;
      owner.settle(outcome);
      releaseModel?.();
      stopWatching?.();
    }
  }
  private buildErrorCode(error: unknown): Extract<MemoryBuildOutcome, { kind: 'failed' }>['code'] {
    if (error instanceof ManagedExitUnconfirmedError || error instanceof MxcProcessCleanupError) return 'local-runtime-unavailable';
    return error instanceof MemoryMapHostError ? error.code : 'graph-build-failed';
  }
  async retrieve(readCatalog: ReadMemoryMapCatalog, request: { question: string; filters: MemoryMapFilters; snapshotId: string; queryId: string }, onAdmission?: (assertLive: () => void) => void): Promise<RetrievalAnswer> {
    const catalog = readCatalog(); this.activate(catalog);
    this.queryController?.abort();
    const queryGeneration = ++this.queryGeneration;
    const controller = new AbortController(); this.queryController = controller;
    const snapshot = await this.get(readCatalog);
    if (snapshot?.status !== 'ready' || snapshot.snapshotId !== request.snapshotId) throw new MemoryMapHostError('graph-stale');
    const selected = snapshot.model.namespace;
    const folder = selected.source === 'local' ? await this.options.validatedModelPath(controller.signal) : '';
    if (queryGeneration !== this.queryGeneration) throw new MemoryMapHostError('request-stale');
    const assertAuthority = () => {
      if (controller.signal.aborted || queryGeneration !== this.queryGeneration || !(readCatalog.recordsAreCurrent
        ? readCatalog.recordsAreCurrent(catalog.authorizationScopeId, [])
        : catalog.authorizationScopeId === readCatalog().authorizationScopeId)) throw new MemoryMapHostError('request-stale');
    };
    const provider = selected.source === 'provider' ? this.options.provider : undefined;
    const assertConsent = provider?.bindConsent(selected, controller.signal);
    const stopWatching = selected.source === 'provider' ? this.options.watchAuthority?.(() => controller.abort()) : undefined;
    let vector: number[];
    let assertInference: (() => void) | undefined;
    try {
      vector = provider
        ? (await provider.embed(selected, [request.question], controller.signal, () => { assertAuthority(); assertConsent?.(); }))[0]
        : await this.runWorker<number[]>(folder, { kind: 'embed', text: request.question }, controller.signal, undefined,
          (assertStillValid) => { assertInference = assertStillValid; });
    }
    catch (error) { if (controller.signal.aborted || queryGeneration !== this.queryGeneration) throw new MemoryMapHostError('request-stale'); throw error; }
    finally { stopWatching?.(); }
    const assertAdmission = assertConsent ?? assertInference;
    if (!assertAdmission) throw new MemoryMapHostError('local-runtime-unavailable');
    const assertReply = () => {
      assertAuthority();
      const latest = readCatalog();
      if (snapshot !== this.snapshot || catalogRevision(catalog.records) !== catalogRevision(latest.records) || catalog.authorizationScopeId !== latest.authorizationScopeId) throw new MemoryMapHostError('request-stale');
      assertAdmission();
    };
    return commitUnderAdmission(assertReply, () => {
      onAdmission?.(assertReply);
      return retrieveMatches(catalog.records, this.cache, vector, request.filters, { snapshotId: snapshot.snapshotId, catalogRevision: snapshot.catalogRevision, queryId: request.queryId }, selected);
    });
  }

}
