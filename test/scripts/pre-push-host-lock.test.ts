/**
 * Parallel writers on one host each ran the full pre-push tier at once; the
 * load average passed 190 and load-sensitive tests timed out. The full tier
 * now holds one exclusive host lock and the fast tier one of a few shared
 * slots. These suites pin that the lock orders runs without skipping any:
 * a second run waits and says for whom, a dead owner's lock is reclaimed, and
 * a run that cannot get its turn fails instead of passing.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { resolveHostLockSettings, withHostLock } from "../../scripts/hooks/pre-push-host-lock.mjs";

const LOCK_MODULE = pathToFileURL(resolve("scripts/hooks/pre-push-host-lock.mjs")).href;
const directories: string[] = [];

function lockDirectory() {
  const directory = mkdtempSync(join(tmpdir(), "pre-push-host-lock-"));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

// A process that holds the named lock until `release` appears.
function holder(directory: string, name: string, slots = 1) {
  const script = join(directory, `holder-${Math.random().toString(36).slice(2)}.mjs`);
  writeFileSync(script, `
import { existsSync, writeFileSync } from "node:fs";
import { withHostLock } from ${JSON.stringify(LOCK_MODULE)};
const [directory, name, slots, marker, release] = process.argv.slice(2);
withHostLock({ name, label: name, directory, timeoutMs: 60_000, slots: Number(slots), pollMs: 50 }, () => {
  writeFileSync(marker, "held");
  while (!existsSync(release)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
});
`);
  const marker = `${script}.held`;
  const release = `${script}.release`;
  const child = spawn(process.execPath, [script, directory, name, String(slots), marker, release], { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const exited = new Promise<number | null>((done) => child.on("exit", (code) => done(code)));
  return {
    pid: child.pid!,
    held: () => existsSync(marker),
    release: () => writeFileSync(release, "go"),
    output: () => output,
    exited,
  };
}

async function waitFor(condition: () => boolean, label: string) {
  const deadline = Date.now() + 20_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((done) => setTimeout(done, 25));
  }
}

function deadPid() {
  const result = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
  return Number(result.stdout);
}

describe("pre-push host lock", () => {
  it("makes a second full run wait for the first, says who holds it, and releases both", async () => {
    const directory = lockDirectory();
    const first = holder(directory, "full");
    await waitFor(first.held, "the first holder");
    const second = holder(directory, "full");
    await waitFor(() => second.output().includes("waiting for the full host lock"), "the waiting message");
    expect(second.output()).toContain(`held by PID ${first.pid}`);
    expect(second.held()).toBe(false);
    first.release();
    expect(await first.exited).toBe(0);
    await waitFor(second.held, "the second holder");
    expect(second.output()).toMatch(/acquired the full host lock after \d+s/);
    second.release();
    expect(await second.exited).toBe(0);
    expect(existsSync(join(directory, "ave-prepush-full.lock"))).toBe(false);
  }, 30_000);

  it("releases the lock when the checks throw, so the failure is reported and the next run proceeds", () => {
    const directory = lockDirectory();
    expect(() => withHostLock({ name: "full", label: "full-tier", directory, timeoutMs: 1000 }, () => {
      throw new Error("bun run test failed");
    })).toThrow("bun run test failed");
    expect(existsSync(join(directory, "ave-prepush-full.lock"))).toBe(false);
    expect(withHostLock({ name: "full", label: "full-tier", directory, timeoutMs: 1000 }, () => "ran")).toBe("ran");
  });

  it("reclaims a lock whose owner PID is no longer running", () => {
    const directory = lockDirectory();
    const lock = join(directory, "ave-prepush-full.lock");
    mkdirSync(lock);
    const pid = deadPid();
    writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid, token: "dead-owner", createdAt: new Date().toISOString() }));
    const log: string[] = [];
    let ran = false;
    withHostLock({ name: "full", label: "full-tier", directory, timeoutMs: 1000, log: (line) => log.push(line) }, () => {
      ran = true;
      expect(existsSync(lock)).toBe(true);
    });
    expect(ran).toBe(true);
    expect(log.some((line) => line.includes("waiting"))).toBe(false);
    expect(existsSync(lock)).toBe(false);
  });

  it("reclaims a lock that never recorded an owner once the grace period passed, and not before", () => {
    const directory = lockDirectory();
    const lock = join(directory, "ave-prepush-full.lock");
    mkdirSync(lock);
    expect(() => withHostLock({ name: "full", label: "full-tier", directory, timeoutMs: 300, pollMs: 50, log: () => {} }, () => "ran"))
      .toThrow("[PRE_PUSH_HOST_LOCK_TIMEOUT]");
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);
    expect(withHostLock({ name: "full", label: "full-tier", directory, timeoutMs: 300, pollMs: 50 }, () => "ran")).toBe("ran");
  });

  it("fails clearly at the timeout while a live process holds the lock, without running the checks", () => {
    const directory = lockDirectory();
    const lock = join(directory, "ave-prepush-full.lock");
    mkdirSync(lock);
    writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid: process.pid, token: "live-owner", createdAt: new Date().toISOString() }));
    const log: string[] = [];
    let ran = false;
    expect(() => withHostLock(
      { name: "full", label: "full-tier", directory, timeoutMs: 400, pollMs: 50, log: (line) => log.push(line) },
      () => { ran = true; },
    )).toThrow(new RegExp(`\\[PRE_PUSH_HOST_LOCK_TIMEOUT\\] waited \\d+s for the full-tier host lock \\(held by PID ${process.pid}: .*no checks ran and the push is refused`));
    expect(ran).toBe(false);
    expect(log[0]).toContain(`waiting for the full-tier host lock held by PID ${process.pid}`);
    // The live owner's lock is left alone.
    expect(existsSync(join(lock, "owner.json"))).toBe(true);
  });

  it("lets fast runs share slots and makes the next one wait when all are taken", async () => {
    const directory = lockDirectory();
    const first = holder(directory, "fast", 2);
    const second = holder(directory, "fast", 2);
    await waitFor(() => first.held() && second.held(), "two slot holders");
    let ran = false;
    expect(() => withHostLock(
      { name: "fast", label: "fast-tier", directory, timeoutMs: 300, slots: 2, pollMs: 50, log: () => {} },
      () => { ran = true; },
    )).toThrow(/held by PID \d+, PID \d+/);
    expect(ran).toBe(false);
    first.release();
    expect(await first.exited).toBe(0);
    expect(withHostLock({ name: "fast", label: "fast-tier", directory, timeoutMs: 5000, slots: 2, pollMs: 50 }, () => "ran")).toBe("ran");
    second.release();
    expect(await second.exited).toBe(0);
  }, 30_000);

  it("reads its settings from the environment and refuses a malformed timeout", () => {
    expect(resolveHostLockSettings({ AVE_PREPUSH_LOCK_DIR: "/locks", AVE_PREPUSH_LOCK_TIMEOUT_S: "5", AVE_PREPUSH_FAST_SLOTS: "2" }))
      .toEqual({ directory: "/locks", timeoutMs: 5000, fastSlots: 2 });
    const defaults = resolveHostLockSettings({});
    expect(defaults.timeoutMs).toBe(3_600_000);
    expect(defaults.fastSlots).toBe(4);
    if (process.platform !== "win32") expect(defaults.directory).toBe("/tmp");
    for (const value of ["0", "-1", "1.5", "soon", "1e3"]) {
      expect(() => resolveHostLockSettings({ AVE_PREPUSH_LOCK_TIMEOUT_S: value }))
        .toThrow(`AVE_PREPUSH_LOCK_TIMEOUT_S must be a positive whole number (got ${JSON.stringify(value)})`);
    }
  });
});
