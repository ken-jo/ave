import type { MaterializedPluginContribution } from "./plugin-contributions.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { CommittedPluginGenerationPublicationError } from "./committed-generation-publication-error.js";

interface PluginGenerationIdentity {
  pluginId: string;
  pluginVersion: string;
  artifactGenerationId: string;
  generationId: string;
  manifestSha256: string;
  receiptSha256: string;
}

/** Prepare subsystem projections hidden and never mutate the immutable view after publication. */
export interface ActivePluginGeneration<TState = unknown> extends PluginGenerationIdentity {
  contributions: readonly MaterializedPluginContribution[];
  state: TState;
}

export interface PluginGenerationLease<TState = unknown> {
  readonly generation: ActivePluginGeneration<TState>;
  release(): void;
}

export interface PublishedPluginGenerationTransition {
  readonly retired: Promise<void>;
  markDispatchReady(): Promise<void>;
  markDispatchUnavailable(error: unknown): void;
}

interface GenerationState<TState> {
  active?: ActivePluginGeneration<TState>;
  dispatchReadiness?: {
    readonly generationId: string;
    readonly promise: Promise<void>;
  };
  pendingTransitions: number;
  transitionWaiters: Array<() => void>;
  leaseCounts: Map<string, number>;
  drainWaiters: Map<string, Array<() => void>>;
  transitionTail: Promise<void>;
}

export interface RetiringPluginGeneration<TState = unknown> {
  readonly generation: ActivePluginGeneration<TState>;
  readonly retired: Promise<void>;
}

interface GenerationAdmission<TState> {
  readonly generation: ActivePluginGeneration<TState>;
  readonly isActive: () => boolean;
}

function freezeGeneration<TState>(candidate: ActivePluginGeneration<TState>): ActivePluginGeneration<TState> {
  if (!candidate.pluginId || !candidate.pluginVersion || !candidate.generationId) {
    throw new Error("plugin generation identity must be complete");
  }
  if (
    !/^[a-f0-9]{64}$/.test(candidate.artifactGenerationId) ||
    !/^[a-f0-9]{64}$/.test(candidate.manifestSha256) ||
    !/^[a-f0-9]{64}$/.test(candidate.receiptSha256)
  ) {
    throw new Error("plugin generation artifact, manifest, and receipt identities must be SHA-256 digests");
  }
  return Object.freeze({
    ...candidate,
    contributions: Object.freeze([...candidate.contributions]),
  });
}

// Durable commit is the last fallible pre-pointer step; publish prepared projections in the same turn.
// Retire the predecessor only after its leases drain.
export class PluginGenerationCoordinator<TState = unknown> {
  private readonly plugins = new Map<string, GenerationState<TState>>();
  private readonly retirements = new Map<Promise<void>, ActivePluginGeneration<TState>>();
  /** Closing admission permanently refuses queued and new leases and candidate publication; existing leases remain valid. */
  private admissionClosure: { readonly reason: (pluginId: string) => Error } | undefined;
  private readonly admissionClosureWaiters = new Set<() => void>();
  private readonly admittedGenerations = new AsyncLocalStorage<
    ReadonlyMap<string, GenerationAdmission<TState>>
  >();
  private readonly leaseAdmissions = new WeakMap<
    PluginGenerationLease<TState>,
    GenerationAdmission<TState>
  >();

  private stateFor(pluginId: string): GenerationState<TState> {
    let state = this.plugins.get(pluginId);
    if (!state) {
      state = {
        pendingTransitions: 0,
        transitionWaiters: [],
        leaseCounts: new Map(),
        drainWaiters: new Map(),
        transitionTail: Promise.resolve(),
      };
      this.plugins.set(pluginId, state);
    }
    return state;
  }

  getActive(pluginId: string): ActivePluginGeneration<TState> | undefined {
    return this.stateFor(pluginId).active;
  }

  /** Close once, preserve the first reason and reject every queued acquisition. */
  closeAdmission(reason: (pluginId: string) => Error): void {
    if (this.admissionClosure) return;
    this.admissionClosure = Object.freeze({ reason });
    for (const wake of this.admissionClosureWaiters) wake();
    this.admissionClosureWaiters.clear();
  }

  isAdmissionClosed(): boolean {
    return this.admissionClosure !== undefined;
  }

  admissionClosedError(pluginId: string): Error | undefined {
    return this.admissionClosure?.reason(pluginId);
  }

  listRetiring(): readonly RetiringPluginGeneration<TState>[] {
    return Object.freeze(
      [...this.retirements].map(([retired, generation]) => Object.freeze({ generation, retired })),
    );
  }

  private assertAdmissionOpen(pluginId: string): void {
    if (this.admissionClosure) throw this.admissionClosure.reason(pluginId);
  }

  /** Reject waits promptly when admission closes. */
  private async waitWhileAdmissionOpen(pluginId: string, waited: Promise<unknown>): Promise<void> {
    this.assertAdmissionOpen(pluginId);
    let wake!: () => void;
    const closed = new Promise<void>((resolve) => { wake = resolve; });
    this.admissionClosureWaiters.add(wake);
    try {
      await Promise.race([waited, closed]);
    } finally {
      this.admissionClosureWaiters.delete(wake);
    }
    this.assertAdmissionOpen(pluginId);
  }

  listActive(): readonly ActivePluginGeneration<TState>[] {
    return Object.freeze(
      [...this.plugins.values()]
        .map((state) => state.active)
        .filter((generation): generation is ActivePluginGeneration<TState> => Boolean(generation)),
    );
  }

  async acquire(pluginId: string): Promise<PluginGenerationLease<TState>> {
    this.assertAdmissionOpen(pluginId);
    const admitted = this.admittedGenerations.getStore()?.get(pluginId);
    if (admitted) {
      if (!admitted.isActive()) {
        throw new Error(`plugin '${pluginId}' generation admission has expired`);
      }
      return this.createNestedLease(admitted);
    }
    const state = this.stateFor(pluginId);
    let generation: ActivePluginGeneration<TState> | undefined;
    while (!generation) {
      while (state.pendingTransitions > 0) {
        await this.waitWhileAdmissionOpen(
          pluginId,
          new Promise<void>((resolve) => state.transitionWaiters.push(resolve)),
        );
      }
      const candidate = state.active;
      if (!candidate) throw new Error(`plugin '${pluginId}' has no active generation`);
      const readiness = state.dispatchReadiness;
      if (readiness?.generationId === candidate.generationId) {
        await this.waitWhileAdmissionOpen(pluginId, readiness.promise);
      }
      if (state.pendingTransitions > 0 || state.active?.generationId !== candidate.generationId) {
        continue;
      }
      generation = candidate;
    }
    // Check closure at actual lease creation, after every await.
    this.assertAdmissionOpen(pluginId);
    return this.createLease(state, generation);
  }

  private createLease(
    state: GenerationState<TState>,
    generation: ActivePluginGeneration<TState>,
  ): PluginGenerationLease<TState> {
    state.leaseCounts.set(generation.generationId, (state.leaseCounts.get(generation.generationId) ?? 0) + 1);
    let released = false;
    const admission: GenerationAdmission<TState> = Object.freeze({
      generation,
      isActive: () => !released,
    });
    const lease = Object.freeze({
      generation,
      release: () => {
        if (released) return;
        released = true;
        const next = (state.leaseCounts.get(generation.generationId) ?? 1) - 1;
        if (next > 0) {
          state.leaseCounts.set(generation.generationId, next);
          return;
        }
        state.leaseCounts.delete(generation.generationId);
        for (const resolve of state.drainWaiters.get(generation.generationId) ?? []) resolve();
        state.drainWaiters.delete(generation.generationId);
      },
    });
    this.leaseAdmissions.set(lease, admission);
    return lease;
  }

  /** Run committed host startup under exact admission while public dispatch remains closed. */
  async runPostCommitWithGeneration<T>(
    pluginId: string,
    generationId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    this.assertAdmissionOpen(pluginId);
    const state = this.stateFor(pluginId);
    const generation = state.active;
    if (!generation || generation.generationId !== generationId) {
      throw new Error(
        `plugin '${pluginId}' generation '${generationId}' is not active for post-commit startup`,
      );
    }
    const lease = this.createLease(state, generation);
    try {
      return await this.runWithLease(lease, operation);
    } finally {
      lease.release();
    }
  }

  async acquireExact(pluginId: string, generationId: string): Promise<PluginGenerationLease<TState>> {
    this.assertAdmissionOpen(pluginId);
    const admitted = this.admittedGenerations.getStore()?.get(pluginId);
    if (admitted) {
      if (!admitted.isActive()) {
        throw new Error(`plugin '${pluginId}' generation admission has expired`);
      }
      if (admitted.generation.generationId !== generationId) {
        throw new Error(`plugin '${pluginId}' generation '${generationId}' is not admitted`);
      }
      return this.createNestedLease(admitted);
    }
    const state = this.stateFor(pluginId);
    while (state.pendingTransitions > 0) {
      await this.waitWhileAdmissionOpen(
        pluginId,
        new Promise<void>((resolve) => state.transitionWaiters.push(resolve)),
      );
    }
    if (state.active?.generationId !== generationId) {
      throw new Error(`plugin '${pluginId}' generation '${generationId}' is not active`);
    }
    const lease = await this.acquire(pluginId);
    if (lease.generation.generationId === generationId) return lease;
    lease.release();
    throw new Error(`plugin '${pluginId}' generation '${generationId}' is not active`);
  }

  isExactAdmitted(pluginId: string, generationId: string): boolean {
    const admitted = this.admittedGenerations.getStore()?.get(pluginId);
    return admitted?.generation.generationId === generationId && admitted.isActive();
  }

  currentAdmissionGenerationId(pluginId: string): string | undefined {
    const admitted = this.admittedGenerations.getStore()?.get(pluginId);
    return admitted?.isActive() ? admitted.generation.generationId : undefined;
  }

  /** Reuse one exact immutable lease through nested approval, runtime and audit awaits, even after the pointer advances. */
  runWithLease<T>(
    lease: PluginGenerationLease<TState>,
    operation: () => Promise<T>,
  ): Promise<T> {
    const admission = this.leaseAdmissions.get(lease);
    if (!admission || !admission.isActive()) {
      throw new Error(
        `plugin '${lease.generation.pluginId}' generation lease is not active`,
      );
    }
    const next = new Map(
      [...(this.admittedGenerations.getStore() ?? [])]
        .filter(([, current]) => current.isActive()),
    );
    next.set(lease.generation.pluginId, admission);
    return this.admittedGenerations.run(
      Object.freeze(next) as ReadonlyMap<string, GenerationAdmission<TState>>,
      operation,
    );
  }

  private createNestedLease(
    admission: GenerationAdmission<TState>,
  ): PluginGenerationLease<TState> {
    const lease = Object.freeze({
      generation: admission.generation,
      release: () => undefined,
    });
    this.leaseAdmissions.set(lease, admission);
    return lease;
  }

  async commit(
    candidate: ActivePluginGeneration<TState> | undefined,
    durableCommit: () => Promise<void>,
    retire?: (predecessor: ActivePluginGeneration<TState>) => Promise<void>,
    pluginId = candidate?.pluginId,
    publish: () => void = () => undefined,
  ): Promise<PublishedPluginGenerationTransition> {
    if (!pluginId) throw new Error("pluginId is required for an inactive generation transition");
    if (candidate && candidate.pluginId !== pluginId) throw new Error("candidate plugin identity mismatch");
    const prepared = candidate ? freezeGeneration(candidate) : undefined;
    const state = this.stateFor(pluginId);

    const priorTail = state.transitionTail;
    let releaseTail!: () => void;
    state.transitionTail = new Promise<void>((resolve) => { releaseTail = resolve; });
    // Close the admission barrier before yielding to the serialized commit slot.
    state.pendingTransitions += 1;
    await priorTail;

    let predecessor: ActivePluginGeneration<TState> | undefined;
    let openDispatch: (() => void) | undefined;
    let rejectDispatch: ((error: unknown) => void) | undefined;
    let dispatchSettled = false;
    let candidateReadiness: GenerationState<TState>["dispatchReadiness"];
    let publishError: unknown;
    try {
      try {
        // Check admission before durable work and again after it settles.
        if (prepared) this.assertAdmissionOpen(pluginId);
        predecessor = state.active;
        if (prepared) {
          const promise = new Promise<void>((resolve, reject) => {
            openDispatch = resolve;
            rejectDispatch = reject;
          });
          void promise.catch(() => undefined);
          candidateReadiness = Object.freeze({
            generationId: prepared.generationId,
            promise,
          });
        }
        await durableCommit();
        if (prepared && this.admissionClosure) {
          // Shutdown after durable commit withholds publication without rolling back; next launch loads the committed bytes.
          const refusal = this.admissionClosure.reason(pluginId);
          dispatchSettled = true;
          rejectDispatch?.(refusal);
          throw new CommittedPluginGenerationPublicationError(
            pluginId,
            prepared.generationId,
            refusal,
            Object.freeze({
              retired: Promise.resolve(),
              markDispatchReady: async () => { throw refusal; },
              markDispatchUnavailable: () => undefined,
            }),
            undefined,
            "withheld",
          );
        }
        // No projection work may split durable commit from pointer assignment.
        state.active = prepared;
        state.dispatchReadiness = candidateReadiness;
        // Publish prepared assignment-only projections in the pointer turn with admission still closed.
        try {
          publish();
        } catch (error) {
          publishError = error;
          dispatchSettled = true;
          rejectDispatch?.(
            new Error(
              `plugin '${pluginId}' generation '${candidateReadiness?.generationId ?? "unknown"}' dispatch blocked by publication failure`,
              { cause: error },
            ),
          );
        }
      } finally {
        state.pendingTransitions -= 1;
        if (state.pendingTransitions === 0) {
          for (const resolve of state.transitionWaiters.splice(0)) resolve();
        }
      }

    } finally {
      releaseTail();
    }
    const retired = predecessor && predecessor.generationId !== prepared?.generationId
      ? (async () => {
          await this.waitForDrain(state, predecessor.generationId);
          await retire?.(predecessor);
        })()
      : Promise.resolve();
    if (predecessor && predecessor.generationId !== prepared?.generationId) {
      this.retirements.set(retired, predecessor);
      void retired.finally(() => this.retirements.delete(retired)).catch(() => undefined);
    }
    const transition = Object.freeze({
      retired,
      markDispatchReady: async () => {
        if (!candidateReadiness || dispatchSettled) return;
        try {
          await retired;
        } catch (error) {
          dispatchSettled = true;
          rejectDispatch?.(
            new Error(
              `plugin '${pluginId}' generation '${candidateReadiness.generationId}' dispatch blocked by predecessor retirement failure`,
              { cause: error },
            ),
          );
          throw error;
        }
        if (state.active?.generationId !== candidateReadiness.generationId) {
          const error = new Error(
            `plugin '${pluginId}' generation '${candidateReadiness.generationId}' is no longer active at dispatch readiness`,
          );
          dispatchSettled = true;
          rejectDispatch?.(error);
          throw error;
        }
        dispatchSettled = true;
        openDispatch?.();
      },
      markDispatchUnavailable: (error: unknown) => {
        if (!candidateReadiness || dispatchSettled) return;
        dispatchSettled = true;
        rejectDispatch?.(
          new Error(
            `plugin '${pluginId}' generation '${candidateReadiness.generationId}' dispatch blocked by post-commit readiness failure`,
            { cause: error },
          ),
        );
      },
    });
    if (publishError !== undefined) {
      throw new CommittedPluginGenerationPublicationError(
        pluginId,
        prepared?.generationId,
        publishError,
        transition,
      );
    }
    return transition;
  }

  /** Block new admissions and drain existing leases before in-place projection changes; do not restart the runtime. */
  async quiesce(
    pluginId: string,
    expectedGenerationId: string,
    prepare: () => Promise<void>,
    publish: () => void,
  ): Promise<void> {
    const state = this.stateFor(pluginId);
    const priorTail = state.transitionTail;
    let releaseTail!: () => void;
    state.transitionTail = new Promise<void>((resolve) => { releaseTail = resolve; });
    state.pendingTransitions += 1;
    await priorTail;

    try {
      try {
        // Projection changes also stop once admission closes.
        this.assertAdmissionOpen(pluginId);
        const active = state.active;
        if (!active || active.generationId !== expectedGenerationId) {
          throw new Error(`plugin '${pluginId}' generation changed before projection transition`);
        }
        await this.waitForDrain(state, expectedGenerationId);
        await prepare();
        this.assertAdmissionOpen(pluginId);
        publish();
      } finally {
        state.pendingTransitions -= 1;
        if (state.pendingTransitions === 0) {
          for (const resolve of state.transitionWaiters.splice(0)) resolve();
        }
      }
    } finally {
      releaseTail();
    }
  }

  async waitForRetirements(): Promise<void> {
    await Promise.all([...this.retirements.keys()]);
  }

  private async waitForDrain(state: GenerationState<TState>, generationId: string): Promise<void> {
    if ((state.leaseCounts.get(generationId) ?? 0) === 0) return;
    await new Promise<void>((resolve) => {
      const waiters = state.drainWaiters.get(generationId) ?? [];
      waiters.push(resolve);
      state.drainWaiters.set(generationId, waiters);
    });
  }
}
