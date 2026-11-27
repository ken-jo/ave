import { mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { deferred } from '../../../__tests__/support/deferred.js';
import type { SettingsService } from '../../../data/settings-store.js';
import { MEMORY_EMBEDDING_CONSENT_VERSION, type MemoryEmbeddingConfig } from '../../../shared/memory-embedding-config.js';
import type { MemoryMapProgress } from '../../../shared/memory-map.js';
import type { FeatureNamespaceHandle } from '../../storage/feature-namespace.js';
import type { MemoryMapCatalog, ReadMemoryMapCatalog } from '../catalog.js';
import { buildGraph, LOCAL_NAMESPACE, vectorKey } from '../graph.js';
import { MemoryMapHost } from '../host.js';
import { ProviderEmbeddings } from '../provider-embeddings.js';
import type { MemoryWorkerRunner, MemoryWorkerTask } from '../worker-client.js';

const roots: string[] = [];
const catalog: MemoryMapCatalog = {
  authorizationScopeId: 'scope', excluded: 0,
  records: [{ memoryId: 'note', contentRevision: 'original', title: 'Title', text: 'Body', sourceKind: 'user' }],
};
const otherNote = { ...catalog.records[0], memoryId: 'another-note' };
const cpuOnly = { embed: async () => { throw new Error('Unexpected embedding'); }, dispose: async () => {} };
const vector = [1, ...Array<number>(LOCAL_NAMESPACE.dimensions - 1).fill(0)];
const savedGraph = () => buildGraph({
  ...catalog, namespace: LOCAL_NAMESPACE, cache: { [vectorKey(catalog.records[0], LOCAL_NAMESPACE)]: vector }, jobId: 'local',
}, cpuOnly, () => {});

afterEach(async () => {
  for (const dir of roots.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function useMemoryMapNamespace(): Promise<FeatureNamespaceHandle> {
  const dir = await mkdtemp(join(tmpdir(), 'memory-map-parity-'));
  roots.push(dir);
  return {
    dir,
    readJson: async (_name, fallback) => fallback,
    childDir: async () => dir,
    writeJson: async () => { throw new Error('Unexpected write'); },
    createFile: name => open(join(dir, name), 'wx'),
  };
}

it.each(['catalog change', 'consent renewal'] as const)('forwards provider projection events after a %s', async change => {
  const namespace = await useMemoryMapNamespace();
  let currentCatalog = catalog;
  const readCatalog: ReadMemoryMapCatalog = Object.assign(vi.fn(() => currentCatalog), { recordsAreCurrent: () => true });
  const config: MemoryEmbeddingConfig = { source: 'provider', providerId: 'openai', modelId: 'text-embedding-3-small' };
  const settings = { get: (name: string) => name === 'memoryEmbedding' ? config : undefined } as unknown as SettingsService;
  const progress: MemoryMapProgress[] = [];
  const runProject: MemoryWorkerRunner = async <T>(
    _folder: string, task: MemoryWorkerTask, _signal: AbortSignal, report?: (progress: MemoryMapProgress) => void,
  ): Promise<T> => {
    if (task.kind !== 'project') throw new Error('Unexpected local inference');
    report?.({ jobId: task.input.jobId, phase: 'neighbours', completed: 1, total: 1 });
    report?.({ jobId: task.input.jobId, phase: 'projection', completed: 1, total: 1 });
    return await buildGraph(task.input, cpuOnly, () => {}) as T;
  };
  const provider = new ProviderEmbeddings(settings, {
    isRouteEligible: () => true,
    send: async () => { throw new Error('Unexpected network'); },
  }, runProject);
  const consent: NonNullable<MemoryEmbeddingConfig['consent']> = {
    version: MEMORY_EMBEDDING_CONSENT_VERSION, providerId: 'openai', modelId: 'text-embedding-3-small',
    endpointId: provider.namespace().modelRevision, timestamp: '2026-01-01T00:00:00.000Z',
  };
  config.consent = consent;
  vi.spyOn(provider, 'embed').mockImplementationOnce(async () => {
    if (change === 'consent renewal') config.consent = { ...consent, timestamp: '2026-01-02T00:00:00.000Z' };
    return [[1, 0]];
  });
  const host = new MemoryMapHost({
    namespace, provider, validatedModelPath: async () => { throw new Error('Unexpected model'); },
    onProgress: update => {
      progress.push(update);
      if (change === 'catalog change' && update.phase === 'embedding') {
        currentCatalog = { ...catalog, records: [...catalog.records, otherNote] };
      }
    },
  });
  const result = host.build(readCatalog);
  if (change === 'catalog change') await expect(result).rejects.toMatchObject({ code: 'request-stale' });
  else await expect(result).resolves.toMatchObject({ status: 'ready' });
  expect(progress.map(update => update.phase)).toEqual(['embedding', 'neighbours', 'projection']);
});

it('hydrates a saved graph against the initial catalog while generation stays live', async () => {
  const namespace = await useMemoryMapNamespace();
  const saved = await savedGraph();
  const reading = deferred<void>();
  namespace.readJson = async <T>() => { await reading.promise; return saved as T; };
  const host = new MemoryMapHost({ namespace, validatedModelPath: async () => 'unused' });
  let currentCatalog = catalog;
  const getting = host.get(() => currentCatalog);
  currentCatalog = { ...catalog, records: [...catalog.records, otherNote] };
  reading.resolve();
  await expect(getting).resolves.toMatchObject({ snapshotId: saved.snapshot.snapshotId });
});

it('resolves an invalidation superseded during directory preparation', async () => {
  const namespace = await useMemoryMapNamespace();
  const preparing = deferred<string>();
  namespace.childDir = () => preparing.promise;
  const host = new MemoryMapHost({ namespace, validatedModelPath: async () => 'unused' });
  const invalidating = host.invalidate();
  host.cancel();
  preparing.resolve(namespace.dir);
  await expect(invalidating).resolves.toBeUndefined();
});

it('reads the catalog exactly three times after projection to publish a stable graph', async () => {
  const namespace = await useMemoryMapNamespace();
  const readCatalog = vi.fn(() => catalog);
  let readsAtProjection = 0;
  const runWorker: MemoryWorkerRunner = async <T>(_folder: string, task: MemoryWorkerTask): Promise<T> => {
    if (task.kind === 'embed-batch') return [vector] as T;
    if (task.kind !== 'project') throw new Error('Unexpected retrieval');
    const result = await buildGraph(task.input, cpuOnly, () => {});
    readsAtProjection = readCatalog.mock.calls.length;
    return result as T;
  };
  const host = new MemoryMapHost({
    namespace, runWorker,
    validatedModelPath: async (_signal?: AbortSignal, onAdmission?: (assertLive: () => void) => void) => {
      onAdmission?.(() => {});
      return namespace.dir;
    },
    ...{ refreshLocalAdmission: async () => () => {} },
  });
  await expect(host.build(readCatalog)).resolves.toMatchObject({ status: 'ready' });
  expect(readCatalog.mock.calls.length - readsAtProjection).toBe(3);
});
