import { AsyncLocalStorage } from "node:async_hooks";

/** A callback-scoped lease permits nested work under existing keys, never additional keys. */
export interface MutexLease {
  readonly keys: readonly string[];
}

class Lease implements MutexLease {
  closed = false;
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
  readonly grant: () => void;
}

export interface MutexRunOptions {
  /** Cancels the acquisition: aborted before every key is held, `fn` never starts and the call rejects with its reason. */
  readonly signal?: AbortSignal;
  /** Called with the keys, before any is asked for; it may throw to refuse. */
  readonly beforeAcquire?: (keys: readonly string[]) => void;
}

/** Atomically joins every requested key queue in FIFO order to avoid acquisition cycles.
 * Nested work needs an explicit live lease; implicit context can refuse access but cannot grant it. */
export class KeyedMutex {
  private readonly queues = new Map<string, Waiter[]>();
  private readonly context = new AsyncLocalStorage<Lease>();

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

  /** Runs immediately under a live lease; requesting any additional key throws. */
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

  /** Detaches from the holder context so new work waits for keys independently. */
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
        // An ungranted request owns no keys, so cancellation only removes its queue entries.
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

  private wake(keys: readonly string[]): void {
    for (const key of keys) {
      const head = this.queues.get(key)?.[0];
      if (head && !head.granted && this.heads(head)) head.grant();
    }
  }
}
