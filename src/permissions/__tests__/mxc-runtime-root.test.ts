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
  AVE_APP_ID, createMxcRunStaging, currentMxcRuntimeHost, ensureMxcRuntimeRoot, mxcCacheHome, MxcRuntimeRootError,
  mxcRunSocketPath, mxcRuntimeRootPath, mxcStagingParent, removeMxcRunStaging, sweepMxcRunStaging, type MxcRuntimeHost,
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
function leftover(parent: string, id: string, owner: { pid: number; start: string }): string {
  const root = join(parent, id);
  writeFileSync(`${root}.owner`, JSON.stringify(owner), { mode: 0o600 });
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
    expect(mxcRuntimeRootPath(hostOf())).toBe(ROOT());
    // Naming the root creates nothing.
    expect(readdirSync(base)).toEqual([]);
    const root = ensureMxcRuntimeRoot(hostOf());
    expect(root).toBe(ROOT());
    expect(mode(root)).toBe(0o700);
    expect(lstatSync(root).uid).toBe(uid);
    expect(ensureMxcRuntimeRoot(hostOf())).toBe(root);
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

  it("returns the canonical path when the cache directory is reached through a link", () => {
    const linked = join(scratch, "cache-link");
    symlinkSync(base, linked);
    expect(mxcRuntimeRootPath(hostOf({ cacheHome: linked }))).toBe(ROOT());
    expect(ensureMxcRuntimeRoot(hostOf({ cacheHome: linked }))).toBe(ROOT());
  });

  it("creates a cache directory that is not there yet", () => {
    const absent = join(scratch, "home", ".cache");
    expect(ensureMxcRuntimeRoot(hostOf({ platform: "linux", cacheHome: absent }))).toBe(join(absent, AVE_APP_ID, "mxc-runtime"));
  });

  it("stages on Windows under the Ave home, as before, and nowhere else resolves to it", () => {
    expect(mxcStagingParent("win32", hostOf({ platform: "win32", aveHome: "C:\\ave" }))).toBe("C:\\ave\\mxc-staging");
    expect(() => ensureMxcRuntimeRoot(hostOf({ platform: "win32" }))).toThrow(MxcRuntimeRootError);
    expect(overlaps(mxcStagingParent(process.platform, hostOf()), home)).toBe(false);
  });
});

describe.runIf(posix)("runtime root fails closed", () => {
  const nothingUnderAveHome = (): void => expect(readdirSync(home)).toEqual(["config.json"]);
  const target = (): string => {
    const path = join(scratch, "elsewhere");
    mkdirSync(path, { mode: 0o700 });
    return path;
  };

  it("refuses a symbolic link at the root, and creates nothing behind it or in the Ave home", () => {
    const elsewhere = target();
    mkdirSync(dirname(ROOT()));
    symlinkSync(elsewhere, ROOT());
    expect(() => createMxcRunStaging(hostOf())).toThrow(MxcRuntimeRootError);
    expect(readdirSync(elsewhere)).toEqual([]);
    nothingUnderAveHome();
  });

  it("refuses a link at the app's cache directory", () => {
    const elsewhere = target();
    symlinkSync(elsewhere, dirname(ROOT()));
    // A dangling link: there is no directory to resolve, and none is created through it.
    rmSync(elsewhere, { recursive: true });
    expect(() => createMxcRunStaging(hostOf())).toThrow(MxcRuntimeRootError);
    expect(existsSync(elsewhere)).toBe(false);
    nothingUnderAveHome();
  });

  it("refuses a root open to other accounts without re-moding it", () => {
    mkdirSync(ROOT(), { recursive: true });
    chmodSync(ROOT(), 0o755);
    expect(() => createMxcRunStaging(hostOf())).toThrow(MxcRuntimeRootError);
    expect(mode(ROOT())).toBe(0o755);
    nothingUnderAveHome();
  });

  it("refuses a root that is a file, or another account's", () => {
    mkdirSync(dirname(ROOT()));
    writeFileSync(ROOT(), "");
    expect(() => createMxcRunStaging(hostOf())).toThrow(MxcRuntimeRootError);
    rmSync(ROOT());
    // A directory at this account's name that another account owns.
    expect(() => createMxcRunStaging(hostOf({ uid: uid + 1 }))).toThrow(/not this account's/u);
    nothingUnderAveHome();
  });

  it("refuses a link at the staging parent", () => {
    const elsewhere = target();
    symlinkSync(elsewhere, join(ensureMxcRuntimeRoot(hostOf()), "staging"));
    expect(() => createMxcRunStaging(hostOf())).toThrow(MxcRuntimeRootError);
    expect(readdirSync(elsewhere)).toEqual([]);
  });

  it("refuses a cache directory that is relative or lies inside the Ave home, before creating anything", () => {
    expect(() => ensureMxcRuntimeRoot(hostOf({ cacheHome: "relative/cache" }))).toThrow(MxcRuntimeRootError);
    const inside = join(home, "cache");
    expect(() => ensureMxcRuntimeRoot(hostOf({ cacheHome: inside }))).toThrow(/overlaps the Ave home/u);
    nothingUnderAveHome();
    // Reached through a link, the Ave home is still the Ave home.
    const alias = join(scratch, "home-alias");
    symlinkSync(home, alias);
    expect(() => ensureMxcRuntimeRoot(hostOf({ aveHome: alias, cacheHome: inside }))).toThrow(/overlaps the Ave home/u);
    expect(() => ensureMxcRuntimeRoot(hostOf({ cacheHome: join(alias, "cache") }))).toThrow(/overlaps the Ave home/u);
    nothingUnderAveHome();
  });

  it("refuses an Ave home inside the runtime root", () => {
    expect(() => ensureMxcRuntimeRoot(hostOf({ aveHome: join(ROOT(), "nested", ".ave") }))).toThrow(/overlaps the Ave home/u);
    expect(readdirSync(base)).toEqual([]);
  });

  it("refuses a platform or account it has no placement for", () => {
    expect(() => ensureMxcRuntimeRoot(hostOf({ platform: "freebsd" }))).toThrow(MxcRuntimeRootError);
    expect(() => ensureMxcRuntimeRoot(hostOf({ uid: undefined }))).toThrow(MxcRuntimeRootError);
  });

  it("refuses a run it could not mark as owned", () => {
    processes.set(process.pid, null);
    expect(() => createMxcRunStaging(hostOf())).toThrow(MxcRuntimeRootError);
    expect(readdirSync(mxcStagingParent(process.platform, hostOf()))).toEqual([]);
  });
});

describe.runIf(posix)("run staging layout", () => {
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
    expect(JSON.parse(readFileSync(marker, "utf8"))).toEqual({ pid: process.pid, start: SELF_START });
    expect(mode(marker)).toBe(0o600);
    expect(overlaps(marker, run.root)).toBe(false);
    removeMxcRunStaging(run);
  });

  it("keeps sockets in a private directory outside the run's grant, on a path a socket address can hold", async () => {
    // A cache directory about as long as a real one; the test scratch under the per-user temp directory is longer.
    const short = realpathSync(mkdtempSync("/tmp/ave-rt-"));
    onTestFinished(() => rmSync(short, { recursive: true, force: true }));
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
    expect(readdirSync(parent).sort()).toEqual([ID_A, "note", second.root.slice(parent.length + 1), `${second.root.slice(parent.length + 1)}.owner`].sort());
    expect(existsSync(second.home)).toBe(true);
    removeMxcRunStaging(second);
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
    const released = leftover(parent, ID_A, { pid: process.pid, start: SELF_START });
    sweepMxcRunStaging(host);
    expect(existsSync(live.home)).toBe(true);
    expect(existsSync(released)).toBe(false);
    removeMxcRunStaging(live);
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
  /** Allows first and the Ave home deny last, the order in which the deny overrides every allow. */
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
});
