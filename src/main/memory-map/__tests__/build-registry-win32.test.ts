import { describe, expect, it, vi } from 'vitest';
import type { GraphSnapshot } from '../../../shared/memory-map.js';
import { TOOL_TIMEOUT_POLICY } from '../../../shared/tool-timeout-policy.js';
import { reduceView, selectBuildView } from '../../../ui/renderer/components/memory-build-view-win32.js';
import { buildExit, BuildRegistry, step, type BuildEvent, type BuildState, type MemoryWorkerExit, type MemoryWorkerRoute } from '../build-registry-win32.js';
import { LOCAL_NAMESPACE } from '../graph.js';

const LIFECYCLES = ['admitting', 'running', 'stopping', 'settled'] as const;
const EXITS = [
  { exit: 'clear', expired: false, receipts: [] },
  { exit: 'clear', expired: true, receipts: ['confirmed'] },
  { exit: 'pending', expired: false, receipts: ['pending'] },
  { exit: 'unconfirmed', expired: true, receipts: ['pending'] },
  { exit: 'unconfirmed', expired: false, receipts: ['lost'] },
  { exit: 'unconfirmed', expired: false, receipts: ['pending', 'lost'] },
] as const;
const EVENTS = {
  takeover: { type: 'takeover' },
  fail: { type: 'fail', code: 'graph-build-failed' },
  stop: { type: 'stop' },
  'begin-worker': { type: 'begin-worker' },
  confirmed: { type: 'confirmed', worker: 0 },
  lost: { type: 'lost', worker: 0 },
  settle: { type: 'settle', outcome: { kind: 'ready' } },
  deadline: { type: 'deadline' },
} as const satisfies Record<BuildEvent['type'], BuildEvent>;

// Columns are event targets. A dash rejects; a receipt or deadline preserves the lifecycle.
const TRANSITIONS = {
  admitting: ['running', 'settled', 'settled', '-', 'receipt', 'receipt', '-', 'deadline'],
  running: ['-', '-', 'stopping', 'running', 'receipt', 'receipt', 'settled', 'deadline'],
  stopping: ['-', '-', '-', '-', 'receipt', 'receipt', 'settled', 'deadline'],
  settled: ['-', '-', '-', '-', 'receipt', 'receipt', '-', 'deadline'],
} as const satisfies Record<BuildState['lifecycle'], readonly string[]>;

describe('Windows memory build owner', () => {
  it('exhausts lifecycle, exit evidence, and event transitions', () => {
    const events = Object.values(EVENTS);
    let cases = 0;
    for (const lifecycle of LIFECYCLES) {
      expect(TRANSITIONS[lifecycle]).toHaveLength(events.length);
      for (const { exit, expired, receipts } of EXITS) {
        const before: BuildState = Object.freeze({ lifecycle, expired, receipts: Object.freeze([...receipts]) });
        expect(buildExit(before)).toBe(exit);
        for (const [index, event] of events.entries()) {
          cases++;
          const expected = TRANSITIONS[lifecycle][index];
          const label = `${lifecycle}/${exit}/${receipts.join(',')}/${event.type}`;
          const actual = step(before, event);
          if (expected === '-' || (expected === 'receipt' && receipts[0] !== 'pending')
            || (expected === 'deadline' && (expired || receipts[0] !== 'pending'))) {
            expect(actual, label).toBeUndefined();
            continue;
          }
          let after: BuildState = { ...before, lifecycle: expected === 'receipt' || expected === 'deadline' ? lifecycle : expected };
          if (event.type === 'confirmed' || event.type === 'lost') after = { ...after, receipts: [event.type, ...receipts.slice(1)] };
          if (event.type === 'begin-worker') after = { ...after, receipts: [...receipts, 'pending'] };
          if (event.type === 'deadline') after = { ...after, expired: true };
          if (event.type === 'fail') after = { ...after, outcome: { kind: 'failed', code: event.code } };
          if (event.type === 'stop' && lifecycle === 'admitting') after = { ...after, outcome: { kind: 'cancelled' } };
          if (event.type === 'settle') after = { ...after, outcome: event.outcome };
          expect(actual, label).toEqual(after);
        }
        expect(step(before, { type: 'confirmed', worker: receipts.length })).toBeUndefined();
        expect(step(before, { type: 'lost', worker: receipts.length })).toBeUndefined();
      }
    }
    expect(cases).toBe(192);
  });

  it('releases two pending workers independently and remembers only the last 256 confirmed IDs', async () => {
    const registry = new BuildRegistry();
    const request = { scopeId: 'scope', assertAdmitted: () => {} };
    const owner = registry.register('first', request);
    owner.takeover(() => {});
    const container = owner.beginWorker('container');
    const projection = owner.beginWorker('projection');
    const cancel = registry.cancel(owner.id);
    expect(owner.waitForExit()).toBe(owner.waitForExit());
    container.confirmed();
    expect(owner.exit).toBe('pending');
    owner.settle({ kind: 'cancelled' });
    expect(() => registry.register(owner.id, request)).toThrow('invalid-input');
    projection.confirmed();
    await expect(cancel).resolves.toBeNull();
    await expect(registry.cancel(owner.id)).resolves.toBeNull();
    for (let index = 0; index < 256; index++) registry.register(`settled-${index}`, request).stop('user');
    await expect(registry.cancel(owner.id)).rejects.toMatchObject({ code: 'invalid-input' });
    await expect(registry.cancel('settled-0')).resolves.toBeNull();
  });

  it('refuses existing waits when a late receipt runs before the deadline timer', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const clock = vi.spyOn(performance, 'now').mockReturnValue(100);
    try {
      const registry = new BuildRegistry();
      const owner = registry.register('build', { scopeId: 'scope', assertAdmitted: () => {} });
      owner.takeover(() => {});
      const receipt = owner.beginWorker('projection');
      const replies = Promise.allSettled([registry.cancel(owner.id), registry.cancel(owner.id)]);
      owner.settle({ kind: 'cancelled' });

      clock.mockReturnValue(100 + TOOL_TIMEOUT_POLICY.windowsMemoryBuildCancelMs + 1);
      receipt.confirmed();

      expect(await replies).toEqual(Array.from({ length: 2 }, () => ({
        status: 'rejected', reason: expect.objectContaining({ code: 'build-exit-unconfirmed' }),
      })));
      await expect(registry.cancel(owner.id)).resolves.toBeNull();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      clock.mockRestore();
      vi.useRealTimers();
    }
  });

  it('preserves receipts and the renderer graph through 2,000 seeded two-owner interleavings', async () => {
    const ROUTES: readonly MemoryWorkerRoute[] = ['container', 'unconfined', 'account', 'account', 'projection'];
    const READY: GraphSnapshot = {
      snapshotId: 'ready', authorizationScopeId: 'scope', catalogRevision: 'revision', status: 'ready',
      model: { id: LOCAL_NAMESPACE.modelId, revision: LOCAL_NAMESPACE.modelRevision, dimensions: LOCAL_NAMESPACE.dimensions,
        preprocessingRevision: LOCAL_NAMESPACE.preprocessingRevision, namespace: LOCAL_NAMESPACE },
      projection: { algorithm: 'umap', dimensions: 2, version: '1.4.0', seed: 42, parameters: { nNeighbors: 0, minDist: 0.1, nEpochs: 200 } },
      coverage: { eligible: 0, embedded: 0, pending: 0, excluded: 0 }, points: [], edges: [],
    };
    let seed = 24;
    const sample = (limit: number) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return Math.floor(seed / 2 ** 32 * limit);
    };
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    try {
      for (let run = 0; run < 2000; run++) {
        const registry = new BuildRegistry();
        const request = { scopeId: 'scope', assertAdmitted: () => {} };
        const owners = [registry.register('a', request), registry.register('b', request)] as const;
        const workers = new Map<string, { handle: MemoryWorkerExit; token?: symbol; released: boolean }>();
        const replies: Promise<void>[] = [];
        let latest = registry.view('scope', READY);
        let older = latest;
        let renderer = reduceView(null, latest);
        for (let turn = 0; turn < 24; turn++) {
          const index = sample(2);
          const owner = owners[index];
          const other = owners[1 - index];
          const otherBefore = other.status;
          const current = registry.current;
          const exit = owner.exit;
          const worker = workers.get(owner.id);
          const event = sample(12);
          let receipt = false;
          let superseded = false;
          if (event <= 1) {
            const accepted = event === 0 && owner.status.phase === 'admitting';
            const takeover = () => owner.takeover(() => { if (event === 1) throw new Error('Scope changed'); });
            if (accepted) { takeover(); superseded = current === other; }
            else expect(takeover).toThrow();
            expect(registry.current).toBe(accepted ? owner : current);
          } else if (event === 2) {
            const start = () => owner.beginWorker(ROUTES[sample(ROUTES.length)]);
            if (!owner.isRunning()) expect(start).toThrow('request-stale');
            else if (!worker || worker.released) workers.set(owner.id, { handle: start(), released: false });
          } else if (event === 3 && worker && !worker.released) {
            worker.token = Symbol('worker-exit');
            const release = (token: symbol | undefined) => {
              if (!token || token !== worker.token) throw new Error('Missing exit receipt');
              worker.released = true;
              worker.handle.confirmed();
            };
            expect(() => release(undefined)).toThrow();
            release(worker.token);
            receipt = true;
          } else if (event === 4 && worker) worker.handle.lost();
          else if (event === 5) registry.stopAll('settings');
          else if (event === 6) owner.stop('scope-denied');
          else if (event === 7) {
            replies.push(registry.cancel(owner.id).then(() => {
              expect(owner.exit).toBe('clear');
              expect(owner.isRunning()).toBe(false);
            }, error => { expect(error).toMatchObject({ code: 'build-exit-unconfirmed' }); }));
          } else if (event === 8) vi.advanceTimersByTime(TOOL_TIMEOUT_POLICY.windowsMemoryBuildCancelMs);
          else if (event === 9) owner.settle({ kind: 'ready' });
          else if (event === 10) owner.fail('project-not-allowed');

          if (event !== 5 && event !== 8 && !superseded) expect(other.status).toEqual(otherBefore);
          if (event > 1 && registry.current) expect(registry.current).toBe(current);
          if (exit === 'unconfirmed' && !receipt) expect(owner.exit).toBe('unconfirmed');
          const frame = registry.view('scope', READY);
          if (frame.revision > latest.revision) { older = latest; latest = frame; }
          renderer = reduceView(renderer, latest);
          expect(reduceView(renderer, older)).toBe(renderer);
          const view = selectBuildView(renderer.frame);
          const active = frame.builds.find(build => build.phase === 'admitting' || build.phase === 'running');
          expect(view.active).toEqual(active);
          expect(view.snapshot === READY).toBe(active === undefined);
          expect(view.refusals.map(row => row.id)).toEqual(frame.builds.filter(row => row.phase === 'exit-unconfirmed').map(row => row.id));
        }
        registry.stopAll('invalidate');
        vi.advanceTimersByTime(TOOL_TIMEOUT_POLICY.windowsMemoryBuildCancelMs);
        await Promise.all(replies);
        vi.clearAllTimers();
      }
    } finally { vi.useRealTimers(); }
  }, 30_000);
});
