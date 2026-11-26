/**
 * Everything a container needs (its staging directory, HOME, temp and sockets) lives under one per-account runtime
 * root outside the Ave home on macOS and Linux. The Ave home is a denied directory, and the macOS sandbox lets a deny
 * override every allow, so a HOME nested inside it could never be written. These cases hold the selector to an owned,
 * private, non-link directory, the layout to paths that never touch the Ave home, and cleanup to this owner's trees.
 */
import { spawnSync } from "node:child_process";
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, onTestFinished } from "vitest";

import { MxcProcessContractError } from "../mxc-extension-errors.js";
import {
  AVE_APP_ID, createMxcRunStaging, currentMxcRuntimeHost, establishMxcRuntimeRoot, mxcCacheHome, MxcRuntimeRootError,
  _forgetMxcRuntimeRootForTest, mxcRunSocketPath, mxcRuntimeRootFloorPath, mxcStagingParent, removeMxcRunStaging, requireMxcRuntimeRoot, sweepMxcRunStaging,
  type MxcRuntimeHost,
} from "../mxc-runtime-root.js";

const posix = process.platform === "darwin" || process.platform === "linux";
const darwin = process.platform === "darwin";
const uid = process.getuid?.() ?? -1;
const SELF_START = "self-start";
const ID_A = "0123456789abcdef0123456789abcdef";

let scratch: string;
let base: string;
let home: string;
/** Start identities by pid; an absent pid does not exist. */
let processes: Map<number, string | null>;

function hostOf(overrides: Partial<MxcRuntimeHost> = {}): MxcRuntimeHost {
  return {
    platform: process.platform,
    cacheHome: base,
    uid,
    pid: process.pid,
    aveHome: home,
    processExists: (pid) => processes.has(pid),
    processStart: (pid) => processes.get(pid) ?? null,
    ...overrides,
  };
}

const overlaps = (left: string, right: string): boolean =>
  left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
const mode = (path: string): number => lstatSync(path).mode & 0o777;
const ROOT = (): string => join(base, AVE_APP_ID, "mxc-runtime");

/** A leftover as a crashed process would leave it: a marker, a tree with a file in it, and optionally a retired tree. */
function leftover(parent: string, id: string, owner: { pid: number; start: string; instance?: string }): string {
  const root = join(parent, id);
  writeFileSync(`${root}.owner`, JSON.stringify({ instance: "another-copy", ...owner }), { mode: 0o600 });
  mkdirSync(join(root, "home"), { recursive: true });
  writeFileSync(join(root, "home", "data"), "x");
  return root;
}

beforeEach(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "ave-rt-")));
  base = join(scratch, "t");
  home = join(scratch, "user", ".ave");
  mkdirSync(base);
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "config.json"), "secret");
  processes = new Map([[process.pid, SELF_START]]);
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe.runIf(posix)("runtime root selection", () => {
  it("is <cache home>/<app id>/mxc-runtime: 0700, this account's, and the same for every call", () => {
    expect(mxcRuntimeRootFloorPath(base)).toBe(ROOT());
    // Naming the root creates nothing.
    expect(readdirSync(base)).toEqual([]);
    const root = establishMxcRuntimeRoot(hostOf());
    expect(root).toBe(ROOT());
    expect(mode(root)).toBe(0o700);
    expect(lstatSync(root).uid).toBe(uid);
    expect(establishMxcRuntimeRoot(hostOf())).toBe(root);
    expect(requireMxcRuntimeRoot(hostOf())).toBe(root);
  });

  it("names its directory by the packaged app id", () => {
    const manifest = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as { build: { appId: string } };
    expect(AVE_APP_ID).toBe(manifest.build.appId);
  });

  it("takes the account's cache directory, never the temp directory", () => {
    expect(mxcCacheHome("darwin", { XDG_CACHE_HOME: "/elsewhere" }, "/Users/example")).toBe("/Users/example/Library/Caches");
    expect(mxcCacheHome("linux", {}, "/home/example")).toBe("/home/example/.cache");
    expect(mxcCacheHome("linux", { XDG_CACHE_HOME: "/var/cache/example" }, "/home/example")).toBe("/var/cache/example");
    // Not absolute: ignored, as the base directory specification says.
    expect(mxcCacheHome("linux", { XDG_CACHE_HOME: "relative/cache" }, "/home/example")).toBe("/home/example/.cache");
    expect(mxcCacheHome("linux", { XDG_CACHE_HOME: "" }, "/home/example")).toBe("/home/example/.cache");
  });

  it("resolves a cache directory reached through a link, the floor's path included", () => {
    const linked = join(scratch, "cache-link");
    symlinkSync(base, linked);
    expect(mxcRuntimeRootFloorPath(linked)).toBe(ROOT());
    expect(establishMxcRuntimeRoot(hostOf({ cacheHome: linked }))).toBe(ROOT());
  });

  it("creates a cache directory that is not there yet", () => {
    const absent = join(scratch, "home", ".cache");
    expect(mxcRuntimeRootFloorPath(absent)).toBe(join(absent, AVE_APP_ID, "mxc-runtime"));
    expect(establishMxcRuntimeRoot(hostOf({ platform: "linux", cacheHome: absent }))).toBe(join(absent, AVE_APP_ID, "mxc-runtime"));
  });

  it("resolves staging only for the platform it runs on, and never into the Ave home", () => {
    // This host has no Windows placement: a POSIX cache directory is no drive path, and it has no Windows directory helpers.
    expect(() => establishMxcRuntimeRoot(hostOf({ platform: "win32", cacheHome: join(scratch, "windows") }))).toThrow(MxcRuntimeRootError);
    expect(() => mxcStagingParent("win32", hostOf({ platform: "win32", aveHome: "C:\\ave" }))).toThrow(MxcRuntimeRootError);
    expect(() => mxcStagingParent("win32", hostOf())).toThrow(MxcRuntimeRootError);
    establishMxcRuntimeRoot(hostOf());
    expect(overlaps(mxcStagingParent(process.platform, hostOf()), home)).toBe(false);
  });
});

describe.runIf(posix)("the floor's path never throws", () => {
  it("names the path as spelled when the cache directory cannot be resolved", () => {
    // A file where a directory is expected, a link loop, and a relative value.
    writeFileSync(join(scratch, "file"), "");
    expect(mxcRuntimeRootFloorPath(join(scratch, "file", "cache"))).toBe(join(scratch, "file", "cache", AVE_APP_ID, "mxc-runtime"));
    symlinkSync(join(scratch, "loop"), join(scratch, "loop"));
    expect(mxcRuntimeRootFloorPath(join(scratch, "loop", "cache"))).toBe(join(scratch, "loop", "cache", AVE_APP_ID, "mxc-runtime"));
    expect(mxcRuntimeRootFloorPath("relative/cache")).toMatch(/\/relative\/cache\/ai\.agent-connector\.ave\/mxc-runtime$/u);
    // The same cache directories refuse the root itself.
    expect(() => establishMxcRuntimeRoot(hostOf({ cacheHome: join(scratch, "file", "cache") }))).toThrow(MxcRuntimeRootError);
    expect(() => establishMxcRuntimeRoot(hostOf({ cacheHome: join(scratch, "loop", "cache") }))).toThrow(MxcRuntimeRootError);
  });
});

describe.runIf(posix)("runtime root fails closed", () => {
  const nothingUnderAveHome = (): void => expect(readdirSync(home)).toEqual(["config.json"]);
  const target = (): string => {
    const path = join(scratch, "elsewhere");
    mkdirSync(path, { mode: 0o700 });
    return path;
  };
  /** Start-up refuses the root for the given reason, and so does every run after it. The record is then dropped, as
   * in a new process, so one case can try several obstacles on one cache directory. */
  const refused = (host: MxcRuntimeHost = hostOf(), message: RegExp = /./u): void => {
    let failure: unknown;
    try { establishMxcRuntimeRoot(host); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(MxcRuntimeRootError);
    expect((failure as Error).message).toMatch(message);
    expect(() => createMxcRunStaging(host)).toThrow(MxcRuntimeRootError);
    _forgetMxcRuntimeRootForTest(host.cacheHome);
  };

  it("refuses a symbolic link at the root, and creates nothing behind it or in the Ave home", () => {
    const elsewhere = target();
    mkdirSync(dirname(ROOT()));
    symlinkSync(elsewhere, ROOT());
    refused();
    expect(readdirSync(elsewhere)).toEqual([]);
    nothingUnderAveHome();
  });

  it("refuses a live link at the app's cache directory, and creates nothing behind it", () => {
    const elsewhere = target();
    symlinkSync(elsewhere, dirname(ROOT()));
    refused(hostOf(), /app's cache directory is a link/u);
    expect(readdirSync(elsewhere)).toEqual([]);
    nothingUnderAveHome();
  });

  it("refuses a dangling link at the app's cache directory", () => {
    symlinkSync(join(scratch, "nowhere"), dirname(ROOT()));
    refused();
    expect(existsSync(join(scratch, "nowhere"))).toBe(false);
  });

  it("refuses a cache directory below one that another account could rewrite", () => {
    const open = join(scratch, "open");
    mkdirSync(join(open, "cache"), { recursive: true });
    chmodSync(open, 0o777);
    refused(hostOf({ cacheHome: join(open, "cache") }), /not held by this account or the system/u);
    expect(readdirSync(join(open, "cache"))).toEqual([]);
    // A cache directory that is not there yet is not created under a refused ancestor.
    refused(hostOf({ cacheHome: join(open, "later", "cache") }), /not held by this account or the system/u);
    expect(readdirSync(open)).toEqual(["cache"]);
    // Sticky, as a shared temp directory is: its entries cannot be replaced by another account.
    chmodSync(open, 0o1777);
    _forgetMxcRuntimeRootForTest(join(open, "cache"));
    expect(establishMxcRuntimeRoot(hostOf({ cacheHome: join(open, "cache") }))).toBe(join(open, "cache", AVE_APP_ID, "mxc-runtime"));
  });

  it("refuses an app cache directory that other accounts can write", () => {
    mkdirSync(dirname(ROOT()));
    chmodSync(dirname(ROOT()), 0o777);
    refused(hostOf(), /writable by other accounts/u);
  });

  it("refuses a root open to other accounts without re-moding it", () => {
    mkdirSync(ROOT(), { recursive: true });
    chmodSync(ROOT(), 0o755);
    refused();
    expect(mode(ROOT())).toBe(0o755);
    nothingUnderAveHome();
  });

  it("refuses a root that is a file, or another account's", () => {
    mkdirSync(dirname(ROOT()));
    writeFileSync(ROOT(), "");
    refused();
    rmSync(ROOT());
    // A directory at this account's name that another account owns.
    refused(hostOf({ uid: uid + 1 }), /not this account's|not held by this account/u);
    nothingUnderAveHome();
  });

  it("refuses a link at the staging parent", () => {
    const elsewhere = target();
    symlinkSync(elsewhere, join(establishMxcRuntimeRoot(hostOf()), "staging"));
    expect(() => createMxcRunStaging(hostOf())).toThrow(MxcRuntimeRootError);
    expect(readdirSync(elsewhere)).toEqual([]);
  });

  it("refuses a cache directory that is relative or lies inside the Ave home, before creating anything", () => {
    refused(hostOf({ cacheHome: "relative/cache" }));
    const inside = join(home, "cache");
    refused(hostOf({ cacheHome: inside }), /overlaps the Ave home/u);
    nothingUnderAveHome();
    // Reached through a link, the Ave home is still the Ave home.
    const alias = join(scratch, "home-alias");
    symlinkSync(home, alias);
    refused(hostOf({ aveHome: alias, cacheHome: inside }), /overlaps the Ave home/u);
    refused(hostOf({ cacheHome: join(alias, "cache") }), /overlaps the Ave home/u);
    nothingUnderAveHome();
  });

  it("refuses an Ave home inside the runtime root, one that does not exist yet and is reached through a link included", () => {
    refused(hostOf({ aveHome: join(ROOT(), "nested", ".ave") }), /overlaps the Ave home/u);
    const alias = join(scratch, "base-alias");
    symlinkSync(base, alias);
    refused(hostOf({ aveHome: join(alias, AVE_APP_ID, "mxc-runtime", "later", ".ave") }), /overlaps the Ave home/u);
    expect(readdirSync(base)).toEqual([]);
  });

  it("refuses a platform or account it has no placement for", () => {
    refused(hostOf({ platform: "freebsd" }));
    refused(hostOf({ uid: undefined }));
  });

  it("refuses a run it could not mark as owned", () => {
    establishMxcRuntimeRoot(hostOf());
    processes.set(process.pid, null);
    expect(() => createMxcRunStaging(hostOf())).toThrow(MxcRuntimeRootError);
    expect(readdirSync(mxcStagingParent(process.platform, hostOf()))).toEqual([]);
  });
});

describe.runIf(posix)("the root is established at start-up or not at all", () => {
  it("refuses a run when start-up never established the root", () => {
    expect(() => createMxcRunStaging(hostOf())).toThrow(/not established when the sandbox started/u);
    expect(readdirSync(base)).toEqual([]);
  });

  it("keeps refusing after a failed start-up, even once the root could be created", () => {
    writeFileSync(join(base, AVE_APP_ID), "");
    expect(() => establishMxcRuntimeRoot(hostOf())).toThrow(MxcRuntimeRootError);
    // The obstacle goes away while sandboxed processes that carry no deny for the root may still be running.
    rmSync(join(base, AVE_APP_ID));
    expect(() => createMxcRunStaging(hostOf())).toThrow(/not established when the sandbox started/u);
    expect(() => establishMxcRuntimeRoot(hostOf())).toThrow(/not established when the sandbox started/u);
    expect(readdirSync(base)).toEqual([]);
  });

  it("refuses a run after the root is removed or replaced", () => {
    const host = hostOf();
    const root = establishMxcRuntimeRoot(host);
    removeMxcRunStaging(createMxcRunStaging(host));
    rmSync(root, { recursive: true });
    expect(() => createMxcRunStaging(host)).toThrow(/no longer there/u);
    expect(existsSync(root)).toBe(false);
    // The same path, another directory.
    mkdirSync(root, { mode: 0o700 });
    expect(() => createMxcRunStaging(host)).toThrow(/no longer the directory established/u);
    expect(() => establishMxcRuntimeRoot(host)).toThrow(/no longer the directory established/u);
    expect(readdirSync(root)).toEqual([]);
  });

  it("tells a replaced root by the mark it left inside, whatever inode the replacement got", () => {
    const host = hostOf();
    const root = establishMxcRuntimeRoot(host);
    const marks = readdirSync(root).filter((name) => name.startsWith(".established-"));
    expect(marks).toEqual([expect.stringMatching(new RegExp(`^\\.established-${process.pid}-[0-9a-f]{32}$`, "u"))]);
    expect(mode(join(root, marks[0] as string))).toBe(0o600);
    // The directory itself is untouched, so its device and inode still match; only the mark is gone.
    rmSync(join(root, marks[0] as string));
    expect(() => createMxcRunStaging(host)).toThrow(/no longer the directory established/u);
    // A link under the mark's name is not the mark.
    writeFileSync(join(scratch, "forged"), "");
    symlinkSync(join(scratch, "forged"), join(root, marks[0] as string));
    expect(() => createMxcRunStaging(host)).toThrow(/no longer the directory established/u);
  });

  it("leaves every other process's mark where it is, whether or not its pid is running here", () => {
    mkdirSync(ROOT(), { recursive: true, mode: 0o700 });
    chmodSync(dirname(ROOT()), 0o700);
    const gone = `.established-424242-${"a".repeat(32)}`;
    const running = `.established-424243-${"b".repeat(32)}`;
    for (const name of [gone, running, "unrelated"]) writeFileSync(join(ROOT(), name), "");
    processes.set(424243, "another instance");
    establishMxcRuntimeRoot(hostOf());
    const names = readdirSync(ROOT());
    // A pid names a process only inside one pid namespace: an instance in another one may hold the mark.
    expect(names).toEqual(expect.arrayContaining([gone, running, "unrelated"]));
    expect(names.filter((name) => name.startsWith(`.established-${process.pid}-`))).toHaveLength(1);
  });
});

describe.runIf(posix)("run staging layout", () => {
  beforeEach(() => { establishMxcRuntimeRoot(hostOf()); });

  it("gives the container a HOME and temp outside the Ave home", () => {
    const run = createMxcRunStaging(hostOf());
    const parent = mxcStagingParent(process.platform, hostOf());
    expect(run.root).toMatch(new RegExp(`^${parent}/[0-9a-f]{32}$`, "u"));
    expect(run.home).toBe(join(run.root, "home"));
    expect(run.temp).toBe(join(run.root, "temp"));
    for (const directory of [run.root, run.home, run.temp]) {
      expect(lstatSync(directory).isDirectory()).toBe(true);
      expect(mode(directory)).toBe(0o700);
    }
    // The location staging had: nothing is created there.
    expect(existsSync(join(home, "mxc-staging"))).toBe(false);
    expect(readdirSync(home)).toEqual(["config.json"]);
    removeMxcRunStaging(run);
  });

  it("never places an allowed path at, under or above the Ave home", () => {
    const run = createMxcRunStaging(hostOf());
    // What a backend is handed for this run: its write grant, HOME, temp and socket directory.
    const allowed = [run.root, run.home, run.temp, run.socketDirectory()];
    for (const path of allowed) {
      expect(overlaps(path, home), path).toBe(false);
      expect(overlaps(path, realpathSync(home)), path).toBe(false);
      // Already canonical: the macOS sandbox matches real paths.
      expect(realpathSync(path)).toBe(path);
    }
    removeMxcRunStaging(run);
  });

  it("records the owner beside the run, outside what the container is granted", () => {
    const run = createMxcRunStaging(hostOf());
    const marker = `${run.root}.owner`;
    expect(JSON.parse(readFileSync(marker, "utf8"))).toEqual({ pid: process.pid, start: SELF_START, instance: expect.stringMatching(/^[0-9a-f]{16}$/u) });
    expect(mode(marker)).toBe(0o600);
    expect(overlaps(marker, run.root)).toBe(false);
    removeMxcRunStaging(run);
  });

  it("keeps sockets in a private directory outside the run's grant, on a path a socket address can hold", async () => {
    // A cache directory about as long as a real one; the test scratch under the per-user temp directory is longer.
    const short = realpathSync(mkdtempSync("/tmp/ave-rt-"));
    onTestFinished(() => rmSync(short, { recursive: true, force: true }));
    establishMxcRuntimeRoot(hostOf({ cacheHome: short }));
    const run = createMxcRunStaging(hostOf({ cacheHome: short }));
    const directory = run.socketDirectory();
    expect(run.socketDirectory()).toBe(directory);
    expect(directory).toBe(join(short, AVE_APP_ID, "mxc-runtime", "s", run.root.slice(-32, -24)));
    expect(mode(directory)).toBe(0o700);
    expect(overlaps(directory, run.root)).toBe(false);
    const path = mxcRunSocketPath(run, "ctl.sock");
    expect(dirname(path)).toBe(directory);
    const server = createServer();
    await new Promise<void>((resolve, reject) => server.once("error", reject).listen(path, resolve));
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(() => mxcRunSocketPath(run, "x".repeat(110))).toThrow(/socket address/u);
    for (const name of ["../escape", ".hidden", "a/b", ""]) {
      expect(() => mxcRunSocketPath(run, name)).toThrow(MxcProcessContractError);
    }
    removeMxcRunStaging(run);
  });

  it("leaves a socket name room under this account's real cache directory", () => {
    const prefix = join(mxcCacheHome(process.platform, process.env, homedir()), AVE_APP_ID, "mxc-runtime", "s", "01234567");
    const limit = process.platform === "darwin" ? 103 : 107;
    // What is left for the file name after the directory and its separator.
    expect(limit - Buffer.byteLength(prefix) - 1).toBeGreaterThanOrEqual("control.sock".length);
  });
});

describe.runIf(posix)("run staging cleanup", () => {
  beforeEach(() => { establishMxcRuntimeRoot(hostOf()); });

  it("removes exactly the released run: its tree, sockets and marker", () => {
    const host = hostOf();
    const first = createMxcRunStaging(host);
    const second = createMxcRunStaging(host);
    const parent = dirname(first.root);
    const sockets = first.socketDirectory();
    writeFileSync(join(first.home, "file"), "x");
    // Not created by any run: an unmarked directory and a stray file.
    mkdirSync(join(parent, ID_A));
    writeFileSync(join(parent, "note"), "keep");
    removeMxcRunStaging(first);
    expect(existsSync(first.root)).toBe(false);
    expect(existsSync(sockets)).toBe(false);
    expect(readdirSync(dirname(sockets))).toEqual([]);
    expect(readdirSync(parent).sort()).toEqual([ID_A, "note", second.root.slice(parent.length + 1), `${second.root.slice(parent.length + 1)}.owner`].sort());
    expect(existsSync(second.home)).toBe(true);
    removeMxcRunStaging(second);
  });

  it("refuses a socket directory that is already there, and never removes it", () => {
    const run = createMxcRunStaging(hostOf());
    const taken = join(dirname(dirname(run.root)), "s", run.root.slice(-32, -24));
    mkdirSync(taken, { recursive: true });
    writeFileSync(join(taken, "theirs.sock"), "");
    expect(() => run.socketDirectory()).toThrow(MxcRuntimeRootError);
    removeMxcRunStaging(run);
    expect(existsSync(join(taken, "theirs.sock"))).toBe(true);
    expect(existsSync(run.root)).toBe(false);
  });

  it("refuses to remove a run twice or one this process did not create", () => {
    const run = createMxcRunStaging(hostOf());
    removeMxcRunStaging(run);
    expect(() => removeMxcRunStaging(run)).toThrow(MxcProcessContractError);
    expect(() => run.socketDirectory()).toThrow(MxcProcessContractError);
    const parent = mxcStagingParent(process.platform, hostOf());
    const foreign = leftover(parent, ID_A, { pid: 424242, start: "gone" });
    expect(() => removeMxcRunStaging({ root: foreign, home: join(foreign, "home"), temp: join(foreign, "temp"), socketDirectory: () => "" }))
      .toThrow(MxcProcessContractError);
    expect(existsSync(join(foreign, "home", "data"))).toBe(true);
  });

  it("unlinks a planted link without following it, and reopens a directory the container closed", () => {
    const run = createMxcRunStaging(hostOf());
    const outside = join(scratch, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "keep"), "x");
    symlinkSync(outside, join(run.home, "link"));
    const closed = join(run.temp, "closed");
    mkdirSync(closed);
    writeFileSync(join(closed, "inner"), "x");
    chmodSync(closed, 0o000);
    removeMxcRunStaging(run);
    expect(existsSync(run.root)).toBe(false);
    expect(readdirSync(dirname(run.root))).toEqual([]);
    expect(readFileSync(join(outside, "keep"), "utf8")).toBe("x");
  });
});

describe.runIf(posix)("abandoned run staging sweep", () => {
  let parent: string;
  beforeEach(() => {
    establishMxcRuntimeRoot(hostOf());
    parent = mxcStagingParent(process.platform, hostOf());
  });

  it("removes a tree whose owner is gone, and one whose owner's pid now belongs to another process", () => {
    leftover(parent, ID_A, { pid: 424242, start: "then" });
    const reused = leftover(parent, ID_A.replace("0", "1"), { pid: 424243, start: "then" });
    mkdirSync(`${reused}.retired`);
    writeFileSync(join(`${reused}.retired`, "half-removed"), "x");
    processes.set(424243, "later");
    sweepMxcRunStaging(hostOf());
    expect(readdirSync(parent)).toEqual([]);
  });

  it("keeps a tree whose owner is running or cannot be determined", () => {
    const running = leftover(parent, ID_A, { pid: 424242, start: "then" });
    const unknown = leftover(parent, ID_A.replace("0", "1"), { pid: 424243, start: "then" });
    processes.set(424242, "then");
    processes.set(424243, null);
    sweepMxcRunStaging(hostOf());
    expect(existsSync(join(running, "home", "data"))).toBe(true);
    expect(existsSync(join(unknown, "home", "data"))).toBe(true);
  });

  it("keeps this process's live runs and removes the ones it already released", () => {
    const host = hostOf();
    const live = createMxcRunStaging(host);
    const { instance } = JSON.parse(readFileSync(`${live.root}.owner`, "utf8")) as { instance: string };
    const released = leftover(parent, ID_A, { pid: process.pid, start: SELF_START, instance });
    sweepMxcRunStaging(host);
    expect(existsSync(live.home)).toBe(true);
    expect(existsSync(released)).toBe(false);
    removeMxcRunStaging(live);
  });

  it("keeps a run of another copy of this module in the same process", () => {
    // Same pid and start identity, another instance: that copy's live run, which this copy has no record of.
    const theirs = leftover(parent, ID_A, { pid: process.pid, start: SELF_START, instance: "another-copy" });
    sweepMxcRunStaging(hostOf());
    expect(existsSync(join(theirs, "home", "data"))).toBe(true);
  });

  it("leaves a socket directory another run made under the same leading digits", () => {
    const sockets = join(dirname(parent), "s");
    mkdirSync(join(sockets, ID_A.slice(0, 8)), { recursive: true });
    writeFileSync(join(sockets, `${ID_A.slice(0, 8)}.owner`), `${ID_A.slice(0, 8)}${"f".repeat(24)}`);
    leftover(parent, ID_A, { pid: 424242, start: "then" });
    sweepMxcRunStaging(hostOf());
    expect(existsSync(join(parent, ID_A))).toBe(false);
    expect(readdirSync(sockets).sort()).toEqual([ID_A.slice(0, 8), `${ID_A.slice(0, 8)}.owner`]);
  });

  it("removes a gone run's own socket directory with it", () => {
    const sockets = join(dirname(parent), "s");
    mkdirSync(join(sockets, ID_A.slice(0, 8)), { recursive: true });
    writeFileSync(join(sockets, ID_A.slice(0, 8), "ctl.sock"), "");
    writeFileSync(join(sockets, `${ID_A.slice(0, 8)}.owner`), ID_A);
    leftover(parent, ID_A, { pid: 424242, start: "then" });
    sweepMxcRunStaging(hostOf());
    expect(readdirSync(sockets)).toEqual([]);
    expect(readdirSync(parent)).toEqual([]);
  });

  it("keeps everything it cannot prove is this owner's", () => {
    const outside = join(scratch, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "keep"), "x");
    // No marker.
    mkdirSync(join(parent, ID_A));
    // A marker that is a link, a malformed one, and one for a name that is not a run id.
    const linked = join(parent, ID_A.replace("0", "1"));
    mkdirSync(linked);
    writeFileSync(join(scratch, "forged"), JSON.stringify({ pid: 424242, start: "then" }));
    symlinkSync(join(scratch, "forged"), `${linked}.owner`);
    const malformed = join(parent, ID_A.replace("0", "2"));
    mkdirSync(malformed);
    writeFileSync(`${malformed}.owner`, "{");
    mkdirSync(join(parent, "named"));
    writeFileSync(join(parent, "named.owner"), JSON.stringify({ pid: 424242, start: "then" }));
    // A dead owner's marker beside a link: the link is not this account's directory.
    const planted = join(parent, ID_A.replace("0", "3"));
    writeFileSync(`${planted}.owner`, JSON.stringify({ pid: 424242, start: "then" }));
    symlinkSync(outside, planted);
    const before = readdirSync(parent).sort();
    sweepMxcRunStaging(hostOf());
    expect(readdirSync(parent).sort()).toEqual(before);
    expect(readFileSync(join(outside, "keep"), "utf8")).toBe("x");
  });

  it("sweeps once before the first run under a staging parent", () => {
    leftover(parent, ID_A, { pid: 424242, start: "then" });
    const run = createMxcRunStaging(hostOf());
    expect(existsSync(join(parent, ID_A))).toBe(false);
    removeMxcRunStaging(run);
  });
});

describe.runIf(posix)("process start identity on this host", () => {
  it("is stable for a running process and absent for one that is not", () => {
    const host = currentMxcRuntimeHost();
    const first = host.processStart(process.pid);
    expect(first).toEqual(expect.any(String));
    expect(host.processStart(process.pid)).toBe(first);
    expect(host.processExists(process.pid)).toBe(true);
    const exited = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
    const pid = Number(exited.stdout);
    expect(host.processExists(pid)).toBe(false);
    expect(host.processStart(pid)).toBeNull();
  });
});

describe.runIf(darwin)("macOS sandbox decisions for the layout", () => {
  beforeEach(() => { establishMxcRuntimeRoot(hostOf()); });

  /** Allows first and the Ave home deny last, the order in which the deny overrides every allow.
   * A macOS container policy must never carry the runtime root's read-floor deny for the container's own run: that
   * deny belongs to the other confined processes, and here it would override the run's own HOME and temp the same way.
   * The last case below shows it. */
  const profile = (writeRoot: string): string => [
    "(version 1)(allow default)",
    '(deny file-write* (subpath "/"))',
    '(allow file-write* (literal "/dev/null"))',
    `(allow file-write* (subpath ${JSON.stringify(writeRoot)}))`,
    `(deny file-read* file-write* (subpath ${JSON.stringify(home)}))`,
  ].join("\n");
  const SCRIPT = [
    'echo x > "$HOME/w" 2>/dev/null; echo "home-write=$?"',
    'echo x > "$TMPDIR/w" 2>/dev/null; echo "temp-write=$?"',
    'cat "$AVE/config.json" >/dev/null 2>&1; echo "ave-read=$?"',
    'ls "$AVE" >/dev/null 2>&1; echo "ave-list=$?"',
    'echo x > "$OUTSIDE/w" 2>/dev/null; echo "outside-write=$?"',
    'cat "$OUTSIDE/keep" >/dev/null 2>&1; echo "outside-read=$?"',
  ].join("\n");

  function decide(root: string, homeDir: string, tempDir: string): Record<string, boolean> {
    const outside = join(scratch, "outside");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "keep"), "x");
    const run = spawnSync("/usr/bin/sandbox-exec", ["-p", profile(root), "/bin/sh", "-c", SCRIPT], {
      encoding: "utf8", env: { PATH: "/usr/bin:/bin", HOME: homeDir, TMPDIR: tempDir, AVE: home, OUTSIDE: outside },
    });
    expect(run.status, run.stderr).toBe(0);
    return Object.fromEntries(run.stdout.trim().split("\n").map((line) => {
      const [name, status] = line.split("=");
      return [name, status === "0"];
    }));
  }

  it("lets the container write its HOME and temp under the runtime root while the Ave home stays unreadable", () => {
    const run = createMxcRunStaging(hostOf());
    expect(decide(run.root, run.home, run.temp)).toEqual({
      "home-write": true, "temp-write": true, "ave-read": false, "ave-list": false,
      // Controls: the profile confines writes, and reads outside the Ave home work.
      "outside-write": false, "outside-read": true,
    });
    expect(readFileSync(join(run.home, "w"), "utf8")).toBe("x\n");
    removeMxcRunStaging(run);
  });

  it("cannot write a HOME and temp nested in the Ave home: the deny wins over their allow", () => {
    const nested = join(home, "mxc-staging", ID_A);
    mkdirSync(join(nested, "home"), { recursive: true });
    mkdirSync(join(nested, "temp"));
    expect(decide(nested, join(nested, "home"), join(nested, "temp"))).toMatchObject({ "home-write": false, "temp-write": false });
  });

  it("would lose its own HOME and temp to a runtime-root deny in its own policy", () => {
    const run = createMxcRunStaging(hostOf());
    const outside = join(scratch, "outside");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "keep"), "x");
    const denied = `${profile(run.root)}\n(deny file-read* file-write* (subpath ${JSON.stringify(ROOT())}))`;
    const result = spawnSync("/usr/bin/sandbox-exec", ["-p", denied, "/bin/sh", "-c", SCRIPT], {
      encoding: "utf8", env: { PATH: "/usr/bin:/bin", HOME: run.home, TMPDIR: run.temp, AVE: home, OUTSIDE: outside },
    });
    expect(result.stdout).toContain("home-write=1");
    expect(result.stdout).toContain("temp-write=1");
    removeMxcRunStaging(run);
  });
});
