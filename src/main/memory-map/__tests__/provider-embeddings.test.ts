import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, open, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SettingsService } from '../../../data/settings-store.js';
import type { MemoryEmbeddingConfig } from '../../../shared/memory-embedding-config.js';
import type { MemoryMapProgress } from '../../../shared/memory-map.js';
import type { FeatureNamespaceHandle } from '../../storage/feature-namespace.js';
import { ProviderEmbeddings, providerNamespace } from '../provider-embeddings.js';
import { buildGraph } from '../graph.js';
import type { MemoryWorkerRunner } from '../worker-client.js';
import { MemoryMapHost } from '../host.js';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture() {
  const requests: { model: string; input: string[] }[] = [];
  let dimensions = 3; let inconsistent = false; let fail = false; let responseWait: Promise<void> | undefined;
  const key = 'fixture-private-credential';
  const server: Server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    const parsed = JSON.parse(body) as { model: string; input: string[] };
    requests.push(parsed); await responseWait;
    if (fail) { response.writeHead(400, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: { message: key, type: 'invalid_request_error' } })); return; }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ object: 'list', model: parsed.model, data: parsed.input.map((_, index) => ({ object: 'embedding', index, embedding: Array.from({ length: inconsistent && index ? dimensions + 1 : dimensions }, (_, i) => i === 0 ? 2 : 0) })), usage: { prompt_tokens: 1, total_tokens: 1 } }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); }));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing server address');
  const baseUrl = 'http://127.0.0.1:' + address.port + '/v1';
  let config: MemoryEmbeddingConfig = { source: 'provider', providerId: 'openai-compatible', modelId: 'embed-a' };
  const consent = () => { config.consent = { version: 1, providerId: 'openai-compatible', modelId: config.modelId!, timestamp: new Date().toISOString() }; };
  const llm = { vendors: { 'openai-compatible': { baseUrl } }, modelListCache: { saved: { vendor: 'openai-compatible', baseUrl, endpoint: baseUrl + '/models', models: ['embed-a', 'embed-b'], modelEntries: [{ id: 'embed-a', outputModalities: ['embedding'] }, { id: 'embed-b', outputModalities: ['embedding'] }], fetchedAt: new Date().toISOString() } } };
  const settings = { get: (name: string) => name === 'memoryEmbedding' ? config : name === 'llm' ? llm : {}, hasStoredSecret: vi.fn(async (name: string) => name === 'llm.apiKey.openai-compatible' || name === 'llm.apiKey.claude'), getSecret: vi.fn(async () => key) } as unknown as SettingsService;
  const nativeFetch = globalThis.fetch;
  const chokepoint = vi.fn<typeof fetch>((input, init) => nativeFetch(input, init));
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Ambient fetch is forbidden'); }));
  const worker: MemoryWorkerRunner = async <T>(folder: string, task: Parameters<MemoryWorkerRunner>[1], signal: AbortSignal, report: Parameters<MemoryWorkerRunner>[3]) => {
    expect(folder).toBe(''); expect(task.kind).toBe('project'); signal.throwIfAborted();
    if (task.kind !== 'project') throw new Error('Unexpected worker task');
    return await buildGraph(task.input, { embed: async () => { throw new Error('Unexpected local embedding'); }, dispose: async () => {} }, report ?? (() => {})) as T;
  };
  const provider = new ProviderEmbeddings(settings, chokepoint, worker);
  const root = await mkdtemp(join(tmpdir(), 'memory-provider-')); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const namespace: FeatureNamespaceHandle = { dir: root, readJson: async (_, fallback) => { try { return JSON.parse(await readFile(join(root, 'snapshot.json'), 'utf8')); } catch { return fallback; } }, writeJson: async (name, value) => writeFile(join(root, name), JSON.stringify(value)), childDir: async name => { await mkdir(join(root, name), { recursive: true }); return join(root, name); }, createFile: name => open(join(root, name), 'wx') };
  const catalog = { authorizationScopeId: 'scope', excluded: 0, records: Array.from({ length: 2 }, (_, i) => ({ memoryId: 'id-' + i, contentRevision: 'r-' + i, title: 'Title ' + i, text: 'Private memory ' + i, sourceKind: 'user' as const })) };
  const progress: MemoryMapProgress[] = [];
  const host = new MemoryMapHost({ namespace, provider, validatedModelPath: async () => { throw new Error('Local model must not load'); }, onProgress: value => progress.push(value) });
  return { pauseResponse: () => { let release!: () => void; responseWait = new Promise<void>(resolve => { release = resolve; }); return release; }, provider, host, settings, namespace, catalog, requests, chokepoint, progress, key, consent, get config() { return config; }, set config(value) { config = value; }, set dimensions(value: number) { dimensions = value; }, set inconsistent(value: boolean) { inconsistent = value; }, set fail(value: boolean) { fail = value; } };
}
describe('provider memory embeddings', () => {
  it('refuses every send without matching current versioned consent', async () => {
    const f = await fixture(); const selected = providerNamespace('openai-compatible', 'embed-a');
    for (const consent of [undefined, { version: 1, providerId: 'other', modelId: 'embed-a', timestamp: new Date().toISOString() }, { version: 1, providerId: 'openai-compatible', modelId: 'other', timestamp: new Date().toISOString() }, { version: 0, providerId: 'openai-compatible', modelId: 'embed-a', timestamp: new Date().toISOString() }]) {
      f.config.consent = consent as MemoryEmbeddingConfig['consent'];
      await expect(f.provider.embed(selected, ['Private'], new AbortController().signal)).rejects.toThrow('provider-consent-required');
    }
    expect(f.chokepoint).not.toHaveBeenCalled(); expect(f.settings.getSecret).not.toHaveBeenCalled(); expect(f.requests).toEqual([]);
  });
  it('sends only after consent through the host transport and uses the same namespace for questions', async () => {
    const f = await fixture(); f.consent(); const snapshot = await f.host.build(() => f.catalog);
    expect(snapshot.model.namespace).toEqual(providerNamespace('openai-compatible', 'embed-a', 3));
    const answer = await f.host.retrieve(() => f.catalog, { question: 'Question', filters: {}, snapshotId: snapshot.snapshotId, queryId: 'q' });
    expect(answer.matches).toHaveLength(2); expect(f.requests.map(value => value.model)).toEqual(['embed-a', 'embed-a']); expect(f.requests[1]!.input).toEqual(['Question']); expect(f.chokepoint).toHaveBeenCalledTimes(2);
    const restarted = new MemoryMapHost({ namespace: f.namespace, provider: f.provider, validatedModelPath: async () => '' });
    expect(await restarted.get(() => f.catalog)).toEqual(snapshot);
    expect(JSON.stringify(f.progress)).not.toMatch(/Private|Title|memoryId/);
  });
  it('invalidates saved snapshot and vectors on a provider model switch', async () => {
    const f = await fixture(); f.consent(); await f.host.build(() => f.catalog);
    f.config.modelId = 'embed-b'; f.consent();
    expect(await f.host.get(() => f.catalog)).toBeNull();
    expect(await f.namespace.readJson('snapshot.json', {})).toEqual({ cache: {}, snapshot: null });
    const next = await f.host.build(() => f.catalog); expect(next.model.namespace.modelId).toBe('embed-b'); expect(f.requests[1]!.model).toBe('embed-b');
    f.config.source = 'local'; expect(await f.host.get(() => f.catalog)).toBeNull();
  });
  it('does not reuse a saved namespace with a different preprocessing revision', async () => {
    const f = await fixture(); f.consent(); await f.host.build(() => f.catalog);
    const saved = await f.namespace.readJson<{ snapshot: { model: { namespace: { preprocessingRevision: string } } }; cache: Record<string, number[]> }>('snapshot.json', null as never);
    saved.snapshot.model.namespace.preprocessingRevision = 'old-preprocessing'; await f.namespace.writeJson('snapshot.json', saved);
    const rebuilt = await f.host.build(() => f.catalog);
    expect(rebuilt.model.namespace.preprocessingRevision).toBe('text-l2-v1'); expect(f.requests).toHaveLength(2);
  });
  it('bounds batches and stops the next batch after opting out', async () => {
    const f = await fixture(); f.consent(); f.catalog.records = Array.from({ length: 33 }, (_, i) => ({ ...f.catalog.records[0]!, memoryId: 'id-' + i }));
    const host = new MemoryMapHost({ namespace: f.namespace, provider: f.provider, validatedModelPath: async () => '', onProgress: () => { f.config.source = 'local'; host.cancel(); } });
    await expect(host.build(() => f.catalog)).rejects.toThrow('request-stale');
    expect(f.requests).toHaveLength(1); expect(f.requests[0]!.input).toHaveLength(16);
    expect(await host.get(() => f.catalog)).toBeNull();
  });
  it('rechecks consent after asynchronous credential resolution before host egress', async () => {
    const f = await fixture(); f.consent();
    vi.mocked(f.settings.getSecret).mockImplementation(async () => { f.config.consent!.modelId = 'other'; return f.key; });
    await expect(f.provider.embed(providerNamespace('openai-compatible', 'embed-a'), ['Private'], new AbortController().signal)).rejects.toThrow('provider-consent-required');
    expect(f.chokepoint).not.toHaveBeenCalled(); expect(f.requests).toEqual([]);
  });
  it('cancels an in-flight provider request when opting out', async () => {
    const f = await fixture(); f.consent(); const release = f.pauseResponse();
    const pending = f.host.build(() => f.catalog).catch((error: unknown) => error);
    try {
      await vi.waitFor(() => expect(f.requests).toHaveLength(1));
      f.provider.suspend(); f.config.source = 'local'; await f.host.invalidate();
      expect(await pending).toMatchObject({ code: 'request-stale' });
      expect(f.chokepoint.mock.calls[0]![1]?.signal?.aborted).toBe(true);
      expect(await f.host.get(() => f.catalog)).toBeNull(); expect(f.requests).toHaveLength(1);
    } finally { release(); }
  });
  it('refuses configured providers without embedding support with a stable reason', async () => {
    const f = await fixture();
    expect((await f.provider.providers()).find(value => value.id === 'claude')).toEqual({ id: 'claude', models: [], reason: 'provider-no-embedding-model' });
    await expect(f.provider.validate('claude', 'chat-only')).rejects.toThrow('provider-no-embedding-model');
    f.consent(); await expect(f.provider.embed(providerNamespace('openai-compatible', 'chat-only'), ['Private'], new AbortController().signal)).rejects.toThrow('provider-consent-required');
    expect(f.chokepoint).not.toHaveBeenCalled();
  });
  it('fails clearly for inconsistent dimensions within a response and against a saved namespace', async () => {
    const f = await fixture(); f.consent(); f.inconsistent = true;
    await expect(f.host.build(() => f.catalog)).rejects.toThrow('provider-dimension-mismatch');
    f.inconsistent = false; const snapshot = await f.host.build(() => f.catalog); f.dimensions = 4;
    await expect(f.host.retrieve(() => f.catalog, { question: 'Question', filters: {}, snapshotId: snapshot.snapshotId, queryId: 'q' })).rejects.toThrow('provider-dimension-mismatch');
  });
  it('removes provider error details and credentials from errors, logs and progress', async () => {
    const f = await fixture(); f.consent(); f.fail = true;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {}); const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const error = await f.host.build(() => f.catalog).catch((error: unknown) => error);
    expect(error).toMatchObject({ code: 'provider-embedding-failed', message: 'provider-embedding-failed' });
    expect(String(error) + JSON.stringify(error) + JSON.stringify(f.progress) + JSON.stringify(warn.mock.calls) + JSON.stringify(errorLog.mock.calls)).not.toContain(f.key);
    expect((error as Error).cause).toBeUndefined();
  });
});
