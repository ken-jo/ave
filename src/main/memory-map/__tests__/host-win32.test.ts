import * as atomicFile from '../../../lib/atomic-file.js';
import { deferred } from '../../../__tests__/support/deferred.js';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { lstat, mkdir, readFile, realpath, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryMapHost } from '../host-win32.js';
import { MemoryMapHostError } from '../errors.js';
import { buildGraph, catalogRevision, LOCAL_NAMESPACE, vectorKey } from '../graph.js';
import { checkedInferenceFrameBytes, INFERENCE_FILES, MAX_INFERENCE_TASK_BYTES } from '../inference-request.js';
import { LocalModelManager } from '../model-manager-win32.js';
import { LOCAL_MODEL_REVISION } from '../model-manifest.js';
import type { MemoryWorkerRunner } from '../worker-client-win32.js';
import { createHostFixture } from './host-fixtures.js';

const inferenceBudget = vi.hoisted(() => ({ bytes: undefined as number | undefined }));
vi.mock(import('../inference-request.js'), async importOriginal => {
  const actual = await importOriginal();
  return {
    ...actual,
    get MAX_INFERENCE_TASK_BYTES() { return inferenceBudget.bytes ?? actual.MAX_INFERENCE_TASK_BYTES; },
  };
});

const allowLocal = async () => () => {};
const validatedModelPath: ConstructorParameters<typeof MemoryMapHost>[0]['validatedModelPath'] = async (_signal, onAdmission) => {
  onAdmission?.(() => {});
  return 'model';
};
const roots: string[] = [];
afterEach(async () => {
  inferenceBudget.bytes = undefined;
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const fixture = createHostFixture(roots);
describe('memory graph publication', () => {
  it.each(['embed-batch', 'project'] as const)('refuses publication when the catalog changes during %s progress', async phase => {
    const f = await fixture();
    const reached = deferred<void>();
    const resume = deferred<void>();
    let catalog = f.catalog;
    const onProgress = vi.fn();
    const runWorker: MemoryWorkerRunner = async <T>(...args: Parameters<MemoryWorkerRunner>) => {
      const [, task, , progress] = args;
      if (task.kind === phase) {
        reached.resolve();
        await resume.promise;
        progress?.({ jobId: 'old', phase: phase === 'embed-batch' ? 'embedding' : 'projection', completed: 1, total: 1 });
      }
      return f.runWorker<T>(...args);
    };
    const host = new MemoryMapHost({ namespace: f.namespace, refreshLocalAdmission: allowLocal, validatedModelPath, runWorker, onProgress });
    const result = host.build(() => catalog);
    await reached.promise;
    catalog = { ...catalog, records: [] };
    resume.resolve();
    await expect(result).rejects.toMatchObject({ code: 'request-stale' });
    expect(onProgress).not.toHaveBeenCalled();
  });

  it.runIf(process.platform === 'win32').each([false, true])('bounds cold embedding catalog reads and suppresses stale progress (stale: %s)', async stale => {
    const f = await fixture();
    f.catalog.records = Array.from({ length: 192 }, (_, index) => ({
      ...f.catalog.records[0], memoryId: `note-${index}`,
    }));
    let catalog = f.catalog;
    const readCatalog = vi.fn(() => catalog);
    const onProgress = vi.fn((event: { completed: number }) => {
      if (stale && event.completed === 96) catalog = { ...catalog, authorizationScopeId: 'replacement' };
    });
    const runWorker: MemoryWorkerRunner = async <T>(...args: Parameters<MemoryWorkerRunner>) => {
      const [, task, , report] = args;
      if (task.kind === 'embed-batch') {
        for (const index of task.texts.keys()) {
          report?.({ jobId: task.jobId, phase: 'embedding', completed: index + 1, total: task.texts.length });
        }
      }
      return f.runWorker<T>(...args);
    };
    const host = new MemoryMapHost({ namespace: f.namespace, refreshLocalAdmission: allowLocal, validatedModelPath, runWorker, onProgress });
    const result = host.build(readCatalog);
    if (stale) await expect(result).rejects.toMatchObject({ code: 'request-stale' });
    else await expect(result).resolves.toMatchObject({ coverage: { embedded: 192 } });
    const updates = onProgress.mock.calls.map(([progress]) => progress.completed);
    expect(updates[0]).toBe(1);
    expect(updates.at(-1)).toBe(stale ? 96 : 192);
    expect(readCatalog.mock.calls.length).toBeLessThan(80);
  });

  it('refuses saved graph hydration after the caller scope changes', async () => {
    const f = await fixture();
    const options = { namespace: f.namespace, refreshLocalAdmission: allowLocal, validatedModelPath, runWorker: f.runWorker };
    const ready = await new MemoryMapHost(options).build(() => f.catalog);
    let catalog = f.catalog;
    const host = new MemoryMapHost(options);
    const reading = deferred<void>();
    const resume = deferred<void>();
    const readJson = f.namespace.readJson;
    f.namespace.readJson = async (name, fallback) => {
      const saved = await readJson(name, fallback);
      reading.resolve();
      await resume.promise;
      return saved;
    };
    const result = host.get(() => catalog);
    await reading.promise;
    catalog = { ...catalog, authorizationScopeId: 'replacement' };
    resume.resolve();
    await expect(result).rejects.toMatchObject({ code: 'request-stale' });
    expect(await host.get(() => f.catalog)).toEqual(ready);
  });

  it('returns the current replacement when a refresh sees an older saved graph', async () => {
    const f = await fixture();
    const resume = deferred<void>();
    const host = new MemoryMapHost({
      namespace: f.namespace, refreshLocalAdmission: allowLocal, runWorker: f.runWorker,
      validatedModelPath,
    });
    await host.build(() => f.catalog);
    const catalog = { ...f.catalog, records: [] };
    const readSaved = f.namespace.readJson;
    vi.spyOn(f.namespace, 'readJson').mockImplementationOnce(async (name, fallback) => {
      await resume.promise;
      return readSaved(name, fallback);
    });
    const replacement = host.build(() => catalog).then(value => ({ value }), error => ({ error }));
    let current: Awaited<ReturnType<typeof host.get>>;
    try {
      current = await host.get(() => catalog);
    } finally {
      resume.resolve();
    }
    expect.soft(current).toMatchObject({ status: 'building' });
    expect(await replacement).toMatchObject({ value: { status: 'ready' } });
  });

  it('refuses a held old clear while another scope is building', async () => {
    const f = await fixture();
    const preparingClear = deferred<void>();
    const resumeClear = deferred<void>();
    const preparingBuild = deferred<void>();
    const resumeBuild = deferred<void>();
    let holdBuild = false;
    const host = new MemoryMapHost({ namespace: f.namespace, refreshLocalAdmission: allowLocal,
      validatedModelPath: async (...args) => {
        if (holdBuild) { preparingBuild.resolve(); await resumeBuild.promise; }
        return validatedModelPath(...args);
      }, runWorker: f.runWorker });
    await host.build(() => f.catalog);
    const destination = join(f.root, 'snapshot.json');
    const saved = await readFile(destination, 'utf8');
    const childDir = f.namespace.childDir;
    f.namespace.childDir = async (name, options) => {
      preparingClear.resolve();
      await resumeClear.promise;
      options?.assertStillValid?.();
      return childDir(name, options);
    };
    const result = host.get(() => ({ ...f.catalog, records: [] }));
    await preparingClear.promise;
    holdBuild = true;
    const build = host.build(() => ({ ...f.catalog, authorizationScopeId: 'replacement' }));
    await preparingBuild.promise;
    try {
      resumeClear.resolve();
      await expect(result).rejects.toMatchObject({ code: 'request-stale' });
      expect(await readFile(destination, 'utf8')).toBe(saved);
    } finally { resumeBuild.resolve(); await build; }
  });

  it.each([
    ['before projection', 'local-runtime-unavailable'],
    ['before publication', 'local-runtime-unavailable'],
    ['before projection', 'local-inference-disabled'],
    ['before publication', 'local-inference-disabled'],
  ] as const)('refuses a cached build %s on %s', async (boundary, code) => {
    const f = await fixture();
    let allowed = true;
    const refreshLocalAdmission = async () => () => {
      if (!allowed) throw new MemoryMapHostError(code);
    };
    const runWorker = vi.fn(f.runWorker);
    const host = new MemoryMapHost({
      namespace: f.namespace, validatedModelPath, refreshLocalAdmission,
      runWorker: async <T>(...args: Parameters<MemoryWorkerRunner>) => await runWorker(...args) as T,
    });
    await host.build(() => f.catalog);
    const path = join(f.root, 'snapshot.json');
    const previous = await readFile(path);
    runWorker.mockClear();
    if (boundary === 'before projection') {
      const readJson = f.namespace.readJson;
      f.namespace.readJson = async (...args) => {
        const saved = await readJson(...args);
        allowed = false;
        return saved;
      };
    } else {
      const childDir = f.namespace.childDir;
      f.namespace.childDir = async name => {
        const path = await childDir(name);
        allowed = false;
        return path;
      };
    }

    const outcome = await host.build(() => f.catalog).catch((error: unknown) => error);
    expect.soft(outcome).toMatchObject({ code });
    expect.soft(runWorker.mock.calls.map(([, task]) => task.kind))
      .toEqual(boundary === 'before projection' ? [] : ['project']);
    expect(await readFile(path)).toEqual(previous);
  });

  it.each(['succeeds', 'fails'] as const)('keeps a replaced model slot until the pending build %s', async outcome => {
    const f = await fixture();
    const parent = join(f.root, 'multilingual-e5-small');
    const previousSlot = join(parent, `${LOCAL_MODEL_REVISION}-11111111-1111-4111-8111-111111111111`);
    const previousFolder = join(previousSlot, 'onnx');
    const replacement = join(parent, LOCAL_MODEL_REVISION);
    const file = { name: 'weights.bin', bytes: 5, sha256: createHash('sha256').update('model').digest('hex') };
    for (const folder of [previousFolder, replacement]) {
      await mkdir(folder, { recursive: true });
      await writeFile(join(folder, file.name), 'model');
    }
    let savedPath = previousSlot;
    const model = new LocalModelManager({ namespace: f.namespace, files: [file],
      readPath: () => savedPath, savePath: path => { savedPath = path; },
    });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let started!: (folder: string) => void;
    const start = new Promise<string>(resolve => { started = resolve; });
    const runWorker: MemoryWorkerRunner = async <T>(...args: Parameters<MemoryWorkerRunner>) => {
      const [folder, task] = args;
      if (task.kind === 'embed-batch') {
        started(folder);
        await gate;
        expect(await readFile(join(folder, file.name), 'utf8')).toBe('model');
        if (outcome === 'fails') throw new Error('Inference failed');
      }
      return f.runWorker<T>(...args);
    };
    const host = new MemoryMapHost({ namespace: f.namespace, refreshLocalAdmission: allowLocal, validatedModelPath: (_signal, onAdmission) => { onAdmission?.(() => {}); return model.validatedPath(); }, runWorker });
    const build = host.build(() => f.catalog);
    try {
      expect(await Promise.race([start, build])).toBe(await realpath(previousFolder));
      expect(await model.adoptExistingFolder(replacement)).toMatchObject({ status: 'ready' });
      expect(savedPath).toBe(await realpath(replacement));
      await expect(readFile(join(previousFolder, file.name), 'utf8')).resolves.toBe('model');
      release();
      if (outcome === 'fails') await expect(build).rejects.toThrow('Inference failed');
      else await expect(build).resolves.toMatchObject({ status: 'ready' });
      expect(await model.adoptExistingFolder(replacement)).toMatchObject({ status: 'ready' });
      await expect(lstat(previousSlot)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      release();
      await build.catch(() => {});
    }
  });
  it('embeds a first build across multiple inference frames in catalog order', async () => {
    const f = await fixture();
    inferenceBudget.bytes = 400;
    const body = '\0'.repeat(16);
    const records = Array.from({ length: 5 }, (_, index) => ({
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
      const taskBytes = Buffer.byteLength(JSON.stringify(task));
      expect(taskBytes).toBeLessThanOrEqual(MAX_INFERENCE_TASK_BYTES);
      checkedInferenceFrameBytes([taskBytes, ...INFERENCE_FILES.map(file => file.bytes)]);
      batches.push(task.texts.length);
      return task.texts.map((text, index) => {
        const record = records[embedded];
        expect(text === `${record.title}\n${record.text}`).toBe(true);
        onProgress?.({ jobId: task.jobId, phase: 'embedding', completed: index + 1, total: task.texts.length });
        return vectors[embedded++];
      }) as T;
    };
    const host = new MemoryMapHost({ namespace: f.namespace, refreshLocalAdmission: allowLocal, validatedModelPath, runWorker,
      onProgress: event => { if (event.phase === 'embedding') progress.push(event); },
    });

    const result = await host.build(() => f.catalog);
    expect(batches).toEqual([3, 2]);
    expect(result.coverage.embedded).toBe(records.length);
    expect(progress).toEqual(records.map(({ memoryId }, index) => expect.objectContaining({
      memoryId, completed: index + 1, total: records.length,
    })));
    const { cache } = JSON.parse(await readFile(join(f.root, 'snapshot.json'), 'utf8'));
    for (const [index, record] of records.entries()) expect(cache[vectorKey(record, LOCAL_NAMESPACE)]).toEqual(vectors[index]);
  });

  it.each(['failure', 'cancellation'] as const)('preserves the previous snapshot after a second-batch %s', async interruption => {
    class InspectableMemoryMapHost extends MemoryMapHost {
      get cacheKeys(): string[] { return Object.keys(this.cache); }
    }

    const f = await fixture();
    const [previousRecord] = f.catalog.records;
    const records = [
      { ...previousRecord, memoryId: 'note-1', title: 'First note' },
      { ...previousRecord, memoryId: 'note-2', title: 'Second note' },
    ];
    const catalog = { ...f.catalog, records };
    const expectedBatches = records.map(record => [`${record.title}\n${record.text}`]);
    const batches: string[][] = [];
    const failure = new Error('Second embedding batch failed');
    let cancelledSignal: AbortSignal | undefined;
    const runWorker: MemoryWorkerRunner = async <T>(...args: Parameters<MemoryWorkerRunner>) => {
      const [, task, signal] = args;
      if (task.kind === 'embed-batch') {
        batches.push(task.texts);
        if (batches.length === 2) {
          if (interruption === 'failure') throw failure;
          cancelledSignal = signal;
          host.cancel();
          signal.throwIfAborted();
        }
      }
      return f.runWorker<T>(...args);
    };
    const host = new InspectableMemoryMapHost({ namespace: f.namespace, refreshLocalAdmission: allowLocal, validatedModelPath, runWorker });
    await host.build(() => f.catalog);
    const path = join(f.root, 'snapshot.json');
    const previousBytes = await readFile(path);
    batches.length = 0;
    inferenceBudget.bytes = 120;

    const build = host.build(() => catalog);
    if (interruption === 'failure') {
      await expect(build).rejects.toBe(failure);
    } else {
      await expect(build).rejects.toMatchObject({ code: 'request-stale' });
      expect(cancelledSignal?.aborted).toBe(true);
    }
    expect(batches).toEqual(expectedBatches);
    const storedBytes = await readFile(path);
    expect.soft(storedBytes.equals(previousBytes), 'snapshot.json bytes changed').toBe(true);
    const previousCacheKeys = [vectorKey(previousRecord, LOCAL_NAMESPACE)];
    expect.soft(Object.keys(JSON.parse(storedBytes.toString('utf8')).cache)).toEqual(previousCacheKeys);
    expect.soft(host.cacheKeys).toEqual(previousCacheKeys);

    await expect(host.build(() => catalog)).resolves.toMatchObject({ status: 'ready', coverage: { embedded: records.length } });
    expect(batches.slice(expectedBatches.length)).toEqual(expectedBatches);
  });

  it('refuses a single note that cannot fit in an inference frame', async () => {
    const f = await fixture();
    f.catalog.records[0].text = '\0'.repeat(Math.ceil(MAX_INFERENCE_TASK_BYTES / 6));
    const host = new MemoryMapHost({ namespace: f.namespace, refreshLocalAdmission: allowLocal, validatedModelPath,
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
    const host = new MemoryMapHost({ namespace: f.namespace, refreshLocalAdmission: allowLocal, validatedModelPath, runWorker });
    const result = await host.build(() => f.catalog);
    expect(result.coverage.embedded).toBe(4_001);
    expect(inferenceTasks).toEqual([{ kind: 'embed-batch', jobId: expect.any(String), texts: [`${uncached.title}\n${uncached.text}`] }]);
    await expect(host.build(() => f.catalog)).resolves.toEqual(result);
    expect(inferenceTasks).toHaveLength(1);
  });

  it('atomically publishes vectors and coordinates, and invalidates changed or deleted sources', async () => {
    const f = await fixture(); const host = new MemoryMapHost({ namespace: f.namespace, refreshLocalAdmission: allowLocal, validatedModelPath, runWorker: f.runWorker });
    const result = await host.build(() => f.catalog);
    expect(await host.get(() => f.catalog)).toEqual(result);
    const restarted = new MemoryMapHost({ namespace: f.namespace, refreshLocalAdmission: allowLocal, validatedModelPath, runWorker: f.runWorker });
    expect(await restarted.get(() => f.catalog)).toEqual(result);
    expect(await readFile(join(f.root, 'snapshot.json'), 'utf8')).not.toContain('Private body');
    f.catalog.records = [];
    expect(await host.get(() => f.catalog)).toBeNull();
    expect(JSON.parse(await readFile(join(f.root, 'snapshot.json'), 'utf8')).cache).toEqual({});
  });
  it('publishes the ready state in the step that replaces the stored graph', async () => {
    const f = await fixture();
    const host = new MemoryMapHost({ namespace: f.namespace, refreshLocalAdmission: allowLocal, validatedModelPath, runWorker: f.runWorker });
    const atomicReplace = atomicFile.replaceUtf8FileAtomicSyncIf;
    const replace = vi.spyOn(atomicFile, 'replaceUtf8FileAtomicSyncIf').mockImplementationOnce((path, body, canCommit, mode) =>
      atomicReplace(path, body, () => {
        const allowed = canCommit();
        queueMicrotask(() => host.cancel());
        return allowed;
      }, mode));
    try {
      await expect(host.build(() => f.catalog)).rejects.toMatchObject({ code: 'request-stale' });
    } finally { replace.mockRestore(); }
    const stored: unknown = JSON.parse(await readFile(join(f.root, 'snapshot.json'), 'utf8')).snapshot;
    expect(stored).not.toBeNull();
    expect(await host.get(() => f.catalog)).toEqual(stored);
  });
  it('refuses when model admission expires during the saved graph read', async () => {
    const f = await fixture();
    const reading = deferred<void>();
    const resume = deferred<void>();
    let current = true;
    const assertModelAdmission = () => {
      if (!current) throw new MemoryMapHostError('local-runtime-unavailable');
    };
    const onProgress = vi.fn();
    const host = new MemoryMapHost({ namespace: f.namespace, refreshLocalAdmission: allowLocal,
      validatedModelPath: async (_signal, onAdmission) => { onAdmission?.(assertModelAdmission); return 'model'; },
      runWorker: f.runWorker, onProgress });
    await host.build(() => f.catalog);
    onProgress.mockClear();
    const readJson = f.namespace.readJson;
    f.namespace.readJson = async (name, fallback) => {
      const saved = await readJson(name, fallback);
      reading.resolve();
      await resume.promise;
      return saved;
    };
    const building = host.build(() => f.catalog).catch((error: unknown) => error);
    await reading.promise;
    current = false;
    resume.resolve();
    const outcome = await building;
    expect.soft(onProgress).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ code: 'local-runtime-unavailable' });
  });
  it('writes no graph candidate when admission expires during directory preparation', async () => {
    const f = await fixture();
    let current = true;
    const refreshLocalAdmission = async () => () => {
      if (!current) throw new MemoryMapHostError('local-runtime-unavailable');
    };
    const host = new MemoryMapHost({ namespace: f.namespace, refreshLocalAdmission, validatedModelPath, runWorker: f.runWorker });
    const saved = await host.build(() => f.catalog);
    const destination = join(f.root, 'snapshot.json');
    const previous = await readFile(destination, 'utf8');
    f.namespace.childDir = async () => f.root;
    const preparing = deferred<void>();
    const resume = deferred<void>();
    const mkdirSpy = vi.spyOn(fs, 'mkdir').mockImplementationOnce(async () => {
      preparing.resolve();
      await resume.promise;
      return undefined;
    });
    const chmod = vi.spyOn(fs, 'chmod');
    const stage = vi.spyOn(atomicFile, 'replaceUtf8FileAtomicSyncIf');
    try {
      const building = host.build(() => f.catalog);
      await preparing.promise;
      current = false;
      resume.resolve();
      await expect(building).rejects.toMatchObject({ code: 'local-runtime-unavailable' });
      expect.soft(chmod).not.toHaveBeenCalled();
      expect.soft(stage).not.toHaveBeenCalled();
      expect(await readFile(destination, 'utf8')).toBe(previous);
      const reopened = new MemoryMapHost({ namespace: f.namespace, refreshLocalAdmission, validatedModelPath });
      expect(await reopened.get(() => f.catalog)).toEqual(saved);
    } finally { mkdirSpy.mockRestore(); chmod.mockRestore(); stage.mockRestore(); }
  });
  it('refuses persisted identities outside the current authorized catalog', async () => {
    const f = await fixture(); const host = new MemoryMapHost({ namespace: f.namespace, refreshLocalAdmission: allowLocal, validatedModelPath, runWorker: f.runWorker });
    const snapshot = await host.build(() => f.catalog);
    snapshot.points[0].memoryId = 'outside';
    await f.namespace.writeJson('snapshot.json', { snapshot, cache: {} });
    const restarted = new MemoryMapHost({ namespace: f.namespace, refreshLocalAdmission: allowLocal, validatedModelPath, runWorker: f.runWorker });
    await expect(restarted.get(() => f.catalog)).rejects.toThrow('identity is invalid');
  });
  it('drops a stale question when a newer query completes first', async () => {
    const f = await fixture(); let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve; });
    let started!: () => void; const start = new Promise<void>(resolve => { started = resolve; });
    const runner: MemoryWorkerRunner = async <T>(...args: Parameters<MemoryWorkerRunner>) => {
      const [folder, task, signal, , onAdmission] = args;
      if (task.kind !== 'embed') return f.runWorker<T>(folder, task, signal);
      if (task.text === 'first') { started(); await wait; }
      onAdmission?.(() => {});
      return [1, ...Array<number>(383).fill(0)] as T;
    };
    const host = new MemoryMapHost({ namespace: f.namespace, refreshLocalAdmission: allowLocal, validatedModelPath, runWorker: runner });
    const snapshot = await host.build(() => f.catalog);
    const old = host.retrieve(() => f.catalog, { question: 'first', filters: {}, queryId: 'first', snapshotId: snapshot.snapshotId }); await start;
    const answer = await host.retrieve(() => f.catalog, { question: 'second', filters: {}, queryId: 'second', snapshotId: snapshot.snapshotId });
    expect(answer.queryId).toBe('second'); release(); await expect(old).rejects.toThrow('request-stale');
  });
  it('refuses an answer whose inference receipt expired after vector production', async () => {
    const f = await fixture();
    const vectorProduced = deferred<void>();
    const deliver = deferred<void>();
    let current = true;
    const assertInference = () => { if (!current) throw new MemoryMapHostError('local-runtime-unavailable'); };
    const runner: MemoryWorkerRunner = async <T>(...args: Parameters<MemoryWorkerRunner>) => {
      const [folder, task, signal, , onAdmission] = args;
      if (task.kind !== 'embed') return f.runWorker<T>(folder, task, signal);
      const vector = [1, ...Array<number>(383).fill(0)];
      assertInference();
      onAdmission?.(assertInference);
      vectorProduced.resolve();
      await deliver.promise;
      return vector as T;
    };
    const host = new MemoryMapHost({ namespace: f.namespace, refreshLocalAdmission: allowLocal, validatedModelPath, runWorker: runner });
    const snapshot = await host.build(() => f.catalog);
    const pending = host.retrieve(() => f.catalog, { question: 'Question', filters: {}, snapshotId: snapshot.snapshotId, queryId: 'question' });
    await vectorProduced.promise;
    current = false;
    deliver.resolve();
    await expect(pending).rejects.toMatchObject({ code: 'local-runtime-unavailable' });
  });
  it('drops a completed old build on cancellation or scope change', async () => {
    const f = await fixture(); let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve; });
    let started!: () => void; const start = new Promise<void>(resolve => { started = resolve; });
    const runner: MemoryWorkerRunner = async <T>(folder: string, task: Parameters<MemoryWorkerRunner>[1], signal: AbortSignal) => { started(); await wait; return f.runWorker<T>(folder, task, signal); };
    const host = new MemoryMapHost({ namespace: f.namespace, refreshLocalAdmission: allowLocal, validatedModelPath, runWorker: runner });
    const build = host.build(() => f.catalog); await start;
    await host.get(() => ({ ...f.catalog, authorizationScopeId: 'other' })); release();
    await expect(build).rejects.toThrow('request-stale');
    expect(await host.get(() => f.catalog)).toBeNull();
  });
});
