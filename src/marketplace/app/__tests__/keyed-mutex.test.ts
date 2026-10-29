import { describe, expect, it } from "vitest";
import { KeyedMutex, type MutexLease } from "../keyed-mutex.js";

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

async function turns(count: number): Promise<void> {
  for (let i = 0; i < count; i += 1) await turn();
}

function gate() {
  let open!: () => void;
  let entered!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  const inside = new Promise<void>((resolve) => (entered = resolve));
  return { open, inside, hold: async () => { entered(); await opened; } };
}

function heldMutex(keys: string[]) {
  const mutex = new KeyedMutex();
  const holder = gate();
  return { mutex, holder, held: mutex.run(keys, holder.hold) };
}

async function bounded<T>(work: Promise<T>): Promise<T | "stuck"> {
  return Promise.race([work, new Promise<"stuck">((resolve) => setTimeout(() => resolve("stuck"), 1_000))]);
}

describe("KeyedMutex", () => {
  it("grants one key's requests in arrival order", async () => {
    const mutex = new KeyedMutex();
    const first = gate();
    const order: string[] = [];
    const held = mutex.run(["p"], first.hold);
    await first.inside;
    const waiting = ["b", "c", "d"].map((name) => mutex.run(["p"], async () => { order.push(name); }));
    await turns(3);
    expect(order).toEqual([]);
    first.open();
    await Promise.all([held, ...waiting]);
    expect(order).toEqual(["b", "c", "d"]);
    expect(mutex.idle).toBe(true);
  });

  it("takes every key of a request as one: it holds none while it waits for one of them", async () => {
    const { mutex, holder, held } = heldMutex(["b"]);
    await holder.inside;
    let bothRan = false;
    const both = mutex.run(["b", "a"], async (lease) => { bothRan = true; return lease.keys; });
    await turns(2);
    // The later single-key request waits behind the earlier request for both keys.
    let aRan = false;
    const onlyA = mutex.run(["a"], async () => { aRan = true; });
    await turns(2);
    expect([bothRan, aRan]).toEqual([false, false]);
    holder.open();
    expect(await both).toEqual(["a", "b"]);
    await Promise.all([held, onlyA]);
    expect(aRan).toBe(true);
    expect(mutex.idle).toBe(true);
  });

  it("cannot wait in a cycle: two requests for the same keys in opposite order both finish", async () => {
    const { mutex, holder, held } = heldMutex(["a", "b"]);
    await holder.inside;
    const forward = mutex.run(["a", "b"], async () => "forward");
    const backward = mutex.run(["b", "a"], async () => "backward");
    holder.open();
    expect(await bounded(Promise.all([held, forward, backward]))).toEqual([undefined, "forward", "backward"]);
    expect(mutex.idle).toBe(true);
  });

  it("removes only the cancelled request, from every queue: the holder keeps its key and a later caller still waits", async () => {
    const { mutex, holder, held } = heldMutex(["p"]);
    await holder.inside;
    const abort = new AbortController();
    let cancelledRan = false;
    const cancelled = mutex.run(["p", "q"], async () => { cancelledRan = true; }, { signal: abort.signal }).catch((error: unknown) => error);
    await turns(2);
    abort.abort(new Error("shutdown"));
    expect(await cancelled).toMatchObject({ message: "shutdown" });
    let laterEntered = false;
    const later = mutex.run(["p"], async () => { laterEntered = true; });
    expect(await bounded(mutex.run(["q"], async () => "q"))).toBe("q");
    await turns(3);
    expect(laterEntered).toBe(false);
    holder.open();
    await Promise.all([held, later]);
    expect(laterEntered).toBe(true);
    expect(cancelledRan).toBe(false);
    expect(mutex.idle).toBe(true);
  });

  it("ends a multi-key wait at once when cancelled, whichever key it waits for", async () => {
    const { mutex, holder, held } = heldMutex(["b"]);
    await holder.inside;
    const abort = new AbortController();
    const both = mutex.run(["a", "b"], async () => "ran", { signal: abort.signal }).catch((error: unknown) => error);
    abort.abort(new Error("shutdown"));
    expect(await bounded(both)).toMatchObject({ message: "shutdown" });
    expect(await bounded(mutex.run(["a"], async () => "a"))).toBe("a");
    holder.open();
    await held;
    expect(mutex.idle).toBe(true);
  });

  it("lets a waiter behind a cancelled request run once it heads all its queues", async () => {
    const { mutex, holder, held } = heldMutex(["a"]);
    await holder.inside;
    const abort = new AbortController();
    const blocked = mutex.run(["a", "b"], async () => "ran", { signal: abort.signal }).catch((error: unknown) => error);
    const onlyB = mutex.run(["b"], async () => "b");
    await turns(2);
    abort.abort(new Error("shutdown"));
    expect(await bounded(onlyB)).toBe("b");
    await blocked;
    holder.open();
    await held;
    expect(mutex.idle).toBe(true);
  });

  it("does not start a request granted in the same turn as its cancellation", async () => {
    const mutex = new KeyedMutex();
    const abort = new AbortController();
    let ran = false;
    // Cancellation before the deferred body starts must prevent entry.
    const request = mutex.run(["p"], async () => { ran = true; }, { signal: abort.signal }).catch((error: unknown) => error);
    abort.abort(new Error("shutdown"));
    expect(await request).toMatchObject({ message: "shutdown" });
    expect(ran).toBe(false);
    expect(mutex.idle).toBe(true);
  });

  it("refuses a request that names no key: work that needs none takes no lock", async () => {
    const mutex = new KeyedMutex();
    await expect(mutex.run([], async () => {})).rejects.toThrow(/lock contract: a lock request names no key/u);
    expect(mutex.idle).toBe(true);
  });

  it("runs work under keys the lease holds at once, and refuses any key it does not hold", async () => {
    const mutex = new KeyedMutex();
    expect(await mutex.run(["a", "b"], (lease) => mutex.within(lease, ["b"], async () => "under b"))).toBe("under b");
    await expect(mutex.run(["a"], (lease) => mutex.within(lease, ["a", "b"], async () => {}))).rejects.toThrow(
      /lock contract: b asked for under the lease of a; a lease runs work only under keys it holds/u,
    );
    await expect(mutex.run(["a"], (lease) => mutex.within(lease, [], async () => {}))).rejects.toThrow(/no key asked for under the lease of a/u);
    expect(mutex.idle).toBe(true);
  });

  it("refuses a request from a caller holding keys that did not pass its lease, inside work under the lease too", async () => {
    const mutex = new KeyedMutex();
    await expect(mutex.run(["p"], () => mutex.run(["p"], async () => {}))).rejects.toThrow(
      /lock contract: p asked for by a caller holding p; declare every key up front, or pass the lease/u,
    );
    await expect(mutex.run(["b"], () => mutex.run(["a"], async () => {}))).rejects.toThrow(/a asked for by a caller holding b/u);
    await expect(mutex.run(["a", "b"], (lease) => mutex.within(lease, ["a"], () => mutex.run(["c"], async () => {})))).rejects.toThrow(
      /c asked for by a caller holding a, b/u,
    );
    expect(mutex.idle).toBe(true);
  });

  it("refuses a lease passed after its holder returned, or one of another lock", async () => {
    const mutex = new KeyedMutex();
    let kept!: MutexLease;
    await mutex.run(["p"], async (lease) => { kept = lease; });
    await expect(mutex.within(kept, ["p"], async () => {})).rejects.toThrow(/lock contract: the lease of p was passed after its holder returned/u);
    await expect(mutex.within({ keys: ["p"] }, ["p"], async () => {})).rejects.toThrow(/the lease passed does not belong to this lock/u);
    await expect(mutex.run(["p"], (lease) => new KeyedMutex().within(lease, ["p"], async () => {}))).rejects.toThrow(/does not belong to this lock/u);
  });

  it("releases its keys only once the work admitted under its lease ends, and admits none after it returned", async () => {
    const mutex = new KeyedMutex();
    const child = gate();
    let underLease!: Promise<string>;
    let kept!: MutexLease;
    const order: string[] = [];
    const holder = mutex.run(["p"], async (lease) => {
      kept = lease;
      underLease = mutex.within(lease, ["p"], async () => { await child.hold(); order.push("child"); return "child"; });
      await child.inside;
    });
    const later = mutex.run(["p"], async () => { order.push("later"); });
    await turns(3);
    await expect(mutex.within(kept, ["p"], async () => {})).rejects.toThrow(/passed after its holder returned/u);
    expect(order).toEqual([]);
    child.open();
    await Promise.all([holder, underLease, later]);
    expect(order).toEqual(["child", "later"]);
    expect(mutex.idle).toBe(true);
  });

  it("does not refuse work the holder detached: it is another caller and waits", async () => {
    const mutex = new KeyedMutex();
    let detached!: Promise<string>;
    await mutex.run(["p"], async () => {
      detached = mutex.detached(() => mutex.run(["p"], async () => "after"));
      await turns(2);
    });
    expect(await detached).toBe("after");
    expect(mutex.idle).toBe(true);
  });

  it("checks the hook with every key before waiting, and holds nothing when it refuses", async () => {
    const mutex = new KeyedMutex();
    const seen: string[][] = [];
    await expect(mutex.run(["b", "a", "a"], async () => {}, { beforeAcquire: (keys) => { seen.push([...keys]); throw new Error("refused"); } }))
      .rejects.toThrow("refused");
    expect(seen).toEqual([["a", "b"]]);
    expect(mutex.idle).toBe(true);
  });
});

/** xorshift32 keeps failures reproducible from the seed. */
function seeded(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 4294967296;
  };
}

const KEYS = ["k0", "k1", "k2", "k3", "k4"];

describe("KeyedMutex under random interleavings", () => {
  /** Tracks ownership independently of the lock and rechecks it after every await. */
  async function scenario(seed: number): Promise<void> {
    const next = seeded(seed);
    const mutex = new KeyedMutex();
    const owner = new Map<string, number>();
    const violations: string[] = [];
    let ids = 0;

    const stillOwns = (id: number, keys: readonly string[], when: string) => {
      for (const key of keys) {
        if (owner.get(key) !== id) violations.push(`seed ${seed}: task ${id} ${when} without owning ${key} (owner ${owner.get(key)})`);
      }
    };

    const task = async () => {
      await turns(Math.floor(next() * 3));
      const keys = KEYS.filter(() => next() < 0.35);
      if (keys.length === 0) keys.push(KEYS[Math.floor(next() * KEYS.length)]!);
      if (next() < 0.3) keys.reverse();
      const requested = [...new Set(keys)].sort();
      const abort = new AbortController();
      const cancel = next();
      if (cancel < 0.15) queueMicrotask(() => abort.abort(new Error("cancelled")));
      else if (cancel < 0.4) void turns(Math.floor(next() * 4)).then(() => abort.abort(new Error("cancelled")));
      const id = (ids += 1);
      let ran = false;
      const ticks = Math.floor(next() * 4);
      const nested = next();
      try {
        await mutex.run(keys, async (lease) => {
          ran = true;
          if (lease.keys.join() !== requested.join()) violations.push(`seed ${seed}: task ${id} got a lease of ${lease.keys.join()} for ${requested.join()}`);
          for (const key of requested) {
            if (owner.has(key)) violations.push(`seed ${seed}: task ${id} entered with ${key} owned by ${owner.get(key)}`);
            owner.set(key, id);
          }
          for (let i = 0; i < ticks; i += 1) {
            await (next() < 0.5 ? turn() : Promise.resolve());
            stillOwns(id, requested, "ran on");
          }
          if (nested < 0.3) {
            const some = requested.filter(() => next() < 0.6);
            if (some.length > 0) await mutex.within(lease, some, async () => { await turn(); stillOwns(id, requested, "ran under its lease"); });
          }
          stillOwns(id, requested, "returned");
          for (const key of requested) owner.delete(key);
        }, { signal: abort.signal });
        return "done";
      } catch (error) {
        if ((error as Error).message !== "cancelled") throw error;
        if (ran) violations.push(`seed ${seed}: task ${id} ran and then reported its cancellation`);
        return "cancelled";
      }
    };

    const tasks = Array.from({ length: 10 }, () => task());
    const settled = await bounded(Promise.all(tasks));
    expect(settled, `seed ${seed}: a request was never woken`).not.toBe("stuck");
    expect(violations).toEqual([]);
    expect(mutex.idle, `seed ${seed}: a reservation outlived its request`).toBe(true);
    expect(owner.size).toBe(0);
  }

  it("keeps each key with one owner, wakes every waiter and leaves no reservation, across 300 seeds", async () => {
    for (let seed = 1; seed <= 300; seed += 1) await scenario(seed);
  }, 120_000);
});
