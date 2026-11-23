import { describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ postMessage: vi.fn(), close: vi.fn() }));
vi.mock('node:worker_threads', () => ({ parentPort: { postMessage: state.postMessage, close: state.close }, workerData: { folder: '', task: { kind: 'project', input: { records: [], authorizationScopeId: 'scope', excluded: 0, namespace: { source: 'provider', providerId: 'configured', modelId: 'embed', modelRevision: 'embed', preprocessingRevision: 'text-l2-v1', dimensions: 3 }, cache: {}, jobId: 'job' } } } }));
describe('cached vector projection worker', () => {
  it('projects provider vectors without loading a local model', async () => {
    await import('../worker-main.js');
    await vi.waitFor(() => expect(state.close).toHaveBeenCalledOnce());
    expect(state.postMessage).toHaveBeenCalledWith(expect.objectContaining({ kind: 'result', value: expect.objectContaining({ snapshot: expect.objectContaining({ status: 'ready', model: expect.objectContaining({ dimensions: 3 }) }) }) }));
  });
});
