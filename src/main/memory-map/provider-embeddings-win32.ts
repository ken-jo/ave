import type { SettingsService } from '../../data/settings-store.js';
import type { MemoryEmbeddingConsent } from '../../shared/memory-embedding-config.js';
import type { EmbeddingNamespace, MemoryEmbeddingProvider, MemoryMapProgress, GraphSnapshot, MemoryMapRecord } from '../../shared/memory-map.js';
import type { MemoryMapCatalog } from './catalog.js';
import { runMemoryWorker, type MemoryWorkerRunner } from './worker-client-win32.js';
import { vectorKey, type VectorCache } from './graph.js';
import { MemoryMapHostError } from './errors.js';
import type { ProviderEgress } from './provider-egress.js';
import { ProviderEmbeddings as ProviderIntegration } from './provider-embeddings.js';
import { commitUnderAdmission } from '../../shared/admission-commit.js';

const EMBEDDING_BATCH_SIZE = 16;
export class ProviderEmbeddings {
  private readonly integration: ProviderIntegration;

  constructor(settings: SettingsService, egress: ProviderEgress, private readonly runWorker: MemoryWorkerRunner = runMemoryWorker) {
    this.integration = new ProviderIntegration(settings, egress, runWorker);
  }

  suspend(): void { this.integration.suspend(); }
  resume(): void { this.integration.resume(); }
  namespace(): EmbeddingNamespace { return this.integration.namespace(); }
  currentConsent(): MemoryEmbeddingConsent | undefined { return this.integration.currentConsent(); }
  assertCurrentEndpoint(providerId: string, endpointId: string): void { this.integration.assertCurrentEndpoint(providerId, endpointId); }
  issueConsent(providerId: string, modelId: string, endpointId: string): Promise<MemoryEmbeddingConsent> {
    return this.integration.issueConsent(providerId, modelId, endpointId);
  }
  providers(): Promise<MemoryEmbeddingProvider[]> { return this.integration.providers(); }
  validate(providerId: string, modelId: string): Promise<void> { return this.integration.validate(providerId, modelId); }

  bindConsent(namespace: EmbeddingNamespace, signal: AbortSignal): () => void {
    const timestamp = this.currentConsent()?.timestamp;
    const assertCurrent = () => {
      if (signal.aborted) throw new MemoryMapHostError('request-stale');
      const consent = this.currentConsent();
      if (!consent || consent.timestamp !== timestamp || consent.providerId !== namespace.providerId || consent.modelId !== namespace.modelId
        || consent.endpointId !== namespace.modelRevision) throw new MemoryMapHostError('provider-consent-required');
    };
    assertCurrent();
    return assertCurrent;
  }
  async embed(namespace: EmbeddingNamespace, values: string[], signal: AbortSignal, assertAuthority?: () => void): Promise<number[][]> {
    const assertConsent = this.bindConsent(namespace, signal);
    return this.integration.embed(namespace, values, signal, () => {
      assertConsent();
      assertAuthority?.();
    });
  }

  async build(catalog: MemoryMapCatalog, namespace: EmbeddingNamespace, saved: { snapshot: { model: { namespace: EmbeddingNamespace } } | null; cache: VectorCache }, signal: AbortSignal, onProgress: (progress: MemoryMapProgress) => void, assertAuthority: (batch: readonly MemoryMapRecord[]) => void, assertCatalog: () => void) {
    const assertConsent = this.bindConsent(namespace, signal);
    const records = [...catalog.records].sort((a, b) => a.memoryId.localeCompare(b.memoryId));
    let selected = { ...namespace };
    const stored = saved.snapshot?.model.namespace;
    if (stored?.source === 'provider' && stored.providerId === selected.providerId && stored.modelId === selected.modelId && stored.modelRevision === selected.modelRevision && stored.preprocessingRevision === selected.preprocessingRevision) selected = stored;
    const cache: VectorCache = {}; let completed = 0;
    const jobId = 'provider-build';
    const missing = records.filter(record => {
      const key = vectorKey(record, selected); const vector = saved.cache[key];
      if (selected.dimensions && vector?.length === selected.dimensions) { cache[key] = vector; completed++; return false; }
      return true;
    });
    for (let offset = 0; offset < missing.length; offset += EMBEDDING_BATCH_SIZE) {
      const batch = missing.slice(offset, offset + EMBEDDING_BATCH_SIZE);
      const assertBatch = () => { assertAuthority(batch); assertConsent(); };
      assertBatch();
      const vectors = await this.embed(selected, batch.map(record => `${record.title}\n${record.text}`), signal, assertBatch);
      selected = { ...selected, dimensions: selected.dimensions || vectors[0].length };
      batch.forEach((record, index) => { cache[vectorKey(record, selected)] = vectors[index]; });
      completed += batch.length;
      commitUnderAdmission(assertBatch, () => onProgress({ jobId, phase: 'embedding', completed, total: records.length }));
    }
    if (!selected.dimensions) throw new MemoryMapHostError('provider-embedding-failed');
    const assertProjection = () => { assertCatalog(); assertConsent(); };
    let projecting!: Promise<{ snapshot: GraphSnapshot; cache: VectorCache }>;
    commitUnderAdmission(assertProjection, () => {
      projecting = this.runWorker('', { kind: 'project', input: { ...catalog, namespace: selected, cache, jobId } }, signal, progress => {
        if (progress.phase === 'embedding') return;
        try { commitUnderAdmission(assertProjection, () => onProgress(progress)); } catch { /* Refused. */ }
      });
    });
    const result = await projecting;
    assertProjection();
    return result;
  }
}
