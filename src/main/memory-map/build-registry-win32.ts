import { randomUUID } from 'node:crypto';
import { commitUnderAdmission } from '../../shared/admission-commit.js';
import type { GraphSnapshot, MemoryBuildOutcome, MemoryBuildStatus, MemoryBuildView, MemoryMapError, MemoryMapProgress } from '../../shared/memory-map.js';
import { TOOL_TIMEOUT_POLICY } from '../../shared/tool-timeout-policy.js';
import { MemoryMapHostError } from './errors.js';

type BuildLifecycle = 'admitting' | 'running' | 'stopping' | 'settled';
type WorkerReceipt = 'pending' | 'confirmed' | 'lost';
export type BuildExit = 'clear' | 'pending' | 'unconfirmed';
export type MemoryWorkerRoute = 'container' | 'unconfined' | 'account' | 'projection';
type StopReason = 'user' | 'superseded' | 'model' | 'settings' | 'scope-switch' | 'catalog-changed' | 'invalidate' | 'authority' | 'scope-denied' | 'stale';

export interface MemoryWorkerExit { confirmed(): void; lost(): void }
export type BeginMemoryWorker = (route: MemoryWorkerRoute) => MemoryWorkerExit;
export interface BuildState {
  lifecycle: BuildLifecycle;
  receipts: readonly WorkerReceipt[];
  expired: boolean;
  outcome?: MemoryBuildOutcome;
}
export type BuildEvent = { type: 'takeover' | 'stop' | 'begin-worker' | 'deadline' }
  | { type: 'fail'; code: MemoryMapError }
  | { type: 'settle'; outcome: MemoryBuildOutcome }
  | { type: 'confirmed' | 'lost'; worker: number };

const RETENTION_LIMIT = 256;
const INITIAL_STATE: BuildState = { lifecycle: 'admitting', receipts: [], expired: false };

export function buildExit(state: BuildState): BuildExit {
  if (state.receipts.includes('lost')) return 'unconfirmed';
  if (state.receipts.includes('pending')) return state.expired ? 'unconfirmed' : 'pending';
  return 'clear';
}

export function step(state: BuildState, event: BuildEvent): BuildState | undefined {
  switch (event.type) {
    case 'takeover':
      if (state.lifecycle === 'admitting') return { ...state, lifecycle: 'running' };
      break;
    case 'fail':
      if (state.lifecycle === 'admitting') return { ...state, lifecycle: 'settled', outcome: { kind: 'failed', code: event.code } };
      break;
    case 'stop':
      if (state.lifecycle === 'admitting') return { ...state, lifecycle: 'settled', outcome: { kind: 'cancelled' } };
      if (state.lifecycle === 'running') return { ...state, lifecycle: 'stopping' };
      break;
    case 'begin-worker':
      if (state.lifecycle === 'running') return { ...state, receipts: [...state.receipts, 'pending'] };
      break;
    case 'confirmed':
    case 'lost':
      if (state.receipts[event.worker] === 'pending') {
        const receipts = [...state.receipts];
        receipts[event.worker] = event.type;
        return { ...state, receipts };
      }
      break;
    case 'settle':
      if (state.lifecycle === 'running' || state.lifecycle === 'stopping') return { ...state, lifecycle: 'settled', outcome: event.outcome };
      break;
    case 'deadline':
      if (!state.expired && state.receipts.includes('pending')) return { ...state, expired: true };
      break;
  }
}

interface BuildRequest {
  scopeId: string;
  assertAdmitted(): void;
  onProgress?(progress: MemoryMapProgress): void;
}

export class BuildOwner {
  private state = INITIAL_STATE;
  private controller?: AbortController;
  private deadline?: ReturnType<typeof setTimeout>;
  private wait?: Promise<boolean>;
  private resolveWait?: (confirmed: boolean) => void;
  snapshot: GraphSnapshot | null = null;

  constructor(readonly id: string, readonly order: number, private readonly request: BuildRequest,
    private readonly registry: BuildRegistry) {}

  get signal(): AbortSignal {
    if (!this.controller) throw new MemoryMapHostError('request-stale');
    return this.controller.signal;
  }
  get scopeId(): string { return this.request.scopeId; }
  get canPrune(): boolean { return this.state.lifecycle === 'settled' && this.exit === 'clear'; }
  get exit(): BuildExit { return buildExit(this.state); }
  get status(): MemoryBuildStatus {
    const { lifecycle, outcome } = this.state;
    const phase = lifecycle === 'admitting' || lifecycle === 'running' ? lifecycle
      : this.exit === 'unconfirmed' ? 'exit-unconfirmed'
      : lifecycle === 'stopping' || this.exit === 'pending' ? 'stopping' : 'stopped';
    return { id: this.id, phase, ...(outcome && { outcome }) };
  }

  takeover(assertLocal: () => void): void {
    this.assertAdmitting();
    commitUnderAdmission(() => { this.request.assertAdmitted(); assertLocal(); }, () => {
      this.assertAdmitting();
      this.controller = new AbortController();
      this.transition({ type: 'takeover' });
      this.registry.bind(this);
    });
  }

  assertAdmitting(): void {
    if (this.state.lifecycle !== 'admitting') throw new MemoryMapHostError('request-stale');
  }

  assertAdmitted(): void { this.request.assertAdmitted(); }
  isRunning(): boolean { return this.state.lifecycle === 'running' && !this.signal.aborted; }
  fail(code: MemoryMapError): void { this.transition({ type: 'fail', code }); }
  settle(outcome: MemoryBuildOutcome): void { this.transition({ type: 'settle', outcome }); }
  report(progress: MemoryMapProgress): void { this.request.onProgress?.({ ...progress, jobId: this.id }); }

  readonly beginWorker: BeginMemoryWorker = (_route) => {
    const worker = this.state.receipts.length;
    if (!this.isRunning() || !this.transition({ type: 'begin-worker' })) throw new MemoryMapHostError('request-stale');
    return {
      confirmed: () => { this.transition({ type: 'confirmed', worker }); },
      lost: () => { this.transition({ type: 'lost', worker }); },
    };
  };

  stop(_reason: StopReason): void {
    if (this.transition({ type: 'stop' })) this.controller?.abort(new MemoryMapHostError('request-stale'));
    if (this.state.receipts.includes('pending') && !this.state.expired && this.deadline === undefined) {
      this.deadline = setTimeout(() => { this.transition({ type: 'deadline' }); }, TOOL_TIMEOUT_POLICY.windowsMemoryBuildCancelMs);
      this.deadline.unref();
    }
  }

  waitForExit(): Promise<boolean> {
    if (this.exit !== 'pending') return Promise.resolve(this.exit === 'clear');
    this.wait ??= new Promise(resolve => { this.resolveWait = resolve; });
    return this.wait;
  }

  private transition(event: BuildEvent): boolean {
    const next = step(this.state, event);
    if (!next) return false;
    this.state = next;
    this.registry.changed(this);
    const exit = this.exit;
    if (exit !== 'pending') this.resolveWait?.(exit === 'clear');
    if (!next.receipts.includes('pending') && this.deadline !== undefined) {
      clearTimeout(this.deadline);
      this.deadline = undefined;
    }
    return true;
  }
}

export class BuildRegistry {
  private readonly instance = randomUUID();
  private revision = 0;
  private readonly owners = new Map<string, BuildOwner>();
  private readonly tombstones = new Set<string>();
  private readonly completed = new Map<string, { order: number; status: MemoryBuildStatus }>();
  private running?: BuildOwner;

  get current(): BuildOwner | undefined { return this.running; }

  register(id: string, request: BuildRequest): BuildOwner {
    if (this.owners.has(id) || this.tombstones.has(id)) throw new MemoryMapHostError('invalid-input');
    const owner = new BuildOwner(id, ++this.revision, request, this);
    this.owners.set(id, owner);
    return owner;
  }

  bind(owner: BuildOwner): void {
    const previous = this.running;
    this.running = owner;
    previous?.stop('superseded');
  }

  changed(owner?: BuildOwner): void {
    this.revision++;
    if (!owner) return;
    if (this.running === owner && !owner.isRunning()) this.running = undefined;
    if (!owner.canPrune) return;
    this.owners.delete(owner.id);
    this.tombstones.add(owner.id);
    const firstTombstone = this.tombstones.values().next();
    if (this.tombstones.size > RETENTION_LIMIT && !firstTombstone.done) this.tombstones.delete(firstTombstone.value);
    const previous = this.completed.get(owner.scopeId);
    if (!previous || previous.order < owner.order) {
      this.completed.delete(owner.scopeId);
      this.completed.set(owner.scopeId, { order: owner.order, status: owner.status });
      const firstScope = this.completed.keys().next();
      if (this.completed.size > RETENTION_LIMIT && !firstScope.done) this.completed.delete(firstScope.value);
    }
  }

  stopCurrent(reason: StopReason): void { this.running?.stop(reason); }
  stopAll(reason: StopReason): void { for (const owner of this.owners.values()) owner.stop(reason); }

  async cancel(id: string): Promise<null> {
    const owner = this.owners.get(id);
    if (!owner) {
      if (this.tombstones.has(id)) return null;
      throw new MemoryMapHostError('invalid-input');
    }
    owner.stop('user');
    if (!await owner.waitForExit()) throw new MemoryMapHostError('build-exit-unconfirmed');
    return null;
  }

  view(scopeId: string, snapshot: GraphSnapshot | null): MemoryBuildView {
    const visible = [...this.owners.values()].filter(owner => owner.scopeId === scopeId)
      .map(owner => ({ order: owner.order, status: owner.status }));
    const completed = this.completed.get(scopeId);
    if (completed) visible.push(completed);
    const builds = visible.sort((a, b) => b.order - a.order).map(entry => entry.status);
    return { instance: this.instance, revision: this.revision, snapshot, builds };
  }
}
