/** Locks serialize writes; plain reads may still observe the pre-write value. */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";
import lockfile from "proper-lockfile";
import { FileLockReleaseError, createSerialQueue, withFileLock, withInProcessFileQueue } from "../with-file-lock.js";

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

  it("creates target file if it does not exist", async () => {
    const newFile = join(tmpDir, "nonexistent.json");
    await withFileLock(newFile, async () => {
      writeFileSync(newFile, JSON.stringify({ created: true }), "utf-8");
    });
    expect(existsSync(newFile)).toBe(true);
  });

  it("a waiting caller does not open the target before it holds the lock", async () => {
    // A waiting caller must not hold the target open or recreate a holder-removed file before acquiring the lock.
    let waiter: Promise<void> | undefined;
    await withFileLock(testFile, async () => {
      rmSync(testFile);
      waiter = withFileLock(testFile, async () => {});
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(existsSync(testFile)).toBe(false);
      writeFileSync(testFile, "{}", "utf-8");
    });
    await waiter;
    expect(readFileSync(testFile, "utf-8")).toBe("{}");
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
