/**
 * Parallel writers on one host each ran the full pre-push tier at once; the
 * load average passed 190 and load-sensitive tests timed out. The full tier
 * now holds one exclusive host lock and the fast tier one of a few shared
 * slots. These suites pin that the lock orders runs without skipping any:
 * a second run waits and says for whom, a dead owner's lock is reclaimed, and
 * a run that cannot get its turn fails instead of passing.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
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

interface LockPause {
  operation: "mkdirSync" | "writeFileSync" | "unlinkSync";
  pathPrefix: string;
  after?: boolean;
  fail?: boolean;
}

// A process that holds the named lock until `release` appears. Filesystem
// barriers pause actual syscalls in the child, without changing the lock API.
function holder(directory: string, name: string, slots?: number, pause?: LockPause) {
  const script = join(directory, `holder-${Math.random().toString(36).slice(2)}.mjs`);
  writeFileSync(script, `
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const [directory, name, slots, marker, release] = process.argv.slice(2);
const pause = ${JSON.stringify(pause ?? null)};
const write = fs.writeFileSync;
function waitForFile(path) {
  while (!fs.existsSync(path)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
}
if (pause) {
  const original = fs[pause.operation];
  let paused = false;
  fs[pause.operation] = function(path, ...args) {
    if (paused || !String(path).startsWith(pause.pathPrefix)) return original(path, ...args);
    paused = true;
    const result = pause.after ? original(path, ...args) : undefined;
    write(marker + ".paused", String(path));
    waitForFile(marker + ".resume");
    if (pause.fail) throw Object.assign(new Error("owner write failed"), { code: "EIO" });
    return pause.after ? result : original(path, ...args);
  };
  syncBuiltinESMExports();
}
const { withHostLock } = await import(${JSON.stringify(LOCK_MODULE)});
withHostLock({ name, label: name, directory, timeoutMs: 60_000, ...(slots ? {slots: Number(slots)} : {}), pollMs: 50 }, () => {
  write(marker, "held");
  waitForFile(release);
});
`);
  const marker = `${script}.held`;
  const release = `${script}.release`;
  const child = spawn(process.execPath, [script, directory, name, slots === undefined ? "" : String(slots), marker, release], { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const exited = new Promise<number | null>((done) => child.on("exit", (code) => done(code)));
  return {
    pid: child.pid!,
    held: () => existsSync(marker),
    paused: () => existsSync(`${marker}.paused`),
    pausedPath: () => readFileSync(`${marker}.paused`, "utf8"),
    resume: () => writeFileSync(`${marker}.resume`, "go"),
    release: () => writeFileSync(release, "go"),
    output: () => output,
    exited,
    kill: () => child.kill("SIGKILL"),
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

// Inject publication errnos at the actual filesystem boundary in an isolated
// process. Model destinations that reject replacement even when empty:
// recovery must inspect ownership before removing a generation and retrying.
function publicationProbe(directory: string, mode: "full" | "pool" | "empty" | "write" | "absent" | "vanished", errno: string) {
  const script = join(directory, "publication-probe.mjs");
  writeFileSync(script, `
import fs from "node:fs";
import { join } from "node:path";
import { syncBuiltinESMExports } from "node:module";
const [directory, mode, errno] = process.argv.slice(2);
const name = mode === "pool" ? "fast" : "full";
const lock = join(directory, mode === "pool" ? "ave-prepush-fast-0.lock" : "ave-prepush-full.lock");
const ownerFile = join(lock, "owner-occupied-owner.json");
if (mode !== "absent" && mode !== "vanished") fs.mkdirSync(lock);
if (mode !== "empty" && mode !== "absent" && mode !== "vanished") {
  fs.writeFileSync(ownerFile, JSON.stringify({ pid: process.pid, token: "occupied-owner" }));
}
const rename = fs.renameSync;
const write = fs.writeFileSync;
let denied = 0;
fs.renameSync = (source, destination) => {
  if (fs.existsSync(destination) || mode === "absent" || mode === "vanished" && denied === 0) {
    denied += 1;
    throw Object.assign(new Error("publication " + errno), { code: errno });
  }
  return rename(source, destination);
};
if (mode === "write") fs.writeFileSync = (path, ...args) => {
  if (String(path).includes(".pending-")) throw Object.assign(new Error("initialization " + errno), { code: errno });
  return write(path, ...args);
};
syncBuiltinESMExports();
const { withHostLock } = await import(${JSON.stringify(LOCK_MODULE)});
let ran = 0;
let during = [];
let failure;
const logs = [];
try {
  withHostLock({ name, label: name, directory, timeoutMs: 40, pollMs: 5,
    ...(mode === "pool" ? { slots: 2 } : {}), log: (line) => logs.push(line) }, () => {
    ran += 1;
    during = fs.readdirSync(directory).filter((name) => name.endsWith(".lock"));
  });
} catch (error) { failure = error; }
process.stdout.write(JSON.stringify({ ran, denied, during, logs, pid: process.pid,
  code: failure?.code ?? null, error: failure?.message ?? null,
  ownerPreserved: fs.existsSync(ownerFile),
  remaining: fs.readdirSync(directory).filter((name) => name.endsWith(".lock") || name.includes(".pending-")),
}) + "\\n");
`);
  const result = spawnSync(process.execPath, [script, directory, mode, errno], { encoding: "utf8", timeout: 10_000 });
  expect(result.status, result.stderr || result.error?.message).toBe(0);
  return JSON.parse(result.stdout.trim().split("\n").at(-1)!);
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
    writeFileSync(join(lock, "owner-dead-owner.json"), JSON.stringify({ pid, token: "dead-owner", createdAt: new Date().toISOString() }));
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

  it("reclaims malformed ownership once the grace period passed, and not before", () => {
    const directory = lockDirectory();
    const lock = join(directory, "ave-prepush-full.lock");
    mkdirSync(lock);
    writeFileSync(join(lock, "owner-incomplete.json"), "{");
    expect(() => withHostLock({ name: "full", label: "full-tier", directory, timeoutMs: 300, pollMs: 50, log: () => {} }, () => "ran"))
      .toThrow("[PRE_PUSH_HOST_LOCK_TIMEOUT]");
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);
    expect(withHostLock({ name: "full", label: "full-tier", directory, timeoutMs: 300, pollMs: 50 }, () => "ran")).toBe("ran");
  });

  it("can atomically replace an empty directory because ownership is never published empty", () => {
    const directory = lockDirectory();
    mkdirSync(join(directory, "ave-prepush-full.lock"));
    expect(withHostLock({ name: "full", label: "full-tier", directory, timeoutMs: 300 }, () => "ran")).toBe("ran");
  });

  it("fails clearly at the timeout while a live process holds the lock, without running the checks", () => {
    const directory = lockDirectory();
    const lock = join(directory, "ave-prepush-full.lock");
    mkdirSync(lock);
    writeFileSync(join(lock, "owner-live-owner.json"), JSON.stringify({ pid: process.pid, token: "live-owner", createdAt: new Date().toISOString() }));
    const log: string[] = [];
    let ran = false;
    expect(() => withHostLock(
      { name: "full", label: "full-tier", directory, timeoutMs: 400, pollMs: 50, log: (line) => log.push(line) },
      () => { ran = true; },
    )).toThrow(new RegExp(`\\[PRE_PUSH_HOST_LOCK_TIMEOUT\\] waited \\d+s for the full-tier host lock \\(held by PID ${process.pid}: .*no checks ran and the push is refused`));
    expect(ran).toBe(false);
    expect(log[0]).toContain(`waiting for the full-tier host lock held by PID ${process.pid}`);
    // The live owner's lock is left alone.
    expect(existsSync(join(lock, "owner-live-owner.json"))).toBe(true);
  });

  it("names the holder even when the first acquisition round alone outlasts the timeout", () => {
    // A loaded host can spend longer than the timeout in one round; the notice
    // must not depend on getting a second round in before the deadline.
    const directory = lockDirectory();
    const lock = join(directory, "ave-prepush-full.lock");
    mkdirSync(lock);
    writeFileSync(join(lock, "owner-live-owner.json"), JSON.stringify({ pid: process.pid, token: "live-owner", createdAt: new Date().toISOString() }));
    const log: string[] = [];
    let clock = 0;
    const now = () => {
      const value = clock;
      clock += 1_000;
      return value;
    };
    expect(() => withHostLock(
      { name: "full", label: "full-tier", directory, timeoutMs: 40, pollMs: 5, now, sleep: () => {}, log: (line) => log.push(line) },
      () => {},
    )).toThrow(/PRE_PUSH_HOST_LOCK_TIMEOUT/);
    expect(log).toHaveLength(1);
    expect(log[0]).toContain(`waiting for the full-tier host lock held by PID ${process.pid}`);
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

  it.each(["EPERM", "EEXIST", "ENOTEMPTY"])("waits for an occupied full lock after publish rename returns %s", (errno) => {
    const report = publicationProbe(lockDirectory(), "full", errno);
    expect(report).toMatchObject({ ran: 0, ownerPreserved: true, remaining: ["ave-prepush-full.lock"] });
    expect(report.error).toContain("PRE_PUSH_HOST_LOCK_TIMEOUT");
    expect(report.logs[0]).toContain(`held by PID ${report.pid}`);
    expect(report.denied).toBeGreaterThan(1);
  });

  it.each(["EPERM", "EEXIST", "ENOTEMPTY"])("tries the next fast slot after occupied-slot publication returns %s", (errno) => {
    const report = publicationProbe(lockDirectory(), "pool", errno);
    expect(report).toMatchObject({
      ran: 1, denied: 1, error: null, ownerPreserved: true,
      during: ["ave-prepush-fast-0.lock", "ave-prepush-fast-1.lock"], remaining: ["ave-prepush-fast-0.lock"],
    });
  });

  it.each(["EPERM", "EEXIST", "ENOTEMPTY"])("inspects and reclaims an empty destination after publication returns %s", (errno) => {
    const report = publicationProbe(lockDirectory(), "empty", errno);
    expect(report).toMatchObject({ ran: 1, denied: 1, error: null, remaining: [] });
  });

  it.each(["EPERM", "EEXIST", "ENOTEMPTY"])("does not treat a private owner-write %s as publication contention", (errno) => {
    const report = publicationProbe(lockDirectory(), "write", errno);
    expect(report).toMatchObject({ ran: 0, denied: 0, code: errno, ownerPreserved: true, remaining: ["ave-prepush-full.lock"] });
    expect(report.error).toBe(`initialization ${errno}`);
  });

  it.each(["EPERM", "EEXIST", "ENOTEMPTY"])("retries %s when the destination vanished before owner inspection", (errno) => {
    const report = publicationProbe(lockDirectory(), "vanished", errno);
    expect(report).toMatchObject({ ran: 1, denied: 1, error: null, remaining: [] });
  });

  it.each(["EPERM", "EEXIST", "ENOTEMPTY"])("times out without running checks when %s persists with no destination", (errno) => {
    const report = publicationProbe(lockDirectory(), "absent", errno);
    expect(report).toMatchObject({ ran: 0, ownerPreserved: false, remaining: [] });
    expect(report.error).toContain("PRE_PUSH_HOST_LOCK_TIMEOUT");
    expect(report.logs[0]).toContain("unknown PID");
    expect(report.denied).toBeGreaterThan(3);
  });

  it("propagates publication errors outside the contention errno set", () => {
    const report = publicationProbe(lockDirectory(), "full", "EIO");
    expect(report).toMatchObject({ ran: 0, denied: 1, code: "EIO", ownerPreserved: true, remaining: ["ave-prepush-full.lock"] });
    expect(report.error).toBe("publication EIO");
  });

  it("publishes only complete ownership and preserves a live winner when a paused creator resumes", async () => {
    const directory = lockDirectory();
    const lock = join(directory, "ave-prepush-full.lock");
    const first = holder(directory, "full", undefined, { operation: "mkdirSync", pathPrefix: lock, after: true });
    let second: ReturnType<typeof holder> | undefined;
    try {
      await waitFor(first.paused, "the paused creator");
      expect(first.pausedPath()).toContain(".pending-");
      expect(existsSync(lock)).toBe(false);
      const old = new Date(Date.now() - 60_000);
      utimesSync(first.pausedPath(), old, old);
      second = holder(directory, "full");
      await waitFor(second.held, "the winner while initialization is paused");
      const winner = readdirSync(lock);
      expect(winner).toHaveLength(1);
      expect(JSON.parse(readFileSync(join(lock, winner[0]!), "utf8")).pid).toBe(second.pid);
      first.resume();
      await waitFor(() => first.output().includes("waiting for the full host lock"), "the resumed creator to wait");
      expect(first.held()).toBe(false);
      expect(readdirSync(lock)).toEqual(winner);
      expect(() => withHostLock({ name: "full", label: "full", directory, timeoutMs: 100, pollMs: 25, log: () => {} }, () => {
        throw new Error("checks overlapped");
      })).toThrow("PRE_PUSH_HOST_LOCK_TIMEOUT");
      second.release();
      expect(await second.exited).toBe(0);
      await waitFor(first.held, "the original creator after the winner releases");
      first.release();
      expect(await first.exited).toBe(0);
      expect(readdirSync(directory).some((name) => name.includes(".pending-") || name.endsWith(".lock"))).toBe(false);
    } finally {
      first.kill();
      second?.kill();
      await Promise.all([first.exited, second?.exited]);
    }
  }, 30_000);

  it("cleans only private initialization after an owner write fails while another process holds the lock", async () => {
    const directory = lockDirectory();
    const lock = join(directory, "ave-prepush-full.lock");
    const first = holder(directory, "full", undefined, { operation: "writeFileSync", pathPrefix: `${lock}.pending-`, fail: true });
    let second: ReturnType<typeof holder> | undefined;
    try {
      await waitFor(first.paused, "the paused owner write");
      second = holder(directory, "full");
      await waitFor(second.held, "the initialized holder");
      const winner = readdirSync(lock);
      first.resume();
      expect(await first.exited).toBe(1);
      expect(first.output()).toContain("owner write failed");
      expect(readdirSync(lock)).toEqual(winner);
      expect(JSON.parse(readFileSync(join(lock, winner[0]!), "utf8")).pid).toBe(second.pid);
      second.release();
      expect(await second.exited).toBe(0);
    } finally {
      first.kill();
      second?.kill();
      await Promise.all([first.exited, second?.exited]);
    }
  }, 30_000);

  it.each([false, true])("competing reapers preserve a replacement when paused after unlink=%s", async (after) => {
    const directory = lockDirectory();
    const lock = join(directory, "ave-prepush-full.lock");
    mkdirSync(lock);
    const staleOwner = join(lock, "owner-dead-owner.json");
    writeFileSync(staleOwner, JSON.stringify({ pid: deadPid(), token: "dead-owner" }));
    const first = holder(directory, "full", undefined, { operation: "unlinkSync", pathPrefix: staleOwner, after });
    let second: ReturnType<typeof holder> | undefined;
    try {
      await waitFor(first.paused, "the first reaper's removal boundary");
      second = holder(directory, "full");
      await waitFor(second.held, "the competing reaper's live replacement");
      const winner = readdirSync(lock);
      first.resume();
      await waitFor(() => first.output().includes("waiting for the full host lock"), "the delayed reaper to wait");
      expect(first.held()).toBe(false);
      expect(readdirSync(lock)).toEqual(winner);
      expect(JSON.parse(readFileSync(join(lock, winner[0]!), "utf8")).pid).toBe(second.pid);
      second.release();
      expect(await second.exited).toBe(0);
      await waitFor(first.held, "the delayed reaper after release");
      first.release();
      expect(await first.exited).toBe(0);
      expect(existsSync(lock)).toBe(false);
    } finally {
      first.kill();
      second?.kill();
      await Promise.all([first.exited, second?.exited]);
    }
  }, 30_000);

  it.each([1, 4])("shares the indexed first fast slot when the holder has %s slots", async (slots) => {
    const directory = lockDirectory();
    const first = holder(directory, "fast", slots);
    try {
      await waitFor(first.held, "the first fast slot");
      expect(existsSync(join(directory, "ave-prepush-fast-0.lock"))).toBe(true);
      expect(existsSync(join(directory, "ave-prepush-fast.lock"))).toBe(false);
      let ran = false;
      expect(() => withHostLock({ name: "fast", label: "fast", directory, slots: 1, timeoutMs: 100, pollMs: 25, log: () => {} }, () => {
        ran = true;
      })).toThrow("PRE_PUSH_HOST_LOCK_TIMEOUT");
      expect(ran).toBe(false);
      if (slots === 1) {
        withHostLock({ name: "fast", label: "fast", directory, slots: 4, timeoutMs: 100 }, () => {
          expect(existsSync(join(directory, "ave-prepush-fast-1.lock"))).toBe(true);
        });
      }
      first.release();
      expect(await first.exited).toBe(0);
    } finally {
      first.kill();
      await first.exited;
    }
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
