import { describe, expect, it } from "vitest";
import { KeyedMutex, type MutexLease } from "../keyed-mutex.js";

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

async function turns(count: number): Promise<void> {
  for (let i = 0; i < count; i += 1) await turn();
}

/** A gate the test opens: `entered` resolves when the holder runs, `open()` lets it return. */
function gate() {
  let open!: () => void;
  let entered!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  const inside = new Promise<void>((resolve) => (entered = resolve));
  return { open, inside, hold: async () => { entered(); await opened; } };
}

describe("KeyedMutex", () => {
  it("grants one key's waiters in arrival order", async () => {
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

  it("removes only the cancelled waiter: the holder keeps the key and a later caller still waits for it", async () => {
    const mutex = new KeyedMutex();
    const holder = gate();
    const held = mutex.run(["p"], holder.hold);
    await holder.inside;
    const abort = new AbortController();
    let cancelledRan = false;
    const cancelled = mutex.run(["p"], async () => { cancelledRan = true; }, { signal: abort.signal }).catch((error: unknown) => error);
    await turns(2);
    abort.abort(new Error("shutdown"));
    expect(await cancelled).toMatchObject({ message: "shutdown" });
    let laterEntered = false;
    const later = mutex.run(["p"], async () => { laterEntered = true; });
    await turns(5);
    expect(laterEntered).toBe(false);
    holder.open();
    await Promise.all([held, later]);
    expect(laterEntered).toBe(true);
    expect(cancelledRan).toBe(false);
    expect(mutex.idle).toBe(true);
  });

  it("releases the keys a cancelled caller already took, and only those", async () => {
    const mutex = new KeyedMutex();
    const holder = gate();
    const held = mutex.run(["b"], holder.hold);
    await holder.inside;
    const abort = new AbortController();
    const both = mutex.run(["a", "b"], async () => {}, { signal: abort.signal }).catch((error: unknown) => error);
    await turns(2);
    let aEntered = false;
    const onlyA = mutex.run(["a"], async () => { aEntered = true; });
    await turns(2);
    expect(aEntered).toBe(false);
    abort.abort(new Error("shutdown"));
    await both;
    await onlyA;
    expect(aEntered).toBe(true);
    holder.open();
    await held;
    expect(mutex.idle).toBe(true);
  });

  it("re-enters a held key only with the lease passed down", async () => {
    const mutex = new KeyedMutex();
    const inner = await mutex.run(["p"], (lease) => mutex.run(["p"], async (nested) => nested.keys, { within: lease }));
    expect(inner).toEqual(["p"]);
    await expect(mutex.run(["p"], () => mutex.run(["p"], async () => {}))).rejects.toThrow(
      /lock contract: p asked for without the lease of a caller holding p; pass it down/u,
    );
    // Asking for no key needs no lease: it cannot wait for anything.
    expect(await mutex.run(["p"], () => mutex.run([], async (nested) => nested.keys))).toEqual([]);
    // Asking for another key without the lease is refused the same way: it could wait in the wrong order.
    await expect(mutex.run(["b"], () => mutex.run(["a"], async () => {}))).rejects.toThrow(/without the lease of a caller holding b/u);
    expect(mutex.idle).toBe(true);
  });

  it("extends a lease only with keys above every key it holds, so two holders extending never wait in a cycle", async () => {
    const mutex = new KeyedMutex();
    await expect(mutex.run(["b"], (lease) => mutex.run(["a"], async () => {}, { within: lease }))).rejects.toThrow(
      /lock order: a asked for while holding b; a lease extends only with keys above every key it holds/u,
    );
    await expect(mutex.run(["a", "c"], (lease) => mutex.run(["b"], async () => {}, { within: lease }))).rejects.toThrow(/lock order: b asked for while holding a, c/u);
    expect(await mutex.run(["a"], (lease) => mutex.run(["a", "b"], async (nested) => nested.keys, { within: lease }))).toEqual(["a", "b"]);
    expect(mutex.idle).toBe(true);
  });

  it("refuses a lease passed after its holder returned", async () => {
    const mutex = new KeyedMutex();
    let kept!: MutexLease;
    await mutex.run(["p"], async (lease) => { kept = lease; });
    await expect(mutex.run(["p"], async () => {}, { within: kept })).rejects.toThrow(/lock contract: the lease of p was passed after its holder returned/u);
    await expect(mutex.run(["p"], async () => {}, { within: { keys: ["p"] } })).rejects.toThrow(/the lease passed does not belong to this lock/u);
    await expect(mutex.run(["p"], (lease) => new KeyedMutex().run(["p"], async () => {}, { within: lease }))).rejects.toThrow(/the lease passed does not belong to this lock/u);
  });

  it("keeps the keys of a holder that returned while a lease extending it still waits or runs", async () => {
    const mutex = new KeyedMutex();
    const b = gate();
    const holdsB = mutex.run(["b"], b.hold);
    await b.inside;
    let child!: Promise<boolean>;
    await mutex.run(["a"], async (lease) => {
      // Detached on purpose: the child extends a with b and outlives this holder.
      child = mutex.run(["b"], async (nested) => nested.keys.includes("a"), { within: lease });
      await turn();
    });
    let laterEnteredA = false;
    const laterA = mutex.run(["a"], async () => { laterEnteredA = true; });
    await turns(5);
    // The holder of a returned, but the lease extending it still needs a.
    expect(laterEnteredA).toBe(false);
    b.open();
    expect(await child).toBe(true);
    await Promise.all([holdsB, laterA]);
    expect(laterEnteredA).toBe(true);
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

  it("checks every key's hook before waiting and gives up without holding anything when it throws", async () => {
    const mutex = new KeyedMutex();
    const seen: string[][] = [];
    await expect(mutex.run(["b", "a", "a"], async () => {}, { beforeAcquire: (keys) => { seen.push([...keys]); throw new Error("refused"); } }))
      .rejects.toThrow("refused");
    expect(seen).toEqual([["a", "b"]]);
    expect(mutex.idle).toBe(true);
  });
});

/** A small deterministic generator (xorshift32), so a failing seed reproduces. */
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
  async function scenario(seed: number): Promise<void> {
    const next = seeded(seed);
    const pick = (count: number) => KEYS.filter(() => next() < count / KEYS.length);
    const mutex = new KeyedMutex();
    // The lease id that owns each key now, set when its function enters and cleared before it returns.
    const owner = new Map<string, number>();
    let ids = 0;
    const violations: string[] = [];

    const critical = async (lease: MutexLease, own: readonly string[], inherited: ReadonlyMap<string, number>, id: number, ticks: number, body: () => Promise<void>) => {
      for (const key of lease.keys) {
        const current = owner.get(key);
        if (own.includes(key)) {
          if (current !== undefined) violations.push(`seed ${seed}: ${key} entered by ${id} while ${current} holds it`);
          owner.set(key, id);
        } else if (current !== inherited.get(key)) {
          violations.push(`seed ${seed}: ${id} re-entered ${key} owned by ${current}, not its holder ${inherited.get(key)}`);
        }
      }
      for (let i = 0; i < ticks; i += 1) await (next() < 0.5 ? turn() : Promise.resolve());
      await body();
      for (const key of own) owner.delete(key);
    };

    const task = async () => {
      await turns(Math.floor(next() * 3));
      const keys = pick(2).length > 0 ? pick(2) : [KEYS[Math.floor(next() * KEYS.length)]!];
      const abort = new AbortController();
      const cancelAfter = next() < 0.35 ? Math.floor(next() * 4) : null;
      if (cancelAfter !== null) void turns(cancelAfter).then(() => abort.abort(new Error("cancelled")));
      const id = (ids += 1);
      let ran = false;
      const nestedKind = next();
      try {
        await mutex.run(keys, async (lease) => {
          ran = true;
          const own = [...new Set(keys)];
          await critical(lease, own, new Map(), id, Math.floor(next() * 4), async () => {
            const highest = lease.keys.at(-1)!;
            const above = KEYS.filter((key) => key > highest && next() < 0.5);
            const inherited = new Map(lease.keys.map((key) => [key, owner.get(key)!] as const));
            if (nestedKind < 0.25 && above.length > 0) {
              const childId = (ids += 1);
              await mutex.run([lease.keys[0]!, ...above], (child) => critical(child, above, inherited, childId, Math.floor(next() * 3), async () => {}), { within: lease });
            } else if (nestedKind < 0.4) {
              const childId = (ids += 1);
              await mutex.run([...lease.keys], (child) => critical(child, [], inherited, childId, 1, async () => {}), { within: lease });
            }
          });
        }, { signal: abort.signal });
        return { ran, cancelled: false };
      } catch (error) {
        if ((error as Error).message !== "cancelled") throw error;
        if (ran) violations.push(`seed ${seed}: task ${id} ran and then reported its cancellation`);
        return { ran, cancelled: true };
      }
    };

    const tasks = Array.from({ length: 10 }, () => task());
    const settled = await Promise.race([
      Promise.all(tasks).then((results) => ({ results })),
      new Promise<"stuck">((resolve) => setTimeout(() => resolve("stuck"), 2_000)),
    ]);
    // No lost wakeup: every caller that was not cancelled got its keys and finished.
    expect(settled, `seed ${seed}: a waiter was never woken`).not.toBe("stuck");
    expect(violations).toEqual([]);
    // No orphaned reservation: nothing is held or waited for once every caller settled.
    expect(mutex.idle, `seed ${seed}: a reservation outlived its caller`).toBe(true);
    expect(owner.size).toBe(0);
  }

  it("keeps mutual exclusion, wakes every waiter and leaves no reservation, across 300 seeds", async () => {
    for (let seed = 1; seed <= 300; seed += 1) await scenario(seed);
  }, 120_000);
});
