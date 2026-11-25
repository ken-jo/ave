/**
 * Removing a run's directories is the one place the host deletes recursively under a tree a container wrote. These
 * cases hold it to its guards with a filesystem that misbehaves on chosen paths: it never enters another filesystem
 * mounted inside the run, it survives another remover taking entries first, and it never leaves a tree without the
 * marker that proves whose it is.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const faults = vi.hoisted(() => ({
  /** Directories that report another device, as a mount point does. */
  mounted: new Set<string>(),
  /** Entries another remover deletes just before this one reaches them. */
  taken: new Set<string>(),
  /** Directories another remover is still filling or emptying. */
  busy: new Set<string>(),
}));

vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  const coded = (code: string, path: string): Error => Object.assign(new Error(`${code}: ${path}`), { code });
  return {
    ...actual,
    lstatSync: ((path: string, options?: never) => {
      const entry = actual.lstatSync(path, options);
      if (entry !== undefined && faults.mounted.has(path)) return Object.assign(Object.create(Object.getPrototypeOf(entry)), entry, { dev: entry.dev + 1 });
      return entry;
    }) as typeof actual.lstatSync,
    unlinkSync: ((path: string) => {
      if (faults.taken.has(path)) {
        actual.unlinkSync(path);
        throw coded("ENOENT", path);
      }
      actual.unlinkSync(path);
    }) as typeof actual.unlinkSync,
    rmdirSync: ((path: string) => {
      if (faults.busy.has(path)) throw coded("ENOTEMPTY", path);
      actual.rmdirSync(path);
    }) as typeof actual.rmdirSync,
  };
});

const {
  createMxcRunStaging, establishMxcRuntimeRoot, mxcStagingParent, removeMxcRunStaging, sweepMxcRunStaging,
} = await import("../mxc-runtime-root.js");
type MxcRuntimeHost = import("../mxc-runtime-root.js").MxcRuntimeHost;

const posix = process.platform === "darwin" || process.platform === "linux";
const ID = "0123456789abcdef0123456789abcdef";

let scratch: string;
let host: MxcRuntimeHost;
let parent: string;

beforeEach(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "ave-rt-rm-")));
  mkdirSync(join(scratch, "cache"));
  host = {
    platform: process.platform, cacheHome: join(scratch, "cache"), uid: process.getuid?.(), pid: process.pid,
    aveHome: join(scratch, "user", ".ave"), processExists: (pid) => pid === process.pid, processStart: () => "start",
  };
  establishMxcRuntimeRoot(host);
  parent = mxcStagingParent(process.platform, host);
});

afterEach(() => {
  for (const set of Object.values(faults)) set.clear();
  rmSync(scratch, { recursive: true, force: true });
});

/** A tree a process that is gone left behind. */
function abandoned(): string {
  const root = join(parent, ID);
  writeFileSync(`${root}.owner`, JSON.stringify({ pid: 424242, start: "then", instance: "gone" }), { mode: 0o600 });
  mkdirSync(join(root, "home", "nested"), { recursive: true });
  writeFileSync(join(root, "home", "nested", "data"), "x");
  writeFileSync(join(root, "home", "file"), "x");
  return root;
}

describe.runIf(posix)("run staging removal guards", () => {
  it("does not enter another filesystem mounted inside a run, and keeps the tree and its marker", () => {
    const run = createMxcRunStaging(host);
    const mount = join(`${run.root}.retired`, "home", "mnt");
    mkdirSync(join(run.home, "mnt"));
    writeFileSync(join(run.home, "mnt", "host-data"), "x");
    faults.mounted.add(mount);
    removeMxcRunStaging(run);
    expect(existsSync(join(mount, "host-data"))).toBe(true);
    expect(existsSync(`${run.root}.owner`)).toBe(true);
    // A later sweep by the same process meets the same mount and stops again.
    sweepMxcRunStaging(host);
    expect(existsSync(join(mount, "host-data"))).toBe(true);
    expect(existsSync(`${run.root}.owner`)).toBe(true);
    // Once the mount is gone, the sweep finishes the removal.
    faults.mounted.clear();
    sweepMxcRunStaging(host);
    expect(readdirSync(parent)).toEqual([]);
  });

  it("skips an entry another remover took first and still finishes", () => {
    const root = abandoned();
    faults.taken.add(join(`${root}.retired`, "home", "file"));
    sweepMxcRunStaging(host);
    expect(readdirSync(parent)).toEqual([]);
  });

  it("keeps the marker while any part of the tree is left, so no tree is ever unmarked", () => {
    const root = abandoned();
    faults.busy.add(join(`${root}.retired`, "home"));
    sweepMxcRunStaging(host);
    expect(readdirSync(parent).sort()).toEqual([`${ID}.owner`, `${ID}.retired`]);
    // The other remover is done: the next sweep proves ownership from the marker and removes the rest.
    faults.busy.clear();
    sweepMxcRunStaging(host);
    expect(readdirSync(parent)).toEqual([]);
    expect(existsSync(dirname(parent))).toBe(true);
  });
});
