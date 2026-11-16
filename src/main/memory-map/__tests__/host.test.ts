import { mkdtemp, mkdir, open, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryMapHost } from '../host.js';
import { buildGraph } from '../graph.js';
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
    if (task.kind !== 'build') throw new Error('Unexpected task');
    return await buildGraph(task.input, { embed: async () => [1, ...Array<number>(383).fill(0)], dispose: async () => {} }, () => {}) as T;
  };
  return { root, namespace, catalog, runWorker };
}
describe('memory graph publication', () => {
  it('atomically publishes vectors and coordinates, and invalidates changed or deleted sources', async () => {
    const f = await fixture(); const host = new MemoryMapHost({ namespace: f.namespace, validatedModelPath: async () => 'model', runWorker: f.runWorker });
    const result = await host.build(() => f.catalog);
    expect(await host.get(() => f.catalog)).toEqual(result);
    expect(await readFile(join(f.root, 'snapshot.json'), 'utf8')).not.toContain('Private body');
    f.catalog.records = [];
    expect(await host.get(() => f.catalog)).toBeNull();
    expect(JSON.parse(await readFile(join(f.root, 'snapshot.json'), 'utf8')).cache).toEqual({});
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
