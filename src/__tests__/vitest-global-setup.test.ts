/**
 * The run directories `vitest.globalSetup.ts` makes under `~/.ave/test-tmp`
 * are removed on every path: at teardown, when setup fails before it can
 * return one, and on a later run when a killed run left them behind.
 *
 * HOME is a scratch directory throughout, so `~/.ave/test-tmp` here is a
 * scratch one too.
 */
import { existsSync, mkdirSync, readdirSync, symlinkSync, utimesSync } from "node:fs";
import { homedir } from "node:os";
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

import { STALE_RUN_DIR_AGE_MS, sweepStaleRunDirs } from "./support/test-run-dirs.js";
import { removeLinkOnly } from "./support/tmp-dir-teardown.js";
import { useTempDirs } from "./test-helpers.js";
import { setup } from "../../vitest.globalSetup.js";

const RUN_ENV = ["HOME", "USERPROFILE", "AVE_HOME", "AVE_TEST_RUN_HOME", "AVE_TEST_SANDBOX_BASE"] as const;
const savedEnv = Object.fromEntries(RUN_ENV.map((name) => [name, process.env[name]]));
const scratch = useTempDirs("vitest-setup-");
const links: string[] = [];

afterEach(() => {
  failSweep.next = false;
  for (const link of links.splice(0)) removeLinkOnly(link);
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

describe("vitest global setup", () => {
  it("makes one set of run directories for every project in the run and removes it after the last", async () => {
    const testTmp = scratchTestTmp();
    const teardownNode = await setup(project());
    const teardownJsdom = await setup(project());
    expect(runDirs(testTmp)).toHaveLength(2);
    expect(process.env.AVE_HOME).toBe(process.env.AVE_TEST_RUN_HOME);
    expect(process.env.AVE_TEST_RUN_HOME!.startsWith(join(testTmp, "h-"))).toBe(true);

    await teardownNode();
    expect(runDirs(testTmp)).toHaveLength(2);
    await teardownJsdom();
    expect(runDirs(testTmp)).toEqual([]);
  });

  it("removes what a killed run left long ago before making its own", async () => {
    const testTmp = scratchTestTmp();
    mkdirSync(testTmp, { recursive: true });
    const stale = join(testTmp, "h-Kill01");
    mkdirSync(join(stale, "f-Kill01"), { recursive: true });
    const when = new Date(Date.now() - STALE_RUN_DIR_AGE_MS - 60_000);
    utimesSync(stale, when, when);
    const teardown = await setup(project());
    expect(existsSync(stale)).toBe(false);
    await teardown();
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
  const old = (path: string) => {
    const when = new Date(Date.now() - STALE_RUN_DIR_AGE_MS - 60_000);
    utimesSync(path, when, when);
    return path;
  };

  it("removes run directories a killed run left long ago, and nothing else", async () => {
    const testTmp = scratch();
    const staleHome = old(mkdirAt(join(testTmp, "h-AbC123")));
    const staleSandbox = old(mkdirAt(join(testTmp, "sbx-XyZ789")));
    const live = mkdirAt(join(testTmp, "h-Live01"));
    const otherName = old(mkdirAt(join(testTmp, "plugin-fixture-AbC123")));
    const target = old(mkdirAt(join(scratch(), "target")));
    const linked = join(testTmp, "h-Link01");
    symlinkSync(target, linked, "junction");
    links.push(linked);

    const removed: string[] = [];
    const result = await sweepStaleRunDirs(testTmp, async (path) => {
      removed.push(path);
      await import("node:fs/promises").then(({ rm }) => rm(path, { recursive: true }));
    });

    expect(result.sort()).toEqual([staleHome, staleSandbox].sort());
    expect(removed.sort()).toEqual([staleHome, staleSandbox].sort());
    for (const kept of [live, otherName, target]) expect(existsSync(kept), kept).toBe(true);
  });

  it("passes over a directory another run removed first", async () => {
    const testTmp = scratch();
    old(mkdirAt(join(testTmp, "h-Gone01")));
    const result = await sweepStaleRunDirs(testTmp, async () => {
      throw Object.assign(new Error("gone"), { code: "ENOENT" });
    });
    expect(result).toEqual([]);
  });
});

function mkdirAt(path: string): string {
  mkdirSync(path);
  return path;
}
