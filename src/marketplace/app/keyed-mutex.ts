import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Proof that its holder runs with a set of keys of one {@link KeyedMutex}.
 * It lives exactly as long as the holder's callback: passed down
 * explicitly, it lets work inside that callback run under keys it already
 * holds ({@link KeyedMutex.within}); it never adds a key.
 */
export interface MutexLease {
  /** The keys it holds, ascending. */
  readonly keys: readonly string[];
}

class Lease implements MutexLease {
  /** Its holder's callback returned: it may no longer be passed down. */
  closed = false;
  /** Its keys were released. */
  released = false;
  /** Work running under it through {@link KeyedMutex.within}; the holder releases only once none is left. */
  active = 0;
  drained: (() => void) | null = null;

  constructor(
    readonly mutex: KeyedMutex,
    readonly keys: readonly string[],
  ) {}
}

interface Waiter {
  readonly keys: readonly string[];
  granted: boolean;
  /** Called once, when the waiter heads the queue of every one of its keys. */
  readonly grant: () => void;
}

export interface MutexRunOptions {
  /** Cancels the acquisition: aborted before every key is held, `fn` never starts and the call rejects with its reason. */
  readonly signal?: AbortSignal;
  /** Called with the keys, before any is asked for; it may throw to refuse. */
  readonly beforeAcquire?: (keys: readonly string[]) => void;
}

/**
 * Mutual exclusion per key (design §18.6). A caller declares every key it
 * needs at once and takes them all as one request: the request joins every
 * key's FIFO queue in the same step and runs once it heads all of them.
 * Since each request joins all its queues together, two requests stand in
 * the same order in every queue they share, so none waits for another in a
 * cycle, and there is nothing to extend later.
 *
 * - One cancellation point covers the whole acquisition: cancelling removes
 *   the request from every queue (it never held a key), and only it.
 * - The lease passed to `fn` lives as long as `fn`. Work inside `fn` that
 *   must run under some of those keys passes the lease to {@link within},
 *   which runs it at once. Passing it after `fn` returned throws, and the
 *   holder releases its keys only after the work admitted under it ends.
 * - A caller that holds keys and asks for keys without its lease throws
 *   instead of waiting, perhaps for itself. The current context's lease is
 *   used for that refusal only, never to grant anything; work the holder
 *   does not own leaves its context through {@link detached}.
 */
export class KeyedMutex {
  private readonly queues = new Map<string, Waiter[]>();
  private readonly context = new AsyncLocalStorage<Lease>();

  /** No key is held or asked for. */
  get idle(): boolean {
    return this.queues.size === 0;
  }

  async run<T>(keys: readonly string[], fn: (lease: MutexLease) => Promise<T>, options: MutexRunOptions = {}): Promise<T> {
    const wanted = [...new Set(keys)].sort();
    if (wanted.length === 0) throw new Error("lock contract: a lock request names no key; work that needs none takes no lock");
    const ambient = this.context.getStore();
    if (ambient && !ambient.released) {
      throw new Error(`lock contract: ${wanted.join(", ")} asked for by a caller holding ${ambient.keys.join(", ")}; declare every key up front, or pass the lease to run under keys it holds`);
    }
    options.beforeAcquire?.(wanted);
    const waiter = await this.take(wanted, options.signal);
    if (options.signal?.aborted) {
      // Granted in the same turn as the abort: the cancellation still wins, and nothing ran.
      this.release(waiter);
      throw options.signal.reason;
    }
    const lease = new Lease(this, wanted);
    try {
      return await this.context.run(lease, () => fn(lease));
    } finally {
      lease.closed = true;
      if (lease.active > 0) await new Promise<void>((resolve) => (lease.drained = resolve));
      lease.released = true;
      this.release(waiter);
    }
  }

  /**
   * Run `fn` under keys `lease` holds, at once, while its holder's callback
   * runs. Asking for a key the lease does not hold throws: a request names
   * every key it needs up front.
   */
  async within<T>(value: MutexLease, keys: readonly string[], fn: () => Promise<T>): Promise<T> {
    if (!(value instanceof Lease) || value.mutex !== this) throw new Error("lock contract: the lease passed does not belong to this lock");
    if (value.closed) throw new Error(`lock contract: the lease of ${value.keys.join(", ")} was passed after its holder returned`);
    const missing = [...new Set(keys)].filter((key) => !value.keys.includes(key)).sort();
    if (keys.length === 0 || missing.length > 0) {
      throw new Error(`lock contract: ${missing.join(", ") || "no key"} asked for under the lease of ${value.keys.join(", ")}; a lease runs work only under keys it holds`);
    }
    value.active += 1;
    try {
      return await this.context.run(value, fn);
    } finally {
      value.active -= 1;
      if (value.active === 0) value.drained?.();
    }
  }

  /** Run `fn` as work detached from the current holder: another caller, which waits for the keys like any other. */
  detached<T>(fn: () => T): T {
    return this.context.exit(fn);
  }

  private take(keys: readonly string[], signal: AbortSignal | undefined): Promise<Waiter> {
    signal?.throwIfAborted();
    return new Promise<Waiter>((resolve, reject) => {
      let off = () => {};
      const waiter: Waiter = {
        keys,
        granted: false,
        grant: () => {
          waiter.granted = true;
          off();
          resolve(waiter);
        },
      };
      for (const key of keys) {
        const queue = this.queues.get(key);
        if (queue) queue.push(waiter);
        else this.queues.set(key, [waiter]);
      }
      if (this.heads(waiter)) {
        waiter.grant();
        return;
      }
      if (!signal) return;
      const onAbort = () => {
        // Not granted, so it holds no key: leaving every queue changes no holder, but may let a waiter behind it run.
        for (const key of keys) this.leave(key, waiter);
        this.wake(keys);
        reject(signal.reason);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      off = () => signal.removeEventListener("abort", onAbort);
    });
  }

  private heads(waiter: Waiter): boolean {
    return waiter.keys.every((key) => this.queues.get(key)?.[0] === waiter);
  }

  private leave(key: string, waiter: Waiter): void {
    const queue = this.queues.get(key)!;
    queue.splice(queue.indexOf(waiter), 1);
    if (queue.length === 0) this.queues.delete(key);
  }

  private release(waiter: Waiter): void {
    for (const key of waiter.keys) {
      if (this.queues.get(key)?.[0] !== waiter) throw new Error(`lock contract: ${key} released by a request that does not hold it`);
      this.leave(key, waiter);
    }
    this.wake(waiter.keys);
  }

  /** Grant every waiter that now heads all of its queues. */
  private wake(keys: readonly string[]): void {
    for (const key of keys) {
      const head = this.queues.get(key)?.[0];
      if (head && !head.granted && this.heads(head)) head.grant();
    }
  }
}
