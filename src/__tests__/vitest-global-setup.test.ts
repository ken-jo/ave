vi.mock("../shared/windows-path-facts.js", async original => (await import("../__tests__/support/simulated-win32-drive.js")).simulatedWindowsPathFacts(await original()));
vi.mock("../shared/windows-configuration-handles.js", async original => (await import("../__tests__/support/simulated-win32-drive.js")).simulatedConfigurationHandles(await original()));
vi.mock("node:fs", async original => (await import("../__tests__/support/simulated-win32-drive.js")).simulatedConfigurationFs(await original()));

/** Use scratch HOME and verify run cleanup never removes live owners or escapes test-tmp. */
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { homedir, hostname, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { TestProject } from "vitest/node";
import { afterEach, describe, expect, it, vi } from "vitest";

const failSweep = vi.hoisted(() => ({ next: false }));
const refuseRunTmpRoot = vi.hoisted(() => ({ next: false }));
vi.mock("./support/test-run-dirs.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./support/test-run-dirs.js")>();
  return {
    ...actual,
    ensureRunTmpRoot: vi.fn((root: string) => {
      if (refuseRunTmpRoot.next) throw new Error(`refusing ${root} as the tests' temp root: injected`);
      actual.ensureRunTmpRoot(root);
    }),
    sweepStaleRunDirs: vi.fn(async (...args: Parameters<typeof actual.sweepStaleRunDirs>) => {
      if (failSweep.next) throw new Error("injected setup failure");
      return actual.sweepStaleRunDirs(...args);
    }),
  };
});

import {
  ensureRunTmpRoot,
  ensureTestTmpRoot,
  parsePsLstartUtc,
  RUN_OWNER_FILE,
  RUN_OWNER_VERSION,
  runTmpRoot,
  STALE_RUN_DIR_AGE_MS,
  sweepStaleRunDirs,
  systemProcessProbe,
  validRunOwner,
  type ProcessProbe,
  type RunOwner,
} from "./support/test-run-dirs.js";
import { removeLinksUnder } from "./support/tmp-dir-teardown.js";
import { useScratchLinks, useTempDirs } from "./test-helpers.js";
import { setup } from "../../config/vitest.globalSetup.js";

const RUN_ENV = [
  "HOME", "USERPROFILE", "AVE_HOME", "AVE_TEST_RUN_HOME", "AVE_TEST_SANDBOX_BASE", "TZ", "LC_ALL", "LANG",
  "TMPDIR", "TEMP", "TMP",
  "ProgramData", "PROGRAMDATA", "ALLUSERSPROFILE",
] as const;
const savedEnv = Object.fromEntries(RUN_ENV.map((name) => [name, process.env[name]]));
const scratch = useTempDirs("vitest-setup-");
const link = useScratchLinks();

afterEach(() => {
  failSweep.next = false;
  refuseRunTmpRoot.next = false;
  for (const name of RUN_ENV) {
    const value = savedEnv[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

function scratchTestTmp(): string {
  const home = scratch();
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  expect(homedir()).toBe(home);
  return join(home, ".ave", "test-tmp");
}

type Provided = Map<string, unknown>;

function project(isolate = true, pool = "forks", provided: Provided = new Map()): TestProject {
  return {
    name: "node",
    config: { isolate, pool },
    provide: (key: string, value: unknown) => { provided.set(key, value); },
  } as unknown as TestProject;
}

function runDirs(testTmp: string): string[] {
  return existsSync(testTmp) ? readdirSync(testTmp).filter((name) => /^(?:h|sbx|t)-/.test(name)) : [];
}

const DAY_AGO = () => new Date(Date.now() - STALE_RUN_DIR_AGE_MS - 60_000);

function runDir(path: string, record: RunOwner | Record<string, unknown> | string | null, when: Date = DAY_AGO()): string {
  mkdirSync(path, { recursive: true });
  if (record !== null) {
    writeFileSync(join(path, RUN_OWNER_FILE), typeof record === "string" ? record : JSON.stringify(record));
  }
  utimesSync(path, when, when);
  return path;
}

function owner(pid: number, started: string, host: string = hostname()): RunOwner {
  return { version: RUN_OWNER_VERSION, pid, started, host };
}

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

function ownStart(): string {
  const started = systemProcessProbe.startedAt(process.pid);
  expect(started).toBeDefined();
  return started!;
}

const removeTree = async (path: string) => {
  const { rm } = await import("node:fs/promises");
  await rm(path, { recursive: true });
};

describe("vitest global setup", () => {
  it("makes one set of owned run directories for every project in the run and removes it after the last", async () => {
    const testTmp = scratchTestTmp();
    const nodeProvided: Provided = new Map();
    const jsdomProvided: Provided = new Map();
    const teardownNode = await setup(project(true, "forks", nodeProvided));
    const teardownJsdom = await setup(project(true, "forks", jsdomProvided));
    expect(runDirs(testTmp)).toHaveLength(2);
    const runTmp = tmpdir();
    expect(dirname(runTmp)).toBe(runTmpRoot());
    expect(validRunOwner(JSON.parse(readFileSync(join(runTmp, RUN_OWNER_FILE), "utf8")) as unknown))
      .toEqual(owner(process.pid, ownStart()));
    const childEntry = nodeProvided.get("pluginChildEntryPath");
    expect(typeof childEntry).toBe("string");
    expect(existsSync(childEntry as string)).toBe(true);
    expect(jsdomProvided.get("pluginChildEntryPath")).toBe(childEntry);
    expect(jsdomProvided.get("realProgramData")).toBe(nodeProvided.get("realProgramData"));
    expect(nodeProvided.get("realAccountHome")).toBeTypeOf("string");
    expect(jsdomProvided.get("realAccountHome")).toBe(nodeProvided.get("realAccountHome"));
    expect(process.env.AVE_HOME).toBe(process.env.AVE_TEST_RUN_HOME);
    expect(process.env.AVE_TEST_RUN_HOME!.startsWith(join(testTmp, "h-"))).toBe(true);
    for (const name of runDirs(testTmp)) {
      const record = JSON.parse(readFileSync(join(testTmp, name, RUN_OWNER_FILE), "utf8")) as unknown;
      expect(validRunOwner(record)).toEqual(owner(process.pid, ownStart()));
    }

    await teardownNode();
    expect(runDirs(testTmp)).toHaveLength(2);
    expect(existsSync(runTmp)).toBe(true);
    expect(existsSync(childEntry as string)).toBe(true);
    await teardownJsdom();
    expect(runDirs(testTmp)).toEqual([]);
    expect(existsSync(runTmp)).toBe(false);
    expect(existsSync(childEntry as string)).toBe(false);
  });

  it("gives the run its own temp directory, and at teardown names what the tests left in it and removes it", async () => {
    scratchTestTmp();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const teardown = await setup(project());
      const runTmp = tmpdir();
      expect(dirname(runTmp)).toBe(runTmpRoot());
      expect(basename(runTmp)).toMatch(/^t-/);
      mkdtempSync(join(tmpdir(), "leaky-"));
      mkdtempSync(join(tmpdir(), "leaky-"));
      writeFileSync(join(tmpdir(), "notes.txt"), "");
      await teardown();
      expect(existsSync(runTmp)).toBe(false);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("left these in the temp directory"));
      expect(warn.mock.calls.flat().join("\n")).toContain(": leaky-* x2, notes.txt");
    } finally {
      warn.mockRestore();
    }
  });

  it("removes a link the tests left in the temp directory, never what it points to", async () => {
    scratchTestTmp();
    const target = scratch();
    writeFileSync(join(target, "keep.txt"), "kept");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const teardown = await setup(project());
      const runTmp = tmpdir();
      const nested = mkdtempSync(join(runTmp, "linked-"));
      symlinkSync(target, join(runTmp, "top-link"), "junction");
      symlinkSync(target, join(nested, "deep-link"), "junction");
      await teardown();
      expect(existsSync(runTmp)).toBe(false);
      expect(readFileSync(join(target, "keep.txt"), "utf8")).toBe("kept");
    } finally {
      warn.mockRestore();
    }
  });

  it("takes out every link under a run directory before the tree, at any depth, and only the links", () => {
    const target = scratch();
    writeFileSync(join(target, "keep.txt"), "kept");
    const runTmp = scratch();
    mkdirSync(join(runTmp, "real", "deeper"), { recursive: true });
    symlinkSync(target, join(runTmp, "top-link"), "junction");
    symlinkSync(target, join(runTmp, "real", "deeper", "deep-link"), "junction");
    removeLinksUnder(runTmp);
    expect(readdirSync(runTmp)).toEqual(["real"]);
    expect(readdirSync(join(runTmp, "real", "deeper"))).toEqual([]);
    expect(readFileSync(join(target, "keep.txt"), "utf8")).toBe("kept");
  });

  it("says nothing about the temp directory when the tests left it empty", async () => {
    scratchTestTmp();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const teardown = await setup(project());
      const runTmp = tmpdir();
      await teardown();
      expect(existsSync(runTmp)).toBe(false);
      expect(warn.mock.calls.flat().join("\n")).not.toContain("temp directory");
    } finally {
      warn.mockRestore();
    }
  });

  it("removes what a killed run left long ago before making its own, and keeps a live run's", async () => {
    const testTmp = scratchTestTmp();
    const killed = runDir(join(testTmp, "h-Kill01"), owner(exitedPid(), "ps:1"));
    mkdirSync(join(killed, "f-Kill01"));
    utimesSync(killed, DAY_AGO(), DAY_AGO());
    const live = runDir(join(testTmp, "h-Live01"), owner(process.pid, ownStart()));
    const teardown = await setup(project());
    expect(existsSync(killed)).toBe(false);
    expect(existsSync(live)).toBe(true);
    await teardown();
  });

  it("is not stopped by an owner record it cannot read, and keeps that directory", async () => {
    const testTmp = scratchTestTmp();
    const kept = [
      runDir(join(testTmp, "h-Null01"), "null"),
      runDir(join(testTmp, "h-Arr001"), "[]"),
      runDir(join(testTmp, "h-Torn01"), "{\"version\":2,"),
    ];
    const teardown = await setup(project());
    for (const path of kept) expect(existsSync(path), path).toBe(true);
    await teardown();
  });

  it("names in its warning every directory it left aside unremoved", async () => {
    const testTmp = scratchTestTmp();
    const unattributed = runDir(join(testTmp, `.del-${randomUUID()}`), "null");
    const warnings: string[] = [];
    const warn = vi.spyOn(console, "warn").mockImplementation((message: unknown) => {
      warnings.push(String(message));
    });
    const teardown = await setup(project()).finally(() => warn.mockRestore());
    try {
      expect(existsSync(unattributed)).toBe(true);
      expect(warnings.some((message) => message.includes(unattributed))).toBe(true);
    } finally {
      await teardown();
    }
  });

  it("refuses a test-tmp that is a link, before making or removing anything", async () => {
    const testTmp = scratchTestTmp();
    const elsewhere = scratch();
    const sentinel = runDir(join(elsewhere, "h-Else01"), owner(exitedPid(), "ps:1"));
    mkdirSync(join(testTmp, ".."), { recursive: true });
    link(elsewhere, testTmp);
    await expect(setup(project())).rejects.toThrow(/refusing .* as the tests' scratch root: it is not a real directory/);
    expect(existsSync(sentinel)).toBe(true);
    expect(runDirs(elsewhere)).toEqual(["h-Else01"]);
  });

  it("makes no run directory when it refuses the temp root", async () => {
    const testTmp = scratchTestTmp();
    refuseRunTmpRoot.next = true;
    await expect(setup(project())).rejects.toThrow(/refusing .* as the tests' temp root/);
    expect(runDirs(testTmp)).toEqual([]);
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

describe("a process's start identity", () => {
  it("is the same under any time zone and locale the reading process has", async () => {
    process.env.TZ = "UTC";
    process.env.LC_ALL = "C";
    process.env.LANG = "C";
    const recorded = ownStart();
    const testTmp = scratch();
    const live = runDir(join(testTmp, "h-Envr01"), owner(process.pid, recorded));
    for (const [tz, locale] of [["Asia/Seoul", "fr_FR.UTF-8"], ["America/New_York", "de_DE.UTF-8"], ["Pacific/Kiritimati", "ko_KR.UTF-8"]]) {
      process.env.TZ = tz;
      process.env.LC_ALL = locale;
      process.env.LANG = locale;
      expect(systemProcessProbe.startedAt(process.pid), `${tz} ${locale}`).toBe(recorded);
      expect((await sweepStaleRunDirs(testTmp, removeTree)).removed).toEqual([]);
      expect(existsSync(live)).toBe(true);
    }
  });

  it("reads ps start text in the C locale and UTC as seconds since the epoch, and nothing else", () => {
    expect(parsePsLstartUtc("Thu Oct  2 04:29:05 2026")).toBe(Date.UTC(2026, 9, 2, 4, 29, 5) / 1000);
    expect(parsePsLstartUtc("Mon Feb 29 23:59:59 2028\n")).toBe(Date.UTC(2028, 1, 29, 23, 59, 59) / 1000);
    expect(parsePsLstartUtc("Thu Jan  1 00:00:00 1970")).toBe(0);
    for (const text of [
      "",
      "jeu  2 oct 04:29:05 2026",
      "Thu Oct  2 04:29:05 KST 2026",
      "Mon Feb 30 01:00:00 2026",
      "Thu Oct  2 24:00:00 2026",
      "Thu Okt  2 04:29:05 2026",
      "Wed Dec 31 23:59:59 1969",
      "Fri Jan  1 00:00:00 0050",
      "Sat Jan  1 00:00:00 0000",
    ]) {
      expect(parsePsLstartUtc(text), text).toBeUndefined();
    }
  });
});

describe("validRunOwner", () => {
  const good = owner(4242, "ps:1790000000", "this-host");

  it("accepts a record of this version with every field well formed", () => {
    expect(validRunOwner(good)).toEqual(good);
    expect(validRunOwner(owner(1, "linux:0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0:123456"))).toBeDefined();
    expect(validRunOwner(owner(1, "win32:133700000000000000"))).toBeDefined();
  });

  it("rejects anything else", () => {
    const { version: _version, ...unversioned } = good;
    for (const [label, value] of [
      ["null", null],
      ["an array", [good]],
      ["a number", 4242],
      ["a string", "4242"],
      ["a class instance", Object.assign(new Date(0), good)],
      ["a string pid", { ...good, pid: "4242" }],
      ["a fractional pid", { ...good, pid: 42.5 }],
      ["a zero pid", { ...good, pid: 0 }],
      ["a negative pid", { ...good, pid: -1 }],
      ["an unsafe pid", { ...good, pid: 2 ** 60 }],
      ["an empty host", { ...good, host: "" }],
      ["a number host", { ...good, host: 7 }],
      ["an empty start", { ...good, started: "" }],
      ["a raw ps start", { ...good, started: "Thu Oct  2 04:29:05 2026" }],
      ["a start of no known form", { ...good, started: "ps:12a" }],
      ["no start", { ...good, started: undefined }],
      ["no version", unversioned],
      ["another version", { ...good, version: 1 }],
      ["a future version", { ...good, version: 3 }],
      ["a string version", { ...good, version: "2" }],
    ] as const) {
      expect(validRunOwner(value), label).toBeUndefined();
    }
  });
});

describe("sweepStaleRunDirs", () => {
  const host = "this-host";
  const probe: ProcessProbe = {
    exists: (pid) => pid === 100,
    startedAt: (pid) => (pid === 100 ? "ps:1000" : undefined),
    host: () => host,
  };
  const sweep = (testTmp: string, extra: { now?: number; onStep?: (step: "judged" | "taken-aside", path: string) => void } = {}) =>
    sweepStaleRunDirs(testTmp, removeTree, { probe, ...extra });

  it("removes an old run directory whose owner is gone, or whose pid now names another process", async () => {
    const testTmp = scratch();
    const gone = runDir(join(testTmp, "h-Gone01"), owner(200, "ps:900", host));
    const reused = runDir(join(testTmp, "sbx-Reus01"), owner(100, "ps:10", host));
    const result = await sweep(testTmp);
    expect(result.removed.sort()).toEqual([gone, reused].sort());
    expect(result.stranded).toEqual([]);
    expect(readdirSync(testTmp)).toEqual([]);
  });

  it("keeps a live run's directory however old its timestamp, even with fresh writes deep inside", async () => {
    const testTmp = scratch();
    const live = runDir(join(testTmp, "h-Live01"), owner(100, "ps:1000", host));
    mkdirSync(join(live, "f-Deep01", "audit"), { recursive: true });
    writeFileSync(join(live, "f-Deep01", "audit", "today.jsonl"), "{}\n");
    utimesSync(live, DAY_AGO(), DAY_AGO());
    expect((await sweep(testTmp)).removed).toEqual([]);
    expect(existsSync(live)).toBe(true);
  });

  it("keeps a new directory of a live run when the clock jumps forward", async () => {
    const testTmp = scratch();
    const live = runDir(join(testTmp, "h-Jump01"), owner(100, "ps:1000", host), new Date());
    expect((await sweep(testTmp, { now: Date.now() + 10 * STALE_RUN_DIR_AGE_MS })).removed).toEqual([]);
    expect(existsSync(live)).toBe(true);
  });

  it("keeps what it cannot attribute, whatever the record holds", async () => {
    const testTmp = scratch();
    const { version: _version, ...unversioned } = owner(200, "ps:900", host);
    const kept = [
      runDir(join(testTmp, "h-NoRec1"), null),
      runDir(join(testTmp, "h-Torn01"), "{\"pid\":"),
      runDir(join(testTmp, "h-Null01"), "null"),
      runDir(join(testTmp, "h-Arr001"), "[]"),
      runDir(join(testTmp, "h-Num001"), "200"),
      runDir(join(testTmp, "h-PidStr"), { ...owner(200, "ps:900", host), pid: "200" }),
      runDir(join(testTmp, "h-Empty1"), { ...owner(100, "ps:1000", host), started: "" }),
      runDir(join(testTmp, "h-Raw001"), { ...owner(100, "ps:1000", host), started: "Thu Oct  2 04:29:05 2026" }),
      runDir(join(testTmp, "h-NoVer1"), unversioned),
      runDir(join(testTmp, "h-Ver999"), { ...owner(200, "ps:900", host), version: 999 }),
      runDir(join(testTmp, "h-OtherH"), owner(200, "ps:900", "another-host")),
      runDir(join(testTmp, "h-Form01"), owner(100, "win32:1000", host)),
    ];
    const result = await sweep(testTmp);
    expect(result).toEqual({ removed: [], stranded: [], leftAside: [] });
    for (const path of kept) expect(existsSync(path), path).toBe(true);
  });

  it("keeps a live owner whose start cannot be read now", async () => {
    const testTmp = scratch();
    const live = runDir(join(testTmp, "h-Unrd01"), owner(100, "ps:1000", host));
    const result = await sweepStaleRunDirs(testTmp, removeTree, {
      probe: { ...probe, startedAt: () => undefined },
    });
    expect(result.removed).toEqual([]);
    expect(existsSync(live)).toBe(true);
  });

  it("keeps a dead run's directory until it is old, and touches no link or other name", async () => {
    const testTmp = scratch();
    const young = runDir(join(testTmp, "h-Young1"), owner(200, "ps:900", host), new Date());
    const otherName = runDir(join(testTmp, "plugin-fixture-AbC123"), owner(200, "ps:900", host));
    const target = runDir(join(scratch(), "target"), owner(200, "ps:900", host));
    link(target, join(testTmp, "h-Link01"));
    expect((await sweep(testTmp)).removed).toEqual([]);
    for (const path of [young, otherName, target]) expect(existsSync(path), path).toBe(true);
  });

  it("removes nothing a directory made at the judged name in between, and puts it back", async () => {
    const testTmp = scratch();
    const record = owner(200, "ps:900", host);
    const judged = runDir(join(testTmp, "h-Race01"), record);
    const movedAway = join(scratch(), "judged-elsewhere");
    const result = await sweep(testTmp, {
      onStep: (step, path) => {
        if (step !== "judged") return;
        renameSync(path, movedAway);
        runDir(path, record);
        writeFileSync(join(path, "new-run-data"), "kept");
      },
    });
    expect(result).toEqual({ removed: [], stranded: [], leftAside: [] });
    expect(readFileSync(join(judged, "new-run-data"), "utf8")).toBe("kept");
    expect(existsSync(join(movedAway, RUN_OWNER_FILE))).toBe(true);
    expect(readdirSync(testTmp)).toEqual(["h-Race01"]);
  });

  it("leaves a replaced directory aside and reports it when its name is taken again", async () => {
    const testTmp = scratch();
    const record = owner(200, "ps:900", host);
    const judged = runDir(join(testTmp, "h-Race02"), record);
    const result = await sweep(testTmp, {
      onStep: (step, path) => {
        if (step === "judged") {
          renameSync(path, join(scratch(), "judged-elsewhere"));
          runDir(path, record);
          writeFileSync(join(path, "new-run-data"), "kept");
        } else {
          mkdirSync(path);
        }
      },
    });
    expect(result.removed).toEqual([]);
    expect(result.stranded).toHaveLength(1);
    expect(readFileSync(join(result.stranded[0]!, "new-run-data"), "utf8")).toBe("kept");
    expect(existsSync(judged)).toBe(true);
  });

  it("passes over a directory another sweep took first", async () => {
    const testTmp = scratch();
    runDir(join(testTmp, "h-Gone01"), owner(200, "ps:900", host));
    const result = await sweep(testTmp, {
      onStep: (step, path) => {
        if (step === "judged") renameSync(path, join(testTmp, ".del-other-sweep"));
      },
    });
    expect(result).toEqual({ removed: [], stranded: [], leftAside: [] });
  });

  it("reclaims next time a directory whose removal failed, and reports it meanwhile", async () => {
    const testTmp = scratch();
    runDir(join(testTmp, "h-Fail01"), owner(200, "ps:900", host));
    const failing = await sweepStaleRunDirs(testTmp, async () => {
      throw Object.assign(new Error("busy"), { code: "EBUSY" });
    }, { probe });
    expect(failing.removed).toEqual([]);
    expect(failing.leftAside).toHaveLength(1);
    const aside = failing.leftAside[0]!;
    expect(readdirSync(testTmp)).toEqual([aside.slice(testTmp.length + 1)]);
    expect(aside.slice(testTmp.length + 1)).toMatch(/^\.del-[0-9a-f-]{36}$/);

    const next = await sweep(testTmp);
    expect(next).toEqual({ removed: [aside], stranded: [], leftAside: [] });
    expect(readdirSync(testTmp)).toEqual([]);
  });

  it("keeps and reports a directory left aside whose owner cannot be shown gone", async () => {
    const testTmp = scratch();
    const kept = [
      runDir(join(testTmp, `.del-${randomUUID()}`), null),
      runDir(join(testTmp, `.del-${randomUUID()}`), "null"),
      runDir(join(testTmp, `.del-${randomUUID()}`), owner(100, "ps:1000", host)),
      runDir(join(testTmp, `.del-${randomUUID()}`), owner(200, "ps:900", host), new Date()),
    ];
    const notOurs = runDir(join(testTmp, ".del-not-a-sweep"), owner(200, "ps:900", host));
    const result = await sweep(testTmp);
    expect(result.removed).toEqual([]);
    expect(result.leftAside.sort()).toEqual([...kept].sort());
    for (const path of [...kept, notOurs]) expect(existsSync(path), path).toBe(true);
  });

  it("refuses a test-tmp that became a link before it sweeps", async () => {
    const elsewhere = scratch();
    const sentinel = runDir(join(elsewhere, "h-Else01"), owner(200, "ps:900", host));
    const root = link(elsewhere, join(scratch(), "test-tmp"));
    await expect(sweep(root)).rejects.toThrow(/not a real directory/);
    expect(existsSync(sentinel)).toBe(true);
  });
});

describe("runTmpRoot", () => {
  /** Run temp must be writable within the sandbox's shared temp grant and outside write-denied home floors. */
  it.each(["linux", "darwin", "win32"] as const)("is covered by no %s sandbox write floor", async (platform) => {
    const { getDefaultSensitiveWriteDenyPaths, isGrantPathWithin } = await import("../permissions/asrt-sandbox.js");
    const realPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
    const realGetuid = Object.getOwnPropertyDescriptor(process, "getuid");
    // Platform simulation needs an account identifier even on a host without POSIX APIs.
    if (realGetuid === undefined) Object.defineProperty(process, "getuid", { value: () => 1000, configurable: true });
    Object.defineProperty(process, "platform", { value: platform, configurable: true });
    try {
      const floor = getDefaultSensitiveWriteDenyPaths();
      const inRun = join(runTmpRoot(platform), "t-AbC123", "scratch-file");
      expect(floor.filter((denied) => isGrantPathWithin(denied, inRun))).toEqual([]);
      expect(floor.some((denied) => isGrantPathWithin(denied, join(homedir(), ".ssh", "x")))).toBe(true);
    } finally {
      Object.defineProperty(process, "platform", realPlatform);
      if (realGetuid === undefined) delete process.getuid;
    }
  });

  it.skipIf(process.platform === "win32")("sits inside the shared temp directory every confined command may write", async () => {
    const { isGrantPathWithin } = await import("../permissions/asrt-sandbox.js");
    const { POSIX_SHARED_TMP } = await import("../permissions/base-allowed-directories.js");
    const root = runTmpRoot();
    ensureRunTmpRoot(root);
    const sharedTmp = realpathSync(POSIX_SHARED_TMP);
    expect(isGrantPathWithin(sharedTmp, realpathSync(root))).toBe(true);
    expect(isGrantPathWithin(sharedTmp, join(homedir(), ".ave", "test-tmp", "t-AbC123"))).toBe(false);
  });

  // Testing foreign ownership requires another uid's directory and is not covered here.
  it("is refused when it is a link, and made owner-only", () => {
    const parent = scratch();
    const elsewhere = scratch();
    const linked = join(parent, "linked");
    link(elsewhere, linked);
    expect(() => ensureRunTmpRoot(linked)).toThrow(/not a real directory/);
    const own = join(parent, "own");
    ensureRunTmpRoot(own);
    if (process.platform !== "win32") expect(statSync(own).mode & 0o777).toBe(0o700);
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
