import type { MemoryEmbeddingConsent } from './memory-embedding-config.js';
import type { MemoryModelStatus } from './memory-model.js';
export type MemoryMapSource = 'user' | 'assistant' | 'import' | 'capture' | 'unknown';
export interface EmbeddingNamespace {
  source: 'local' | 'provider';
  providerId?: string;
  modelId: string;
  modelRevision: string;
  preprocessingRevision: string;
  dimensions: number;
}
export interface MemoryMapFilters { sources?: MemoryMapSource[]; projectIds?: string[]; playbookIds?: string[]; text?: string }
export interface MemoryMapRecord {
  memoryId: string; contentRevision: string; title: string; text: string; sourceKind: MemoryMapSource;
  projectId?: string; projectName?: string;
}
interface MemoryMapPoint {
  memoryId: string; contentRevision: string; title: string; sourceKind: MemoryMapSource;
  projectId?: string; projectName?: string; x: number; y: number;
}
export interface GraphSnapshot {
  snapshotId: string; catalogRevision: string; authorizationScopeId: string;
  model: { id: string; revision: string; dimensions: number; preprocessingRevision: string; namespace: EmbeddingNamespace };
  projection: { algorithm: 'umap'; dimensions: 2; version: string; seed: number; parameters: { nNeighbors: number; minDist: number; nEpochs: number } };
  status: 'unconfigured' | 'building' | 'ready' | 'stale' | 'failed';
  coverage: { eligible: number; embedded: number; pending: number; excluded: number };
  points: MemoryMapPoint[];
  edges: { a: string; b: string; similarity: number; kind: 'semantic-neighbour' }[];
}
export interface MemoryFacets {
  sources: { sourceKind: MemoryMapSource; count: number }[];
  projects: { projectId: string; name: string; count: number }[];
  playbooks: { playbookId: string; name: string; count: number }[];
}
export interface RetrievalAnswer {
  snapshotId: string; catalogRevision: string; queryId: string;
  matches: { memoryId: string; contentRevision: string; excerpt: string; score: number; citation: number }[];
  answerParts: { text: string; sourceMemoryIds: string[]; citation: number }[];
}
export interface MemoryMapProgress { jobId: string; phase: 'embedding' | 'neighbours' | 'projection'; completed: number; total: number; memoryId?: string }
export interface MemoryEmbeddingProvider {
  id: string;
  models: string[];
  route?: { endpointId: string; origin: string };
  reason?: 'provider-no-embedding-model' | 'provider-route-ineligible';
}
export type MemoryEmbeddingSelection = { source: 'local' } | { source: 'provider'; providerId: string; modelId: string; endpointId: string; consent: boolean };
type MemoryEmbeddingSettingsUpdate = MemoryEmbeddingSelection | { localInferenceWithoutSandbox: boolean };
export interface MemoryEmbeddingSettings { source: 'local' | 'provider'; namespace: EmbeddingNamespace; providerAvailable: boolean; providers: MemoryEmbeddingProvider[]; consent?: MemoryEmbeddingConsent; localInferenceWithoutSandbox?: boolean }
export type MemoryMapError = 'unauthorized-frame' | 'invalid-input' | 'catalog-too-large' | 'project-not-allowed' | 'model-unconfigured' | 'model-integrity-failed' | 'local-runtime-unavailable' | 'local-inference-disabled' | 'sandbox-home-unavailable' | 'graph-unavailable' | 'graph-stale' | 'graph-build-failed' | 'request-stale' | 'provider-unavailable' | 'provider-no-embedding-model' | 'provider-route-ineligible' | 'provider-consent-required' | 'provider-embedding-failed' | 'provider-dimension-mismatch' | 'model-download-failed' | 'model-folder-invalid' | 'model-cancelled';
type MemoryMapResult<T> = { ok: true; value: T } | { ok: false; error: MemoryMapError };
export interface MemoryMapScope { projectRoot?: string; projectName?: string; includeUnscoped?: boolean }
export interface MemoryMapApi {
  get: (scope?: MemoryMapScope) => Promise<MemoryMapResult<GraphSnapshot | null>>;
  build: (scope?: MemoryMapScope) => Promise<MemoryMapResult<GraphSnapshot>>;
  cancel: () => Promise<MemoryMapResult<null>>;
  facets: (scope?: MemoryMapScope) => Promise<MemoryMapResult<MemoryFacets>>;
  retrieve: (request: { scope?: MemoryMapScope; question: string; filters: MemoryMapFilters; snapshotId: string; queryId: string }) => Promise<MemoryMapResult<RetrievalAnswer>>;
  modelStatus: () => Promise<MemoryMapResult<MemoryModelStatus>>;
  modelDownload: () => Promise<MemoryMapResult<MemoryModelStatus>>;
  modelCancel: () => Promise<MemoryMapResult<null>>;
  modelUseExisting: () => Promise<MemoryMapResult<MemoryModelStatus | null>>;
  settingsGet: () => Promise<MemoryMapResult<MemoryEmbeddingSettings>>;
  settingsSet: (settings: MemoryEmbeddingSettingsUpdate) => Promise<MemoryMapResult<MemoryEmbeddingSettings>>;
  onProgress: (callback: (progress: MemoryMapProgress) => void) => () => void;
  onModelProgress: (callback: (progress: MemoryModelStatus) => void) => () => void;
}
