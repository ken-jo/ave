/** Locks serialize writes; plain reads may still observe the pre-write value. */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync, realpath, rmSync, symlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import lockfile from "proper-lockfile";
import { FileLockReleaseError, createSerialQueue, withFileLock, withInProcessFileQueue } from "../with-file-lock.js";

import { deferred } from "../../__tests__/support/deferred.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";

let tmpDir: string;
let testFile: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "with-file-lock-test-"));
  testFile = join(tmpDir, "shared.json");
  writeFileSync(testFile, JSON.stringify({ counter: 0 }), "utf-8");
});

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupTmpDir(tmpDir);
});

function readCounter(): number {
  return (JSON.parse(readFileSync(testFile, "utf-8")) as { counter: number }).counter;
}

async function incrementUnderLock(): Promise<void> {
  await withFileLock(testFile, async () => {
    const current = readCounter();
    await new Promise((r) => setTimeout(r, 5));
    writeFileSync(testFile, JSON.stringify({ counter: current + 1 }), "utf-8");
  }, { retries: 20 });
}

describe("withFileLock", () => {
  it("serialises concurrent writes — no lost updates", async () => {
    const N = 5;
    await Promise.all(Array.from({ length: N }, () => incrementUnderLock()));
    expect(readCounter()).toBe(N);
  });

  it.each([
    ["a spelling alias", () => [testFile, `${dirname(testFile)}/./${basename(testFile)}`] as const],
    ["a parent directory alias", () => {
      const parent = join(tmpDir, "sessions");
      const alias = join(tmpDir, "alias");
      mkdirSync(parent);
      symlinkSync(parent, alias, process.platform === "win32" ? "junction" : "dir");
      return [join(parent, "session.jsonl"), join(alias, "session.jsonl")] as const;
    }],
  ] as const)("keeps a same-process waiter using %s out of a stale-looking lock until release", async (_kind, targets) => {
    const [target, alias] = targets();
    const realLock = lockfile.lock.bind(lockfile);
    const lock = vi.spyOn(lockfile, "lock");
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    try {
      const firstEntered = deferred<void>();
      const secondEntered = deferred<void>();
      const finishFirst = deferred<void>();
      const finishSecond = deferred<void>();
      const first = withFileLock(target, async () => {
        firstEntered.resolve();
        await finishFirst.promise;
        return "first";
      });
      const firstResult = Promise.allSettled([first]);
      await Promise.race([firstEntered.promise, first]);

      vi.setSystemTime(Date.now() + 30_000);
      const preflightFinished = deferred<void>();
      const realpathNative = realpath.native;
      vi.spyOn(realpath, "native").mockImplementationOnce((path, callback) => {
        realpathNative(path, (error, canonicalPath) => {
          callback(error, canonicalPath);
          preflightFinished.resolve();
        });
      });
      lock.mockImplementationOnce((...args) => {
        preflightFinished.resolve();
        return realLock(...args);
      });
      const second = withFileLock(alias, async () => {
        secondEntered.resolve();
        await finishSecond.promise;
        return "second";
      });
      const results = Promise.allSettled([first, second]);
      let attemptedWhileHeld: boolean;
      try {
        await Promise.race([preflightFinished.promise, second]);
        attemptedWhileHeld = lock.mock.calls.length > 1;
        if (attemptedWhileHeld) await Promise.race([secondEntered.promise, second]);
      } finally {
        finishFirst.resolve();
        await firstResult;
        finishSecond.resolve();
        await results;
      }

      expect(await results).toEqual([
        { status: "fulfilled", value: "first" },
        { status: "fulfilled", value: "second" },
      ]);
      expect(attemptedWhileHeld).toBe(false);
      expect(lock.mock.calls.map(([path]) => path)).toEqual([target, resolve(alias)]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("creates a missing target and its parent", async () => {
    const newFile = join(tmpDir, "missing", "nonexistent.json");
    await withFileLock(newFile, async () => {
      writeFileSync(newFile, JSON.stringify({ created: true }), "utf-8");
    });
    expect(existsSync(newFile)).toBe(true);
  });

  it("rejects if the parent cannot be canonicalized", async () => {
    const failure = new Error("parent unavailable");
    vi.spyOn(realpath, "native").mockImplementationOnce((_path, callback) => callback(failure, ""));
    const lock = vi.spyOn(lockfile, "lock");
    await expect(withFileLock(testFile, async () => undefined)).rejects.toBe(failure);
    expect(lock).not.toHaveBeenCalled();
  });

  it("a waiting caller does not open the target before it holds the lock", async () => {
    // A waiting caller must not hold the target open or recreate a holder-removed file before acquiring the lock.
    const runWaiter = AsyncLocalStorage.snapshot();
    let waiter: Promise<void> | undefined;
    await withFileLock(testFile, async () => {
      rmSync(testFile);
      waiter = runWaiter(() => withFileLock(testFile, async () => {}));
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(existsSync(testFile)).toBe(false);
      writeFileSync(testFile, "{}", "utf-8");
    });
    await waiter;
    expect(readFileSync(testFile, "utf-8")).toBe("{}");
  });

  it("rejects an awaited same-key acquire during a lock callback", async () => {
    const lock = vi.spyOn(lockfile, "lock");
    await expect(withFileLock(testFile, async () => {
      await withFileLock(testFile, async () => undefined, { retries: 0 });
    })).rejects.toThrow("re-entrant acquisition of a held file lock");
    expect(lock).toHaveBeenCalledTimes(1);
    expect(existsSync(`${testFile}.lock`)).toBe(false);
  });

  it("allows work that inherits a lock context to acquire after the callback settles", async () => {
    const startWaiter = deferred<void>();
    let waiter!: Promise<string>;
    await withFileLock(testFile, async () => {
      waiter = startWaiter.promise.then(() => withFileLock(testFile, async () => "waiter"));
    });
    startWaiter.resolve();
    await expect(waiter).resolves.toBe("waiter");
  });

  it("allows a different nested key and rejects reacquiring an ancestor key", async () => {
    await expect(withFileLock(testFile, () => withFileLock(join(tmpDir, "other.json"), async () => {
      await expect(withFileLock(testFile, async () => undefined, { retries: 0 }))
        .rejects.toThrow("re-entrant acquisition of a held file lock");
      return "nested";
    }))).resolves.toBe("nested");
  });

  it("stale lock recovery — removes leftover .lock dir and acquires fresh lock", async () => {
    // Backdate the lock-directory mtime to exercise stale recovery.
    const staleLockDir = `${testFile}.lock`;
    mkdirSync(staleLockDir);
    const pastSec = (Date.now() - 2000) / 1000;
    const { utimesSync } = await import("node:fs");
    utimesSync(staleLockDir, pastSec, pastSec);

    let executed = false;
    await withFileLock(
      testFile,
      async () => {
        executed = true;
      },
      { stale: 500, retries: 3 },
    );
    expect(executed).toBe(true);
  });

  it("propagates errors from fn and releases the lock", async () => {
    await expect(
      withFileLock(testFile, async () => {
        throw new Error("test-error");
      }),
    ).rejects.toThrow("test-error");

    let ran = false;
    await withFileLock(testFile, async () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });

  it("distinguishes callback completion from a release failure", async () => {
    const realLock = lockfile.lock.bind(lockfile);
    vi.spyOn(lockfile, "lock").mockImplementationOnce(async (...args) => {
      const release = await realLock(...args);
      return async () => {
        await release();
        throw new Error("injected release failure");
      };
    });

    const error = await withFileLock(testFile, async () => "committed-result").catch(
      (caught) => caught,
    );
    expect(error).toBeInstanceOf(FileLockReleaseError);
    expect((error as FileLockReleaseError<string>).result).toBe("committed-result");
    expect((error as FileLockReleaseError<string>).releaseError).toEqual(
      new Error("injected release failure"),
    );
  });

  /** Hold the lock-refresh stat callback until after release to reproduce a late ENOENT race. */
  function holdLockRefreshStat(): { arm: () => void; held: () => ((error: Error) => void) | undefined } {
    const lockfileFs = createRequire(createRequire(import.meta.url).resolve("proper-lockfile"))("graceful-fs") as {
      stat: (...args: unknown[]) => void;
    };
    const realStat = lockfileFs.stat;
    let armed = false;
    let held: ((error: Error) => void) | undefined;
    vi.spyOn(lockfileFs, "stat").mockImplementation((...args: unknown[]) => {
      if (armed && String(args[0]).endsWith(".lock")) {
        held = args.at(-1) as (error: Error) => void;
        return;
      }
      realStat.apply(lockfileFs, args);
    });
    return { arm: () => { armed = true; }, held: () => held };
  }

  const lockGone = (): Error => Object.assign(new Error("ENOENT: lock dir gone"), { code: "ENOENT" });

  it("ignores a lock refresh that reports the lock gone after release", async () => {
    const refresh = holdLockRefreshStat();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await withFileLock(testFile, async () => {
        refresh.arm();
        vi.advanceTimersByTime(5_000);
        return "done";
      });
    } finally {
      vi.useRealTimers();
    }
    expect(existsSync(`${testFile}.lock`)).toBe(false);
    const held = refresh.held();
    expect(held).toBeDefined();
    expect(() => held!(lockGone())).not.toThrow();
  });

  it("hands a lock lost while the callback runs to the caller instead of crashing", async () => {
    const refresh = holdLockRefreshStat();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let error: unknown;
    try {
      error = await withFileLock(testFile, async () => {
        refresh.arm();
        vi.advanceTimersByTime(5_000);
        const held = refresh.held();
        expect(held).toBeDefined();
        expect(() => held!(lockGone())).not.toThrow();
        return "committed-result";
      }).catch((caught) => caught);
    } finally {
      vi.useRealTimers();
    }
    expect(error).toBeInstanceOf(FileLockReleaseError);
    expect((error as FileLockReleaseError<string>).result).toBe("committed-result");
    expect((error as FileLockReleaseError<string>).releaseError).toMatchObject({ code: "ECOMPROMISED" });
  });
});

describe("withInProcessFileQueue", () => {
  it("serializes read-modify-write against the same path", async () => {
    // Interleaved read-modify-write operations must not lose increments.
    const order: string[] = [];
    const bump = (tag: string) => withInProcessFileQueue(testFile, async () => {
      const current = JSON.parse(readFileSync(testFile, "utf-8")) as { counter: number };
      order.push(`${tag}:read=${current.counter}`);
      await new Promise((r) => setTimeout(r, 5));
      writeFileSync(testFile, JSON.stringify({ counter: current.counter + 1 }), "utf-8");
      order.push(`${tag}:wrote=${current.counter + 1}`);
    });
    await Promise.all([bump("a"), bump("b")]);
    expect(JSON.parse(readFileSync(testFile, "utf-8"))).toEqual({ counter: 2 });
    expect(order).toEqual(["a:read=0", "a:wrote=1", "b:read=1", "b:wrote=2"]);
  });

  it("does not serialize across different paths", async () => {
    const other = join(tmpDir, "other.json");
    let releaseFirst: (() => void) | undefined;
    const first = withInProcessFileQueue(testFile, () => new Promise<void>((resolve) => {
      releaseFirst = resolve;
    }));
    let secondRan = false;
    const second = withInProcessFileQueue(other, async () => {
      secondRan = true;
    });
    await second;
    expect(secondRan).toBe(true);
    releaseFirst?.();
    await first;
  });

  it("keeps the queue moving after a rejected callback", async () => {
    // Keep caller rejections visible while swallowing the stored chain link so later operations still run.
    await expect(
      withInProcessFileQueue(testFile, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    await expect(withInProcessFileQueue(testFile, async () => "after")).resolves.toBe("after");
  });

  it("is not the cross-process lock and creates no lockfile", async () => {
    await withInProcessFileQueue(testFile, async () => undefined);
    expect(existsSync(`${testFile}.lock`)).toBe(false);
    await withFileLock(testFile, async () => undefined);
    expect(existsSync(`${testFile}.lock`)).toBe(false);
  });
});

describe("createSerialQueue", () => {
  it("runs work in submission order, one at a time", async () => {
    const queue = createSerialQueue();
    const order: string[] = [];
    let releaseFirst!: () => void;
    const first = queue(() => new Promise<string>((resolve) => {
      releaseFirst = () => { order.push("first:done"); resolve("first"); };
    }));
    const second = queue(async () => { order.push("second:start"); return "second"; });
    await new Promise((r) => setTimeout(r, 5));
    expect(order).toEqual([]);
    releaseFirst();
    expect(await Promise.all([first, second])).toEqual(["first", "second"]);
    expect(order).toEqual(["first:done", "second:start"]);
  });

  it("hands a rejection to its own caller without wedging the queue", async () => {
    const queue = createSerialQueue();
    const failed = queue(async () => { throw new Error("boom"); });
    const next = queue(async () => "after");
    await expect(failed).rejects.toThrow("boom");
    expect(await next).toBe("after");
  });
});
