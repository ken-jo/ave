/**
 * The run directories `vitest.globalSetup.ts` makes under `~/.ave/test-tmp`
 * are removed on every path: at teardown, when setup fails before it can
 * return one, and on a later run when a killed run left them behind — and
 * never while the run that made them lives, nor outside `test-tmp`.
 *
 * HOME is a scratch directory throughout, so `~/.ave/test-tmp` here is a
 * scratch one too.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import type { TestProject } from "vitest/node";
import { afterEach, describe, expect, it, vi } from "vitest";

const failSweep = vi.hoisted(() => ({ next: false }));
vi.mock("./support/test-run-dirs.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./support/test-run-dirs.js")>();
  return {
    ...actual,
    sweepStaleRunDirs: vi.fn(async (...args: Parameters<typeof actual.sweepStaleRunDirs>) => {
      if (failSweep.next) throw new Error("injected setup failure");
      return actual.sweepStaleRunDirs(...args);
    }),
  };
});

import {
  ensureTestTmpRoot,
  RUN_OWNER_FILE,
  STALE_RUN_DIR_AGE_MS,
  sweepStaleRunDirs,
  systemProcessProbe,
  type ProcessProbe,
  type RunOwner,
} from "./support/test-run-dirs.js";
import { useScratchLinks, useTempDirs } from "./test-helpers.js";
import { setup } from "../../vitest.globalSetup.js";

const RUN_ENV = ["HOME", "USERPROFILE", "AVE_HOME", "AVE_TEST_RUN_HOME", "AVE_TEST_SANDBOX_BASE"] as const;
const savedEnv = Object.fromEntries(RUN_ENV.map((name) => [name, process.env[name]]));
const scratch = useTempDirs("vitest-setup-");
const link = useScratchLinks();

afterEach(() => {
  failSweep.next = false;
  for (const name of RUN_ENV) {
    const value = savedEnv[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

/** HOME for this test, so setup's `~/.ave/test-tmp` is a scratch one. */
function scratchTestTmp(): string {
  const home = scratch();
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  expect(homedir()).toBe(home);
  return join(home, ".ave", "test-tmp");
}

function project(isolate = true, pool = "forks"): TestProject {
  return { name: "node", config: { isolate, pool } } as unknown as TestProject;
}

function runDirs(testTmp: string): string[] {
  return existsSync(testTmp) ? readdirSync(testTmp).filter((name) => /^(?:h|sbx)-/.test(name)) : [];
}

const DAY_AGO = () => new Date(Date.now() - STALE_RUN_DIR_AGE_MS - 60_000);

/** A run directory as a run makes it: named so, owned, and last touched long ago. */
function runDir(path: string, owner: RunOwner | null, when: Date = DAY_AGO()): string {
  mkdirSync(path, { recursive: true });
  if (owner !== null) writeFileSync(join(path, RUN_OWNER_FILE), JSON.stringify(owner));
  utimesSync(path, when, when);
  return path;
}

/** A pid no process has: a child that has already exited. */
function exitedPid(): number {
  const node = process.env.AVE_TEST_NODE_EXEC_PATH ?? process.execPath;
  const child = spawnSync(node, ["-e", "process.stdout.write(String(process.pid))"], {
    encoding: "utf8",
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  });
  expect(child.status, child.stderr).toBe(0);
  const pid = Number(child.stdout);
  expect(systemProcessProbe.exists(pid)).toBe(false);
  return pid;
}

describe("vitest global setup", () => {
  it("makes one set of owned run directories for every project in the run and removes it after the last", async () => {
    const testTmp = scratchTestTmp();
    const teardownNode = await setup(project());
    const teardownJsdom = await setup(project());
    expect(runDirs(testTmp)).toHaveLength(2);
    expect(process.env.AVE_HOME).toBe(process.env.AVE_TEST_RUN_HOME);
    expect(process.env.AVE_TEST_RUN_HOME!.startsWith(join(testTmp, "h-"))).toBe(true);
    for (const name of runDirs(testTmp)) {
      const owner = JSON.parse(readFileSync(join(testTmp, name, RUN_OWNER_FILE), "utf8")) as RunOwner;
      expect(owner).toMatchObject({ pid: process.pid, host: hostname() });
    }

    await teardownNode();
    expect(runDirs(testTmp)).toHaveLength(2);
    await teardownJsdom();
    expect(runDirs(testTmp)).toEqual([]);
  });

  it("removes what a killed run left long ago before making its own, and keeps a live run's", async () => {
    const testTmp = scratchTestTmp();
    const killed = runDir(join(testTmp, "h-Kill01"), { pid: exitedPid(), host: hostname() });
    mkdirSync(join(killed, "f-Kill01"));
    utimesSync(killed, DAY_AGO(), DAY_AGO());
    const live = runDir(join(testTmp, "h-Live01"), {
      pid: process.pid,
      host: hostname(),
      started: systemProcessProbe.startedAt(process.pid),
    });
    const teardown = await setup(project());
    expect(existsSync(killed)).toBe(false);
    expect(existsSync(live)).toBe(true);
    await teardown();
  });

  it("refuses a test-tmp that is a link, before making or removing anything", async () => {
    const testTmp = scratchTestTmp();
    const elsewhere = scratch();
    const sentinel = runDir(join(elsewhere, "h-Else01"), { pid: exitedPid(), host: hostname() });
    mkdirSync(join(testTmp, ".."), { recursive: true });
    link(elsewhere, testTmp);
    await expect(setup(project())).rejects.toThrow(/refusing .* as the tests' scratch root: it is not a real directory/);
    expect(existsSync(sentinel)).toBe(true);
    expect(runDirs(elsewhere)).toEqual(["h-Else01"]);
  });

  it("removes its run directories when setup fails before returning a teardown", async () => {
    const testTmp = scratchTestTmp();
    failSweep.next = true;
    await expect(setup(project())).rejects.toThrow("injected setup failure");
    expect(runDirs(testTmp)).toEqual([]);
  });

  it("refuses isolate: false before making anything, and allows it for a vm pool", async () => {
    const testTmp = scratchTestTmp();
    await expect(setup(project(false))).rejects.toThrow(/isolate: false shares modules between test files/);
    expect(runDirs(testTmp)).toEqual([]);
    const teardown = await setup(project(false, "vmThreads"));
    await teardown();
  });
});

describe("sweepStaleRunDirs", () => {
  const host = "this-host";
  /** Pid 100 started at "t0" and lives; every other pid is gone. */
  const probe: ProcessProbe = {
    exists: (pid) => pid === 100,
    startedAt: (pid) => (pid === 100 ? "t0" : undefined),
    host: () => host,
  };
  const sweep = (testTmp: string, extra: { now?: number } = {}) =>
    sweepStaleRunDirs(testTmp, async (path) => {
      const { rm } = await import("node:fs/promises");
      await rm(path, { recursive: true });
    }, { probe, ...extra });

  it("removes an old run directory whose owner is gone, or whose pid now names another process", async () => {
    const testTmp = scratch();
    const gone = runDir(join(testTmp, "h-Gone01"), { pid: 200, host, started: "t1" });
    const reused = runDir(join(testTmp, "sbx-Reus01"), { pid: 100, host, started: "t-earlier" });
    expect((await sweep(testTmp)).sort()).toEqual([gone, reused].sort());
  });

  it("keeps a live run's directory however old its timestamp, even with fresh writes deep inside", async () => {
    const testTmp = scratch();
    const live = runDir(join(testTmp, "h-Live01"), { pid: 100, host, started: "t0" });
    mkdirSync(join(live, "f-Deep01", "audit"), { recursive: true });
    writeFileSync(join(live, "f-Deep01", "audit", "today.jsonl"), "{}\n");
    utimesSync(live, DAY_AGO(), DAY_AGO());
    expect(await sweep(testTmp)).toEqual([]);
    expect(existsSync(live)).toBe(true);
  });

  it("keeps a new directory of a live run when the clock jumps forward", async () => {
    const testTmp = scratch();
    const live = runDir(join(testTmp, "h-Jump01"), { pid: 100, host, started: "t0" }, new Date());
    expect(await sweep(testTmp, { now: Date.now() + 10 * STALE_RUN_DIR_AGE_MS })).toEqual([]);
    expect(existsSync(live)).toBe(true);
  });

  it("keeps what it cannot attribute: no record, a torn record, another host, an unreadable start", async () => {
    const testTmp = scratch();
    const kept = [
      runDir(join(testTmp, "h-NoRec1"), null),
      runDir(join(testTmp, "h-OtherH"), { pid: 200, host: "another-host" }),
      runDir(join(testTmp, "h-NoStrt"), { pid: 100, host }),
    ];
    const torn = runDir(join(testTmp, "h-Torn01"), null);
    writeFileSync(join(torn, RUN_OWNER_FILE), "{\"pid\":");
    utimesSync(torn, DAY_AGO(), DAY_AGO());
    kept.push(torn);
    expect(await sweep(testTmp)).toEqual([]);
    for (const path of kept) expect(existsSync(path), path).toBe(true);
  });

  it("keeps a dead run's directory until it is old, and touches no link or other name", async () => {
    const testTmp = scratch();
    const young = runDir(join(testTmp, "h-Young1"), { pid: 200, host }, new Date());
    const otherName = runDir(join(testTmp, "plugin-fixture-AbC123"), { pid: 200, host });
    const target = runDir(join(scratch(), "target"), { pid: 200, host });
    link(target, join(testTmp, "h-Link01"));
    expect(await sweep(testTmp)).toEqual([]);
    for (const path of [young, otherName, target]) expect(existsSync(path), path).toBe(true);
  });

  it("passes over a directory another run removed first", async () => {
    const testTmp = scratch();
    runDir(join(testTmp, "h-Gone01"), { pid: 200, host });
    const result = await sweepStaleRunDirs(testTmp, async () => {
      throw Object.assign(new Error("gone"), { code: "ENOENT" });
    }, { probe });
    expect(result).toEqual([]);
  });

  it("reads this process's start the same way twice, so a live owner matches itself", () => {
    const started = systemProcessProbe.startedAt(process.pid);
    expect(started).toBeDefined();
    expect(systemProcessProbe.startedAt(process.pid)).toBe(started);
  });
});

describe("ensureTestTmpRoot", () => {
  it("accepts a real directory and refuses a link standing in for it", () => {
    const parent = scratch();
    ensureTestTmpRoot(join(parent, "test-tmp"), (path) => mkdirSync(path, { recursive: true }));
    const linked = link(scratch(), join(scratch(), "test-tmp"));
    expect(() => ensureTestTmpRoot(linked, (path) => mkdirSync(path, { recursive: true })))
      .toThrow(/not a real directory/);
  });
});
