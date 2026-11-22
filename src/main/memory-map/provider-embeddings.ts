import { runWithCeiling } from '../../tools/executor-ceiling.js';
import { TOOL_TIMEOUT_POLICY } from '../../shared/tool-timeout-policy.js';
import { embedMany } from 'ai';
import type { SettingsService } from '../../data/settings-store.js';
import { createEmbeddingModel, secretKeyFor } from '../../engine/llm/provider-factory.js';
import { createPublicModelProviderFetch, selectProviderRuntimeFetch } from '../../engine/llm/marketplace-provider-fetch.js';
import { LLM_VENDORS, getLlmVendorSettings, canUseLlmVendorWithoutApiKey, isOpenAICompatibleVendor } from '../../shared/llm-vendor-defaults.js';
import { marketplaceProviderPresetSecretKey } from '../../shared/marketplace-package-assets.js';
import { createSafeLlmFetch } from '../safe-llm-fetch.js';
import { isDefaultModelListEndpoint } from '../../engine/llm/model-list.js';
import { MEMORY_EMBEDDING_CONSENT_VERSION, type MemoryEmbeddingConfig } from '../../shared/memory-embedding-config.js';
import type { EmbeddingNamespace, MemoryEmbeddingProvider, MemoryMapProgress, GraphSnapshot } from '../../shared/memory-map.js';
import type { MemoryMapCatalog } from './catalog.js';
import { runMemoryWorker, type MemoryWorkerRunner } from './worker-client.js';
import { LOCAL_NAMESPACE, vectorKey, type VectorCache } from './graph.js';
import { MemoryMapHostError } from './errors.js';
import type { ProviderEgress } from './provider-egress.js';

const EMBEDDING_BATCH_SIZE = 16;
const SDK_EMBEDDING_MODELS: Record<string, string[]> = {
  openai: ['text-embedding-3-small', 'text-embedding-3-large', 'text-embedding-ada-002'],
  gemini: ['gemini-embedding-001', 'gemini-embedding-2', 'gemini-embedding-2-preview'],
};
const DEFAULT_ENDPOINTS: Record<string, string> = { openai: 'https://api.openai.com/v1', gemini: 'https://generativelanguage.googleapis.com/v1beta' };
export function providerNamespace(providerId: string, modelId: string, dimensions = 0): EmbeddingNamespace {
  return { source: 'provider', providerId, modelId, modelRevision: modelId, preprocessingRevision: 'text-l2-v1', dimensions };
}
export class ProviderEmbeddings {
  private suspended = false;
  suspend(): void { this.suspended = true; }
  resume(): void { this.suspended = false; }
  constructor(private readonly settings: SettingsService, private readonly send: ProviderEgress, private readonly runWorker: MemoryWorkerRunner = runMemoryWorker) {}
  namespace(): EmbeddingNamespace {
    const config = this.settings.get('memoryEmbedding');
    return config?.source === 'provider' ? providerNamespace(config.providerId ?? '', config.modelId ?? '') : LOCAL_NAMESPACE;
  }
  private consent(providerId: string, modelId: string, signal?: AbortSignal): MemoryEmbeddingConfig {
    const config = this.settings.get('memoryEmbedding');
    const consent = config?.consent;
    if (signal?.aborted) throw new MemoryMapHostError('request-stale');
    if (this.suspended || config?.source !== 'provider' || config.providerId !== providerId || config.modelId !== modelId || consent?.version !== MEMORY_EMBEDDING_CONSENT_VERSION || consent.providerId !== providerId || consent.modelId !== modelId || !Number.isFinite(Date.parse(consent.timestamp))) throw new MemoryMapHostError('provider-consent-required');
    return config;
  }
  private route(providerId: string) {
    const preset = (this.settings.get('marketplace')?.installedProviderPresets ?? []).find(value => value.providerId === providerId);
    const vendor = preset ? 'openai-compatible' : LLM_VENDORS.find(value => value === providerId);
    if (!vendor) throw new MemoryMapHostError('provider-unavailable');
    const block = getLlmVendorSettings(this.settings.get('llm')?.vendors, vendor);
    const baseUrl = preset?.baseUrl ?? block.baseUrl ?? DEFAULT_ENDPOINTS[vendor];
    const secret = preset ? marketplaceProviderPresetSecretKey(preset.providerId) : secretKeyFor(vendor);
    return { vendor, block, baseUrl, preset, secret };
  }
  async providers(): Promise<MemoryEmbeddingProvider[]> {
    const candidates = [...LLM_VENDORS, ...(this.settings.get('marketplace')?.installedProviderPresets ?? []).map(value => value.providerId)];
    const result: MemoryEmbeddingProvider[] = [];
    for (const id of candidates) {
      const route = this.route(id);
      const { vendor, block, baseUrl, preset } = route;
      const keyless = preset ? preset.requiresApiKey === false && Boolean(baseUrl) : Boolean(this.settings.get('llm')?.vendors?.[vendor]?.baseUrl && block.model) && canUseLlmVendorWithoutApiKey(vendor, block);
      if (!keyless && !await this.settings.hasStoredSecret(route.secret)) continue;
      let models: string[] = [];
      const compatible = isOpenAICompatibleVendor(vendor) && (vendor !== 'openai-compatible' || !block.wire || block.wire === 'openai-chat' || block.wire === 'openai-responses' || Boolean(preset));
      if (SDK_EMBEDDING_MODELS[vendor] && (!block.baseUrl || block.baseUrl === DEFAULT_ENDPOINTS[vendor])) models = [...SDK_EMBEDDING_MODELS[vendor]!];
      for (const cached of Object.values(this.settings.get('llm')?.modelListCache ?? {})) {
        if (cached.vendor !== vendor || (preset ? cached.credentialScope !== preset.providerId || cached.baseUrl !== baseUrl : cached.credentialScope || !isDefaultModelListEndpoint(this.settings.get('llm').vendors, vendor, cached.endpoint))) continue;
        if (compatible || vendor === 'azure-foundry' || vendor === 'openai' || vendor === 'gemini' || (vendor === 'openai-compatible' && block.wire === 'google-gemini')) {
          for (const entry of cached.modelEntries ?? []) if (entry.outputModalities?.includes('embedding') && cached.models.includes(entry.id)) models.push(entry.id);
        }
      }
      result.push({ id, models: [...new Set(models)], ...(!models.length ? { reason: 'provider-no-embedding-model' as const } : {}) });
    }
    return result;
  }
  async validate(providerId: string, modelId: string): Promise<void> {
    const provider = (await this.providers()).find(value => value.id === providerId);
    if (!provider) throw new MemoryMapHostError('provider-unavailable');
    if (!provider.models.includes(modelId)) throw new MemoryMapHostError('provider-no-embedding-model');
  }
  async embed(namespace: EmbeddingNamespace, values: string[], signal: AbortSignal): Promise<number[][]> {
    const providerId = namespace.providerId ?? ''; const modelId = namespace.modelId;
    this.consent(providerId, modelId, signal);
    if (!values.length || values.length > EMBEDDING_BATCH_SIZE) throw new MemoryMapHostError('invalid-input');
    await this.validate(providerId, modelId);
    const route = this.route(providerId);
    if (!route.baseUrl || !this.send) throw new MemoryMapHostError('provider-unavailable');
    const configAtStart = JSON.stringify(this.settings.get('llm'));
    const presetAtStart = JSON.stringify(route.preset);
    const assertCurrent = () => {
      this.consent(providerId, modelId, signal);
      if (configAtStart !== JSON.stringify(this.settings.get('llm')) || presetAtStart !== JSON.stringify(this.route(providerId).preset)) throw new MemoryMapHostError('request-stale');
    };
    let egressError: MemoryMapHostError | undefined;
    const egress: typeof fetch = async (input, init) => {
      assertCurrent();
      const url = new URL(typeof input === 'string' || input instanceof URL ? input.toString() : input.url);
      if (url.origin !== new URL(route.baseUrl!).origin) throw new MemoryMapHostError('provider-unavailable');
      try {
        return await this.send(url, { ...init, signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal }, assertCurrent);
      } catch (error) {
        if (error instanceof MemoryMapHostError) egressError = error;
        throw error;
      }
    };
    const transport = selectProviderRuntimeFetch({ vendor: route.vendor, baseUrl: route.baseUrl, providerMetadata: route.preset, llmFetch: createSafeLlmFetch(egress), networkFetch: egress }) ?? createPublicModelProviderFetch(route.baseUrl, egress);
    const fetchImpl = transport;
    try {
      const apiKey = await this.settings.getSecret(route.secret) ?? '';
      if (!apiKey && (route.preset ? route.preset.requiresApiKey !== false : !canUseLlmVendorWithoutApiKey(route.vendor, route.block))) throw new MemoryMapHostError('provider-unavailable');
      assertCurrent();
      const model = await createEmbeddingModel({ vendor: route.vendor, apiKey, baseUrl: route.baseUrl, wire: route.block.wire, fetch: fetchImpl, providerMetadata: route.preset }, modelId);
      const outcome = await runWithCeiling(abortSignal => embedMany({ model, values, abortSignal, maxParallelCalls: 1, maxRetries: 0, telemetry: { isEnabled: false, recordInputs: false, recordOutputs: false } }), TOOL_TIMEOUT_POLICY.modelStreamIdleCeilingMs, signal, 'memory embeddings');
      if (!outcome.ok) throw outcome.error;
      const { embeddings } = outcome.value;
      assertCurrent();
      if (embeddings.length !== values.length) throw new MemoryMapHostError('provider-embedding-failed');
      const dimensions = namespace.dimensions || embeddings[0]?.length;
      return embeddings.map(vector => {
        if (!dimensions || dimensions > 65536 || vector.length !== dimensions) throw new MemoryMapHostError('provider-dimension-mismatch');
        const norm = Math.hypot(...vector);
        if (!Number.isFinite(norm) || !norm || vector.some(value => !Number.isFinite(value))) throw new MemoryMapHostError('provider-embedding-failed');
        return vector.map(value => value / norm);
      });
    } catch (error) {
      if (egressError) throw egressError;
      if (error instanceof MemoryMapHostError) throw error;
      throw new MemoryMapHostError(signal.aborted ? 'request-stale' : 'provider-embedding-failed');
    }
  }
  async build(catalog: MemoryMapCatalog, namespace: EmbeddingNamespace, saved: { snapshot: { model: { namespace: EmbeddingNamespace } } | null; cache: VectorCache }, signal: AbortSignal, onProgress: (progress: MemoryMapProgress) => void) {
    this.consent(namespace.providerId ?? '', namespace.modelId, signal);
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
      const vectors = await this.embed(selected, batch.map(record => record.title + '\n' + record.text), signal);
      selected = { ...selected, dimensions: selected.dimensions || vectors[0]!.length };
      batch.forEach((record, index) => { cache[vectorKey(record, selected)] = vectors[index]!; });
      completed += batch.length; onProgress({ jobId, phase: 'embedding', completed, total: records.length });
    }
    if (!selected.dimensions) throw new MemoryMapHostError('provider-embedding-failed');
    this.consent(selected.providerId ?? '', selected.modelId, signal);
    return this.runWorker<{ snapshot: GraphSnapshot; cache: VectorCache }>('', { kind: 'project', input: { ...catalog, namespace: selected, cache, jobId } }, signal, progress => { if (progress.phase !== 'embedding') onProgress(progress); });
  }
}
