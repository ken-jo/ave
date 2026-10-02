import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Proof that its holder runs with some keys of one {@link KeyedMutex}. The
 * holder passes it down, explicitly, to a call that must run under the same
 * keys (re-entry) or under them and more (extension). Nothing else grants
 * ownership: a call that does not pass it is another caller and waits.
 */
export interface MutexLease {
  /** Every key this lease holds, its own and those of the lease it extends, ascending. */
  readonly keys: readonly string[];
}

class Lease implements MutexLease {
  /** Keys this lease took itself, in the (ascending) order it took them. */
  readonly own: string[] = [];
  /** Leases that extend this one and have not settled: this lease keeps its keys for them. */
  children = 0;
  /** Its holder's function has not returned yet; only then may it be passed down. */
  running = true;
  released = false;

  constructor(
    readonly mutex: KeyedMutex,
    readonly parent: Lease | null,
  ) {}

  get keys(): readonly string[] {
    return [...(this.parent?.keys ?? []), ...this.own].sort();
  }

  holds(key: string): boolean {
    return this.own.includes(key) || (this.parent?.holds(key) ?? false);
  }
}

interface Waiter {
  readonly lease: Lease;
  /** Called once, when the waiter reaches the head of its key's queue. */
  readonly grant: () => void;
}

export interface MutexRunOptions {
  /** The lease of the caller this call runs inside; required to re-enter or extend it. */
  readonly within?: MutexLease;
  /** Cancels the wait: aborted before every key is held, `fn` never starts and the call rejects with its reason. */
  readonly signal?: AbortSignal;
  /** Called with the keys about to be waited for, before any is taken, when there is at least one; it may throw to refuse. */
  readonly beforeAcquire?: (keys: readonly string[]) => void;
}

/**
 * Mutual exclusion per key (design §18.6). For each key, one FIFO queue
 * whose head holds the key. A caller takes its keys one at a time, in
 * ascending order, so two callers each taking several never wait for each
 * other in a cycle.
 *
 * - Cancelling a waiter removes only that waiter from its queue; a holder or
 *   another waiter is never touched, and keys it already took are released.
 * - Ownership is the {@link MutexLease} passed to `fn`. Passing it as
 *   `within` re-enters its keys without waiting and may add keys above every
 *   key it holds; asking for a key at or below the highest one it holds
 *   throws, since waiting for it could close a cycle. A lease is passed down
 *   only while its holder runs; a lease that extends it keeps the extended
 *   keys held until it settles too, so its holder never runs without them.
 * - A call that holds a key and asks for keys without passing its lease
 *   throws instead of waiting, perhaps for itself. The current context's
 *   lease is used for that refusal only, never to grant anything.
 */
export class KeyedMutex {
  private readonly queues = new Map<string, Waiter[]>();
  private readonly context = new AsyncLocalStorage<Lease>();

  /** No key is held or waited for. */
  get idle(): boolean {
    return this.queues.size === 0;
  }

  async run<T>(keys: readonly string[], fn: (lease: MutexLease) => Promise<T>, options: MutexRunOptions = {}): Promise<T> {
    const parent = options.within === undefined ? null : this.lease(options.within);
    if (!parent && keys.length > 0) this.refuseUnpassedLease(keys);
    const wanted = [...new Set(keys)].filter((key) => !parent?.holds(key)).sort();
    const highest = parent?.keys.at(-1);
    if (highest !== undefined && wanted.length > 0 && wanted[0]! <= highest) {
      throw new Error(`lock order: ${wanted.join(", ")} asked for while holding ${parent!.keys.join(", ")}; a lease extends only with keys above every key it holds`);
    }
    if (wanted.length > 0) options.beforeAcquire?.(wanted);
    options.signal?.throwIfAborted();
    const lease = new Lease(this, parent);
    if (parent) parent.children += 1;
    try {
      for (const key of wanted) await this.take(key, lease, options.signal);
      // The last key came free in the same turn as the abort.
      options.signal?.throwIfAborted();
    } catch (error) {
      lease.running = false;
      this.settle(lease);
      throw error;
    }
    try {
      return await this.context.run(lease, () => fn(lease));
    } finally {
      lease.running = false;
      this.settle(lease);
    }
  }

  /** Run `fn` as work detached from the current holder: it is no caller holding a key, and must not pass a lease it did not get. */
  detached<T>(fn: () => T): T {
    return this.context.exit(fn);
  }

  private lease(value: MutexLease): Lease {
    if (!(value instanceof Lease) || value.mutex !== this) throw new Error("lock contract: the lease passed does not belong to this lock");
    if (!value.running) throw new Error(`lock contract: the lease of ${value.keys.join(", ") || "no key"} was passed after its holder returned`);
    return value;
  }

  private refuseUnpassedLease(keys: readonly string[]): void {
    for (let lease: Lease | null | undefined = this.context.getStore(); lease; lease = lease.parent) {
      if (lease.running && lease.own.length > 0) {
        throw new Error(`lock contract: ${[...new Set(keys)].sort().join(", ")} asked for without the lease of a caller holding ${lease.keys.join(", ")}; pass it down`);
      }
    }
  }

  private take(key: string, lease: Lease, signal: AbortSignal | undefined): Promise<void> {
    const queue = this.queues.get(key) ?? [];
    this.queues.set(key, queue);
    return new Promise<void>((resolve, reject) => {
      let off = () => {};
      const waiter: Waiter = {
        lease,
        grant: () => {
          off();
          lease.own.push(key);
          resolve();
        },
      };
      queue.push(waiter);
      if (queue[0] === waiter) {
        waiter.grant();
        return;
      }
      if (!signal) return;
      const onAbort = () => {
        // Still waiting, so not the head: removing it changes no holder.
        queue.splice(queue.indexOf(waiter), 1);
        reject(signal.reason);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      off = () => signal.removeEventListener("abort", onAbort);
    });
  }

  /** Release the lease's own keys once its holder returned and no lease extending it is left, then settle the lease it extends. */
  private settle(lease: Lease): void {
    if (lease.running || lease.children > 0 || lease.released) return;
    lease.released = true;
    for (const key of [...lease.own].reverse()) {
      const queue = this.queues.get(key);
      if (queue?.[0]?.lease !== lease) throw new Error(`lock contract: ${key} released by a lease that does not hold it`);
      queue.shift();
      if (queue.length === 0) this.queues.delete(key);
      else queue[0]!.grant();
    }
    if (lease.parent) {
      lease.parent.children -= 1;
      this.settle(lease.parent);
    }
  }
}
