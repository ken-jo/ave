import { mkdtemp, mkdir, open, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryMapHost } from '../host.js';
import { buildGraph, catalogRevision, LOCAL_NAMESPACE, vectorKey } from '../graph.js';
import { checkedInferenceFrameBytes, INFERENCE_FILES, MAX_INFERENCE_TASK_BYTES } from '../inference-request.js';
import type { MemoryMapCatalog } from '../catalog.js';
import type { MemoryWorkerRunner } from '../worker-client.js';
import type { FeatureNamespaceHandle } from '../../storage/feature-namespace.js';
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'memory-host-')); roots.push(root);
  const namespace: FeatureNamespaceHandle = { dir: root,
    readJson: async (_, fallback) => { try { return JSON.parse(await readFile(join(root, 'snapshot.json'), 'utf8')); } catch { return fallback; } },
    writeJson: async (name, value) => { await writeFile(join(root, name), JSON.stringify(value)); },
    childDir: async name => { const path = join(root, name); await mkdir(path, { recursive: true }); return path; },
    createFile: name => open(join(root, name), 'wx'),
  };
  const catalog: MemoryMapCatalog = { authorizationScopeId: 'scope', excluded: 0, records: [{ memoryId: 'id', contentRevision: 'hash', title: 'Title', text: 'Private body', sourceKind: 'user' }] };
  const runWorker: MemoryWorkerRunner = async <T>(_folder: string, task: Parameters<MemoryWorkerRunner>[1]) => {
    if (task.kind === 'embed-batch') return task.texts.map(() => [1, ...Array<number>(383).fill(0)]) as T;
    if (task.kind !== 'project') throw new Error('Unexpected task');
    return await buildGraph(task.input, {
      embed: async () => { throw new Error('Projection requires cached vectors'); }, dispose: async () => {},
    }, () => {}) as T;
  };
  return { root, namespace, catalog, runWorker };
}
describe('memory graph publication', () => {
  it('embeds a first build across multiple inference frames in catalog order', async () => {
    const f = await fixture();
    const body = '\0'.repeat(512 * 1024 - 32);
    const records = Array.from({ length: 63 }, (_, index) => ({
      ...f.catalog.records[0], memoryId: `note-${index}`, title: `Note ${index}`, text: body,
    }));
    f.catalog.records = records;
    const vectors = records.map((_, index) => Array.from({ length: 384 }, (_, dimension) => Number(dimension === index)));
    const progress: { completed: number; total: number; memoryId?: string }[] = [];
    const batches: number[] = [];
    let embedded = 0;
    const runWorker: MemoryWorkerRunner = async <T>(...args: Parameters<MemoryWorkerRunner>) => {
      const [, task, , onProgress] = args;
      if (task.kind !== 'embed-batch') return f.runWorker<T>(...args);
      checkedInferenceFrameBytes([Buffer.byteLength(JSON.stringify(task)), ...INFERENCE_FILES.map(file => file.bytes)]);
      batches.push(task.texts.length);
      return task.texts.map((text, index) => {
        const record = records[embedded];
        expect(text === `${record.title}\n${record.text}`).toBe(true);
        onProgress?.({ jobId: task.jobId, phase: 'embedding', completed: index + 1, total: task.texts.length });
        return vectors[embedded++];
      }) as T;
    };
    const host = new MemoryMapHost({ namespace: f.namespace, validatedModelPath: async () => 'model', runWorker,
      onProgress: event => { if (event.phase === 'embedding') progress.push(event); },
    });

    const result = await host.build(() => f.catalog);
    expect(batches).toHaveLength(2);
    expect(result.coverage.embedded).toBe(records.length);
    expect(progress).toEqual(records.map(({ memoryId }, index) => expect.objectContaining({
      memoryId, completed: index + 1, total: records.length,
    })));
    const { cache } = JSON.parse(await readFile(join(f.root, 'snapshot.json'), 'utf8'));
    for (const [index, record] of records.entries()) expect(cache[vectorKey(record, LOCAL_NAMESPACE)]).toEqual(vectors[index]);
  });

  it('refuses a single note that cannot fit in an inference frame', async () => {
    const f = await fixture();
    f.catalog.records[0].text = '\0'.repeat(Math.ceil(MAX_INFERENCE_TASK_BYTES / 6));
    const host = new MemoryMapHost({ namespace: f.namespace, validatedModelPath: async () => 'model',
      runWorker: async () => { throw new Error('Unexpected inference request'); },
    });
    await expect(host.build(() => f.catalog)).rejects.toMatchObject({ code: 'catalog-too-large' });
    await expect(readFile(join(f.root, 'snapshot.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rebuilds with 4,000 cached vectors and only sends uncached note text to inference', async () => {
    const f = await fixture();
    const base = await buildGraph({ ...f.catalog, records: [], namespace: LOCAL_NAMESPACE, cache: {}, jobId: 'seed' }, {
      embed: async () => { throw new Error('Unexpected embedding'); }, dispose: async () => {},
    }, () => {});
    const samples = Array.from({ length: 384 }, (_, index) => Math.sin(index + 1));
    const norm = Math.hypot(...samples);
    const vector = samples.map(sample => sample / norm);
    const records = Array.from({ length: 4_001 }, (_, index) => ({
      ...f.catalog.records[0], memoryId: `note-${index}`, text: 'Cached content '.repeat(40),
    }));
    const [uncached] = records.splice(4_000);
    uncached.text = 'Only the new note needs inference';
    const cache = Object.fromEntries(records.map(record => [vectorKey(record, LOCAL_NAMESPACE), vector]));
    await f.namespace.writeJson('snapshot.json', { snapshot: base.snapshot, cache });
    f.catalog.records = [...records, uncached];
    const inferenceTasks: unknown[] = [];
    const runWorker: MemoryWorkerRunner = async <T>(_folder: string, task: Parameters<MemoryWorkerRunner>[1]) => {
      if (task.kind === 'project') {
        expect(Object.keys(task.input.cache)).toHaveLength(4_001);
        expect(task.input.cache[vectorKey(records[0], LOCAL_NAMESPACE)]).toEqual(vector);
        expect(task.input.cache[vectorKey(uncached, LOCAL_NAMESPACE)]).toEqual(vector);
        return { cache: task.input.cache, snapshot: {
          ...base.snapshot, catalogRevision: catalogRevision(task.input.records),
          coverage: { eligible: 4_001, embedded: 4_001, pending: 0, excluded: 0 },
          points: task.input.records.map(({ text, ...record }) => ({ ...record, x: 0, y: 0 })),
        } } as T;
      }
      checkedInferenceFrameBytes([Buffer.byteLength(JSON.stringify(task)), ...INFERENCE_FILES.map(file => file.bytes)]);
      inferenceTasks.push(task);
      return [vector] as T;
    };
    const host = new MemoryMapHost({ namespace: f.namespace, validatedModelPath: async () => 'model', runWorker });
    const result = await host.build(() => f.catalog);
    expect(result.coverage.embedded).toBe(4_001);
    expect(inferenceTasks).toEqual([{ kind: 'embed-batch', jobId: expect.any(String), texts: [`${uncached.title}\n${uncached.text}`] }]);
    await expect(host.build(() => f.catalog)).resolves.toEqual(result);
    expect(inferenceTasks).toHaveLength(1);
  });

  it('atomically publishes vectors and coordinates, and invalidates changed or deleted sources', async () => {
    const f = await fixture(); const host = new MemoryMapHost({ namespace: f.namespace, validatedModelPath: async () => 'model', runWorker: f.runWorker });
    const result = await host.build(() => f.catalog);
    expect(await host.get(() => f.catalog)).toEqual(result);
    const restarted = new MemoryMapHost({ namespace: f.namespace, validatedModelPath: async () => 'model', runWorker: f.runWorker });
    expect(await restarted.get(() => f.catalog)).toEqual(result);
    expect(await readFile(join(f.root, 'snapshot.json'), 'utf8')).not.toContain('Private body');
    f.catalog.records = [];
    expect(await host.get(() => f.catalog)).toBeNull();
    expect(JSON.parse(await readFile(join(f.root, 'snapshot.json'), 'utf8')).cache).toEqual({});
  });
  it('refuses persisted identities outside the current authorized catalog', async () => {
    const f = await fixture(); const host = new MemoryMapHost({ namespace: f.namespace, validatedModelPath: async () => 'model', runWorker: f.runWorker });
    const snapshot = await host.build(() => f.catalog);
    snapshot.points[0].memoryId = 'outside';
    await f.namespace.writeJson('snapshot.json', { snapshot, cache: {} });
    const restarted = new MemoryMapHost({ namespace: f.namespace, validatedModelPath: async () => 'model', runWorker: f.runWorker });
    await expect(restarted.get(() => f.catalog)).rejects.toThrow('identity is invalid');
  });
  it('drops a stale question when a newer query completes first', async () => {
    const f = await fixture(); let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve; });
    let started!: () => void; const start = new Promise<void>(resolve => { started = resolve; });
    const runner: MemoryWorkerRunner = async <T>(folder: string, task: Parameters<MemoryWorkerRunner>[1], signal: AbortSignal) => {
      if (task.kind !== 'embed') return f.runWorker<T>(folder, task, signal);
      if (task.text === 'first') { started(); await wait; }
      return [1, ...Array<number>(383).fill(0)] as T;
    };
    const host = new MemoryMapHost({ namespace: f.namespace, validatedModelPath: async () => 'model', runWorker: runner });
    const snapshot = await host.build(() => f.catalog);
    const old = host.retrieve(() => f.catalog, { question: 'first', filters: {}, queryId: 'first', snapshotId: snapshot.snapshotId }); await start;
    const answer = await host.retrieve(() => f.catalog, { question: 'second', filters: {}, queryId: 'second', snapshotId: snapshot.snapshotId });
    expect(answer.queryId).toBe('second'); release(); await expect(old).rejects.toThrow('request-stale');
  });
  it('drops a completed old build on cancellation or scope change', async () => {
    const f = await fixture(); let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve; });
    let started!: () => void; const start = new Promise<void>(resolve => { started = resolve; });
    const runner: MemoryWorkerRunner = async <T>(folder: string, task: Parameters<MemoryWorkerRunner>[1], signal: AbortSignal) => { started(); await wait; return f.runWorker<T>(folder, task, signal); };
    const host = new MemoryMapHost({ namespace: f.namespace, validatedModelPath: async () => 'model', runWorker: runner });
    const build = host.build(() => f.catalog); await start;
    await host.get(() => ({ ...f.catalog, authorizationScopeId: 'other' })); release();
    await expect(build).rejects.toThrow('request-stale');
    expect(await host.get(() => f.catalog)).toBeNull();
  });
});
