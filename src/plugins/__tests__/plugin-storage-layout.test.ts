/**
 * Plugin storage layout — the security boundary inside a plugin root.
 *
 * `resolvePluginWritableRoot` is the single derivation every producer of
 * `ownerPluginSandboxRoot` uses. It must point at the plugin's data dir and
 * never at the plugin root, because the root holds the bundle the next load
 * imports into the Electron main process.
 */
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { existsSync, readFileSync, statSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { createConnection } from "node:net";
import { join, resolve, sep } from "node:path";
import {
  PLUGIN_DATA_DIR_NAME,
  PLUGIN_OWN_SOCKET_DIR_NAME,
  PLUGIN_RUNTIME_DIR_NAMES,
  PLUGIN_SOCKET_CARRY_DIR_NAME,
  PLUGIN_SOCKET_DISCARD_DIR_NAME,
  PLUGIN_WORKER_RUN_DIR_NAME,
  assertUnixSocketPathFits,
  carryPluginDataDir,
  carryPluginSocketDirs,
  isPluginRuntimeDirName,
  isSamePluginPath,
  pluginPayloadCopyFilter,
  resolvePluginSocketDir,
  resolvePluginWritableRoot,
} from "../plugin-storage-layout.js";
import { aveHome } from "../../shared/ave-home.js";
import { isPathWithin, isResolvedPathWithin } from "../plugin-storage-containment.js";
import { PLUGIN_DATA_FIXTURE, readPluginDataFixture, seedPluginDataFixture } from "./test-helpers.js";

/**
 * One armed, one-shot transient lock on the next `rename` into a path ending
 * with `lockRenameEndingWith`; every other `rename` passes through, so the
 * rest of this suite runs against the real filesystem.
 */
const renameLock = vi.hoisted(() => ({
  lockRenameEndingWith: undefined as string | undefined,
  /** Runs once, right before the first rename or link into `to` or out of `from`. */
  beforeMove: undefined as { to?: string; from?: string; run: () => Promise<void> } | undefined,
  unlinkFailure: undefined as string | undefined,
  /** Every recursive rm the module under test issued, by path. */
  recursiveRms: [] as string[],
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: async (from: Parameters<typeof actual.rename>[0], to: Parameters<typeof actual.rename>[1]) => {
      const before = renameLock.beforeMove;
      if (before && (String(to) === before.to || String(from) === before.from)) {
        renameLock.beforeMove = undefined;
        await before.run();
      }
      const suffix = renameLock.lockRenameEndingWith;
      if (suffix !== undefined && String(to).endsWith(suffix)) {
        renameLock.lockRenameEndingWith = undefined;
        throw Object.assign(new Error(`EBUSY: resource busy or locked, rename '${String(from)}'`), { code: "EBUSY" });
      }
      return actual.rename(from, to);
    },
    link: async (from: string, to: string) => {
      const before = renameLock.beforeMove;
      if (before && (to === before.to || from === before.from)) {
        renameLock.beforeMove = undefined;
        await before.run();
      }
      return actual.link(from, to);
    },
    rm: async (path: Parameters<typeof actual.rm>[0], options?: Parameters<typeof actual.rm>[1]) => {
      if (options?.recursive) renameLock.recursiveRms.push(String(path));
      return actual.rm(path, options);
    },
    unlink: async (path: string) => {
      if (path === renameLock.unlinkFailure) {
        renameLock.unlinkFailure = undefined;
        throw Object.assign(new Error("entry unlink refused"), { code: "EIO" });
      }
      return actual.unlink(path);
    },
  };
});

const PLUGIN_ID = "ave-plugin-layout-fixture";

/** The recovery policy, recording what it discarded. */
function keepDestination(discarded: string[] = []) {
  return {
    onConflict: "keep-destination" as const,
    onDiscardEntry: (path: string) => { discarded.push(path); },
  };
}

describe("resolvePluginWritableRoot", () => {
  it("resolves to the plugin's data dir, not the plugin root", () => {
    const pluginRoot = resolve(aveHome(), "plugins", PLUGIN_ID);
    const writable = resolvePluginWritableRoot(PLUGIN_ID);
    expect(writable).toBe(resolve(pluginRoot, PLUGIN_DATA_DIR_NAME));
    expect(writable).not.toBe(pluginRoot);
  });

  it("leaves the plugin's own executable bundle and manifest outside the jail", () => {
    const pluginRoot = resolve(aveHome(), "plugins", PLUGIN_ID);
    const writable = resolvePluginWritableRoot(PLUGIN_ID);
    for (const payload of ["dist", "dist/index.js", "plugin.json"]) {
      expect(resolve(pluginRoot, payload).startsWith(`${writable}/`)).toBe(false);
    }
  });

  it("leaves the host-allocated worker run dir outside the jail", () => {
    // Worker control sockets are host-created and host-owned; the plugin never
    // needs write access to them.
    const pluginRoot = resolve(aveHome(), "plugins", PLUGIN_ID);
    const writable = resolvePluginWritableRoot(PLUGIN_ID);
    const runDir = resolve(pluginRoot, PLUGIN_WORKER_RUN_DIR_NAME);
    expect(runDir.startsWith(`${writable}/`)).toBe(false);
  });
});

describe("isPathWithin", () => {
  const under = (root: string, ...segments: string[]) => resolve(root, ...segments);

  it("accepts a descendant and the root itself", () => {
    const root = resolve("/srv", "data");
    expect(isPathWithin(root, under(root, "file.txt"))).toBe(true);
    expect(isPathWithin(root, root)).toBe(true);
  });

  it("refuses a sibling whose name merely starts with the root's", () => {
    // The reason this predicate is shared rather than rewritten per site: a
    // bare `startsWith` accepts `/srv/data-evil` for a root of `/srv/data`.
    const root = resolve("/srv", "data");
    expect(isPathWithin(root, `${root}-evil`)).toBe(false);
  });

  it("accepts a descendant of a root that already ends in a separator", () => {
    // A second separator would be appended and match nothing, so a legitimate
    // path would read as outside its own root. On Windows a drive root is
    // exactly this shape, which is where it would have surfaced first — as a
    // plugin whose own directory looks foreign to it, not as an escape.
    const root = resolve("/srv", "data");
    const rootWithTrailingSeparator = `${root}${sep}`;
    expect(isPathWithin(rootWithTrailingSeparator, under(root, "file.txt"))).toBe(true);
    expect(isPathWithin(rootWithTrailingSeparator, `${root}-evil`)).toBe(false);
  });
});

describe("isResolvedPathWithin", () => {
  it("keeps a directory whose own name begins with two dots", () => {
    // The predicate this replaced was `relative(root, target)` +
    // `!rel.startsWith("..")`, spelled identically at seven sites. For
    // `<root>/..foo` that relative path IS `"..foo"`, so every one of the seven
    // read a plainly-contained directory as an escape. Nothing named `..foo`
    // happened to exist, which is why it never showed up as a bug report.
    const root = resolve("/srv", "data");
    expect(isResolvedPathWithin(root, resolve(root, "..foo"))).toBe(true);
    expect(isResolvedPathWithin(root, resolve(root, "..foo", "bar.txt"))).toBe(true);
  });

  it("still refuses the real escapes the old predicate caught", () => {
    const root = resolve("/srv", "data");
    expect(isResolvedPathWithin(root, resolve("/srv", "data-evil"))).toBe(false);
    expect(isResolvedPathWithin(root, resolve("/etc", "passwd"))).toBe(false);
    // `..` as a whole segment is an escape and must stay one.
    expect(isResolvedPathWithin(root, `${root}${sep}..${sep}evil`)).toBe(false);
  });

  it("collapses traversal segments before deciding", () => {
    const root = resolve("/srv", "data");
    expect(isResolvedPathWithin(root, `${root}${sep}a${sep}..${sep}b`)).toBe(true);
  });

  it("treats the root itself as contained", () => {
    const root = resolve("/srv", "data");
    expect(isResolvedPathWithin(root, root)).toBe(true);
    expect(isResolvedPathWithin(`${root}${sep}`, resolve(root, "f.txt"))).toBe(true);
  });

  it("anchors a relative argument the same way `path.relative` did", () => {
    // Behaviour the seven copies had by accident (both sides went through
    // `path.relative`, which resolves against cwd) and that callers still rely
    // on. Made explicit here so a future edit cannot drop it silently.
    expect(isResolvedPathWithin(process.cwd(), "package.json")).toBe(true);
    expect(isResolvedPathWithin(resolve(process.cwd(), "src"), "package.json")).toBe(false);
  });
});

describe("resolvePluginSocketDir", () => {
  it("sits BESIDE the data directory, not inside it", () => {
    // Inside would be simpler and wrong. The Unix-socket ALLOW is scoped to one
    // directory on macOS, so putting the socket dir under `data` would make
    // every ordinary plugin file share that scope — and the case in
    // `confined-plugin-child.test.ts` that proves the ALLOW is separate from
    // the write jail would have nothing left to measure.
    const dataDir = resolvePluginWritableRoot(PLUGIN_ID);
    expect(resolvePluginSocketDir(dataDir)).toBe(
      resolve(aveHome(), "plugins", PLUGIN_ID, PLUGIN_OWN_SOCKET_DIR_NAME),
    );
  });

  it("follows a relocated data directory rather than rebuilding from the home", () => {
    // The property that keeps the granted directory and the created one equal.
    // A derivation from `aveHome()` and the id would answer with the
    // production path for a plugin whose data dir is somewhere else — and the
    // child would then be handed a directory the sandbox never heard of.
    expect(resolvePluginSocketDir("/somewhere/else/plugins/p/data")).toBe(
      `/somewhere/else/plugins/p/${PLUGIN_OWN_SOCKET_DIR_NAME}`,
    );
  });
});

describe("assertUnixSocketPathFits", () => {
  const limit = process.platform === "darwin" ? 103 : 107;

  it("accepts a path exactly at the limit", () => {
    expect(() => assertUnixSocketPathFits("/".repeat(limit), "probe")).not.toThrow();
  });

  it("refuses one byte over, and says the length rather than leaving EINVAL to explain it", () => {
    // The failure this replaces is `bind()` answering `EINVAL` — "malformed
    // address" — which names nothing and sends the reader at the address
    // family, the permissions, anywhere but a length.
    expect(() => assertUnixSocketPathFits("/".repeat(limit + 1), "probe")).toThrow(
      new RegExp(`${String(limit + 1)} bytes`),
    );
    expect(() => assertUnixSocketPathFits("/".repeat(limit + 1), "worker control socket")).toThrow(
      /worker control socket/,
    );
  });

  it("counts BYTES, not characters", () => {
    // A path is bytes to the kernel. A limit measured in JS string length would
    // pass a name of multi-byte characters that the kernel then refuses — the
    // guard would be the thing making the failure opaque.
    const multiByte = "가".repeat(Math.ceil(limit / 3));
    expect(multiByte.length).toBeLessThanOrEqual(limit);
    expect(() => assertUnixSocketPathFits(multiByte, "probe")).toThrow(/bytes/);
  });
});

const REJECT = { onConflict: "reject" } as const;

describe("carryPluginDataDir", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "plugin-data-carry-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("moves the data directory between roots with every file intact", async () => {
    const from = join(root, "old");
    const to = join(root, "new");
    await mkdir(from);
    await mkdir(to);
    await seedPluginDataFixture(from);

    await expect(carryPluginDataDir(from, to, REJECT)).resolves.toBe(true);

    expect(await readPluginDataFixture(to)).toEqual(PLUGIN_DATA_FIXTURE);
    expect(existsSync(join(from, PLUGIN_DATA_DIR_NAME))).toBe(false);
  });

  it("reports nothing to carry when the source root holds no data directory", async () => {
    const from = join(root, "old");
    const to = join(root, "new");
    await mkdir(from);
    await mkdir(to);

    await expect(carryPluginDataDir(from, to, REJECT)).resolves.toBe(false);

    expect(existsSync(join(to, PLUGIN_DATA_DIR_NAME))).toBe(false);
  });

  it("refuses to replace a data directory the target root already holds", async () => {
    const from = join(root, "old");
    const to = join(root, "new");
    await mkdir(from);
    await mkdir(to);
    await seedPluginDataFixture(from);
    await seedPluginDataFixture(to);

    await expect(carryPluginDataDir(from, to, REJECT)).rejects.toThrow(/both roots hold a plugin data directory/);

    expect(await readPluginDataFixture(from)).toEqual(PLUGIN_DATA_FIXTURE);
    expect(await readPluginDataFixture(to)).toEqual(PLUGIN_DATA_FIXTURE);
  });
});

describe("carryPluginSocketDirs", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "plugin-socket-carry-"));
  });

  afterEach(async () => {
    renameLock.beforeMove = undefined;
    renameLock.unlinkFailure = undefined;
    renameLock.recursiveRms = [];
    await rm(root, { recursive: true, force: true });
  });

  it.skipIf(process.platform === "win32").each(["old", "new"])("keeps a live child's bound socket in %s reachable through a merge", async (boundRoot) => {
    await rm(root, { recursive: true, force: true });
    root = await mkdtemp("/tmp/lvsc-");
    const from = join(root, "old");
    const to = join(root, "new");
    await mkdir(join(from, "sockets"), { recursive: true });
    await mkdir(join(to, "sockets"), { recursive: true });
    await writeFile(join(to, "sockets", "other"), "new entry");
    const inode = statSync(join(from, "sockets")).ino;
    const child = spawn(process.execPath, ["-e", `
      const net = require('node:net');
      net.createServer(socket => socket.end('alive')).listen(process.argv[1], () => console.log('ready'));
    `, join(root, boundRoot, "sockets", "live.sock")], { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    const stopped = once(child, "exit");
    try {
      await once(child.stdout!, "data");
      await carryPluginSocketDirs(from, to, { onConflict: "reject" });
      expect(statSync(join(to, "sockets")).ino).toBe(inode);
      const socket = createConnection(join(to, "sockets", "live.sock"));
      try {
        const [data] = await once(socket, "data");
        expect(String(data)).toBe("alive");
      } finally { socket.destroy(); }
    } finally {
      child.kill();
      await stopped;
    }
  });

  it("moves a nested link as an entry without following its target", async () => {
    const from = join(root, "old");
    const to = join(root, "new");
    const outside = join(root, "outside");
    await mkdir(join(from, "run"), { recursive: true });
    await mkdir(join(to, "run"), { recursive: true });
    await mkdir(outside);
    await writeFile(join(outside, "foreign"), "untouched");
    await symlink(outside, join(to, "run", "linked"), process.platform === "win32" ? "junction" : "dir");
    await carryPluginSocketDirs(from, to, { onConflict: "reject" });
    expect((await lstat(join(to, "run", "linked"))).isSymbolicLink()).toBe(true);
    expect(await readdir(outside)).toEqual(["foreign"]);
  });

  it.each(["run", "sockets"])("preflights a linked %s root without touching its target", async (name) => {
    const from = join(root, "old");
    const to = join(root, "new");
    const outside = join(root, "outside");
    await mkdir(join(from, name), { recursive: true });
    await mkdir(to);
    await mkdir(outside);
    await writeFile(join(outside, "foreign"), "untouched");
    await symlink(outside, join(to, name), process.platform === "win32" ? "junction" : "dir");

    await expect(carryPluginSocketDirs(from, to, { onConflict: "reject" })).rejects.toThrow(/directory|symlink/);
    expect(await readdir(outside)).toEqual(["foreign"]);
    expect(await readdir(join(from, name))).toEqual([]);
    expect((await lstat(join(to, name))).isSymbolicLink()).toBe(true);
  });

  it("rejects a conflict in sockets before moving run", async () => {
    const from = join(root, "old");
    const to = join(root, "new");
    for (const parent of [from, to]) {
      await mkdir(join(parent, "sockets"), { recursive: true });
      await writeFile(join(parent, "sockets", "same.sock"), parent);
    }
    await mkdir(join(from, "run"));
    const inode = statSync(join(from, "run")).ino;
    await expect(carryPluginSocketDirs(from, to, { onConflict: "reject" })).rejects.toThrow(/both roots/);
    expect(existsSync(join(from, "run"))).toBe(true);
    expect(existsSync(join(to, "run"))).toBe(false);
    expect(statSync(join(from, "run")).ino).toBe(inode);
  });

  it("never overwrites a socket bound after preflight", async () => {
    const name = "sockets";
    const from = join(root, "old");
    const to = join(root, "new");
    await mkdir(join(from, name), { recursive: true });
    await mkdir(join(to, name), { recursive: true });
    const sourceEntry = join(from, name, "late");
    const targetEntry = join(to, name, "late");
    await writeFile(targetEntry, "destination");
    let lateInode: number | undefined;
    renameLock.beforeMove = { to: sourceEntry, run: async () => {
      await writeFile(sourceEntry, "newly bound");
      lateInode = statSync(sourceEntry).ino;
    } };

    const carriedInode = statSync(targetEntry).ino;

    await expect(carryPluginSocketDirs(from, to, { onConflict: "reject" })).rejects.toThrow(/bound at .* during the carry/);
    expect(statSync(sourceEntry).ino).toBe(lateInode);
    expect(readFileSync(sourceEntry, "utf8")).toBe("newly bound");
    // The carried entry left the child-writable directory before the link was
    // refused; it is kept, host-staged, for the next carry to place.
    expect(statSync(join(from, PLUGIN_SOCKET_CARRY_DIR_NAME, "late")).ino).toBe(carriedInode);
  });

  // macOS link(2) follows a symlink and hard-links its target. sockets/ is in
  // the child's write envelope, so a child that swaps its socket for a link
  // to a file it may not write must never get a hard link to that file out
  // of the carry (the escape reproduced under a real Seatbelt child).
  it.skipIf(process.platform === "win32")("never hard-links the target of a symlink raced into sockets after preflight", async () => {
    const from = join(root, "old");
    const to = join(root, "new");
    await mkdir(join(from, "sockets"), { recursive: true });
    await mkdir(join(to, "sockets"), { recursive: true });
    const victim = join(root, "victim");
    await writeFile(victim, "original");
    const entry = join(to, "sockets", "evil.sock");
    await writeFile(entry, "bound by the child");
    renameLock.beforeMove = { from: entry, run: async () => {
      await rm(entry);
      await symlink(victim, entry);
    } };

    const outcome = await carryPluginSocketDirs(from, to, { onConflict: "reject" }).then(() => undefined, (error: unknown) => error);

    expect(renameLock.beforeMove).toBeUndefined();
    expect(statSync(victim).nlink).toBe(1);
    expect(readFileSync(victim, "utf8")).toBe("original");
    expect(String(outcome)).toMatch(/Plugin socket entry is not a socket or regular file: .*evil\.sock/);
    expect(existsSync(join(from, PLUGIN_SOCKET_CARRY_DIR_NAME, "evil.sock"))).toBe(false);
    expect(existsSync(join(from, "sockets", "evil.sock"))).toBe(false);
  });

  it.skipIf(process.platform === "win32")("refuses a symlink in sockets at preflight, before anything moves", async () => {
    const from = join(root, "old");
    const to = join(root, "new");
    await mkdir(join(from, "run"), { recursive: true });
    await mkdir(join(from, "sockets"));
    await mkdir(join(to, "sockets"), { recursive: true });
    const victim = join(root, "victim");
    await writeFile(victim, "original");
    await symlink(victim, join(to, "sockets", "evil.sock"));
    const inode = statSync(join(from, "run")).ino;

    await expect(carryPluginSocketDirs(from, to, { onConflict: "reject" }))
      .rejects.toThrow(/Plugin socket entry is not a socket or regular file: .*evil\.sock/);
    expect(statSync(join(from, "run")).ino).toBe(inode);
    expect(existsSync(join(to, "run"))).toBe(false);
    expect((await lstat(join(to, "sockets", "evil.sock"))).isSymbolicLink()).toBe(true);
    expect(statSync(victim).nlink).toBe(1);
    expect(readFileSync(victim, "utf8")).toBe("original");
  });

  // A carry interrupted while the roots had the other roles leaves its
  // staging in what is now the RECEIVING root; it belongs to that root's
  // sockets/ and must not be stranded beside the directory that replaces it.
  it("places an entry an interrupted carry left staged in the receiving root", async () => {
    const from = join(root, "old");
    const to = join(root, "new");
    await mkdir(join(from, "sockets"), { recursive: true });
    await mkdir(join(to, "sockets"), { recursive: true });
    await mkdir(join(to, PLUGIN_SOCKET_CARRY_DIR_NAME));
    const staged = join(to, PLUGIN_SOCKET_CARRY_DIR_NAME, "live.sock");
    await writeFile(staged, "live");
    const inode = statSync(staged).ino;
    const sockets = statSync(join(from, "sockets")).ino;

    await carryPluginSocketDirs(from, to, { onConflict: "reject" });

    expect(statSync(join(to, "sockets")).ino).toBe(sockets);
    expect(statSync(join(to, "sockets", "live.sock")).ino).toBe(inode);
    expect(existsSync(join(to, PLUGIN_SOCKET_CARRY_DIR_NAME))).toBe(false);
  });

  // A child can leave any shape in its own sockets/. Install refuses it (the
  // tests above); recovery must still finish, or the plugin stays unresolved
  // on every boot. It removes the entry without following it, and says so.
  it.skipIf(process.platform === "win32")("removes refused shapes under keep-destination instead of failing the recovery", async () => {
    const from = join(root, "old");
    const to = join(root, "new");
    await mkdir(join(from, "sockets"), { recursive: true });
    await mkdir(join(to, "sockets", "nested"), { recursive: true });
    const victim = join(root, "victim");
    await writeFile(victim, "original");
    await symlink(victim, join(to, "sockets", "evil.sock"));
    await symlink(victim, join(from, "sockets", "planted.sock"));
    execFileSync("mkfifo", [join(to, "sockets", "pipe")]);
    await writeFile(join(to, "sockets", "egress.sock"), "live");
    const live = statSync(join(to, "sockets", "egress.sock")).ino;
    const sockets = statSync(join(from, "sockets")).ino;
    const discarded: string[] = [];

    await carryPluginSocketDirs(from, to, keepDestination(discarded));

    expect(discarded.sort()).toEqual([
      join(from, "sockets", "planted.sock"),
      join(to, "sockets", "evil.sock"),
      join(to, "sockets", "nested"),
      join(to, "sockets", "pipe"),
    ].sort());
    expect(statSync(join(to, "sockets")).ino).toBe(sockets);
    expect(await readdir(join(to, "sockets"))).toEqual(["egress.sock"]);
    expect(statSync(join(to, "sockets", "egress.sock")).ino).toBe(live);
    expect(statSync(victim).nlink).toBe(1);
    expect(readFileSync(victim, "utf8")).toBe("original");
  });

  // A recursive delete inside a directory the child can write races the
  // child: it can swap a subdirectory for a link to an outside directory
  // between rm's lstat and its descent. Every entry the carry deletes is
  // first renamed (which never follows) into a host-only directory, and only
  // deleted there.
  it.skipIf(process.platform === "win32")("deletes recursively only inside the host-only discard directory", async () => {
    const from = join(root, "old");
    const to = join(root, "new");
    await mkdir(join(from, "run", "w1"), { recursive: true });
    await mkdir(join(to, "run", "w1"), { recursive: true });
    await mkdir(join(from, "sockets"), { recursive: true });
    await mkdir(join(to, "sockets", "nested", "sub"), { recursive: true });
    await writeFile(join(from, "sockets", "egress.sock"), "source");
    await writeFile(join(to, "sockets", "egress.sock"), "destination");
    const outside = join(root, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "foreign"), "untouched");
    await symlink(outside, join(to, "sockets", "nested", "sub", "escape"), "dir");
    renameLock.recursiveRms = [];

    await carryPluginSocketDirs(from, to, keepDestination());

    expect(await readdir(outside)).toEqual(["foreign"]);
    expect(readFileSync(join(to, "sockets", "egress.sock"), "utf8")).toBe("destination");
    expect(await readdir(join(to, "run"))).toEqual(["w1"]);
    const discard = (parent: string) => join(parent, PLUGIN_SOCKET_DISCARD_DIR_NAME);
    expect(renameLock.recursiveRms.length).toBeGreaterThan(0);
    for (const path of renameLock.recursiveRms) {
      expect([from, to].some((parent) => path === discard(parent) || path.startsWith(`${discard(parent)}${sep}`)), path).toBe(true);
    }
    expect(existsSync(discard(from))).toBe(false);
    expect(existsSync(discard(to))).toBe(false);
  });

  it("places an entry an interrupted carry left staged before it was linked", async () => {
    const from = join(root, "old");
    const to = join(root, "new");
    await mkdir(join(from, "sockets"), { recursive: true });
    await mkdir(join(from, PLUGIN_SOCKET_CARRY_DIR_NAME));
    await mkdir(join(to, "sockets"), { recursive: true });
    const staged = join(from, PLUGIN_SOCKET_CARRY_DIR_NAME, "live.sock");
    await writeFile(staged, "live");
    const inode = statSync(staged).ino;
    const sockets = statSync(join(from, "sockets")).ino;

    await carryPluginSocketDirs(from, to, { onConflict: "reject" });

    expect(statSync(join(to, "sockets")).ino).toBe(sockets);
    expect(statSync(join(to, "sockets", "live.sock")).ino).toBe(inode);
    expect(existsSync(join(from, PLUGIN_SOCKET_CARRY_DIR_NAME))).toBe(false);
  });

  it("finishes an interrupted link-then-unlink without losing the socket inode", async () => {
    const from = join(root, "old");
    const to = join(root, "new");
    await mkdir(join(from, "sockets"), { recursive: true });
    await mkdir(join(to, "sockets"), { recursive: true });
    const entry = join(to, "sockets", "live.sock");
    await writeFile(entry, "live");
    const inode = statSync(entry).ino;
    const staged = join(from, PLUGIN_SOCKET_CARRY_DIR_NAME, "live.sock");
    renameLock.unlinkFailure = staged;
    await expect(carryPluginSocketDirs(from, to, { onConflict: "reject" })).rejects.toThrow(/unlink refused/);
    expect(statSync(staged).ino).toBe(inode);
    expect(statSync(join(from, "sockets", "live.sock")).ino).toBe(inode);
    await carryPluginSocketDirs(from, to, { onConflict: "reject" });
    expect(statSync(entry).ino).toBe(inode);
    expect(existsSync(join(from, "sockets"))).toBe(false);
    expect(existsSync(join(from, PLUGIN_SOCKET_CARRY_DIR_NAME))).toBe(false);
  });

  it("refuses child-writable directory entries before moving run", async () => {
    const from = join(root, "old");
    const to = join(root, "new");
    await mkdir(join(from, "run"), { recursive: true });
    await mkdir(join(from, "sockets"));
    await mkdir(join(to, "sockets", "nested"), { recursive: true });
    const inode = statSync(join(from, "run")).ino;
    await expect(carryPluginSocketDirs(from, to, { onConflict: "reject" })).rejects.toThrow(/socket entry is a directory/);
    expect(statSync(join(from, "run")).ino).toBe(inode);
    expect(existsSync(join(to, "run"))).toBe(false);
    expect(existsSync(join(to, "sockets", "nested"))).toBe(true);
  });

  it("moves run/ and sockets/ as the same directories and leaves data/ alone", async () => {
    const from = join(root, "old");
    const to = join(root, "new");
    for (const name of [PLUGIN_WORKER_RUN_DIR_NAME, PLUGIN_OWN_SOCKET_DIR_NAME]) {
      await mkdir(join(from, name), { recursive: true });
    }
    await writeFile(join(from, PLUGIN_OWN_SOCKET_DIR_NAME, "egress.sock"), "live");
    await seedPluginDataFixture(from);
    await mkdir(to);
    const inodes = [PLUGIN_WORKER_RUN_DIR_NAME, PLUGIN_OWN_SOCKET_DIR_NAME]
      .map((name) => statSync(join(from, name)).ino);

    await carryPluginSocketDirs(from, to, { onConflict: "reject" });

    expect([PLUGIN_WORKER_RUN_DIR_NAME, PLUGIN_OWN_SOCKET_DIR_NAME].map((name) => statSync(join(to, name)).ino))
      .toEqual(inodes);
    expect(existsSync(join(from, PLUGIN_OWN_SOCKET_DIR_NAME))).toBe(false);
    expect(existsSync(join(from, PLUGIN_WORKER_RUN_DIR_NAME))).toBe(false);
    expect(await readPluginDataFixture(from)).toEqual(PLUGIN_DATA_FIXTURE);
    expect(existsSync(join(to, PLUGIN_DATA_DIR_NAME))).toBe(false);
  });

  it("carries what exists and creates nothing for what does not", async () => {
    const from = join(root, "old");
    const to = join(root, "new");
    await mkdir(join(from, PLUGIN_OWN_SOCKET_DIR_NAME), { recursive: true });
    await mkdir(to);

    await carryPluginSocketDirs(from, to, { onConflict: "reject" });

    expect(existsSync(join(to, PLUGIN_OWN_SOCKET_DIR_NAME))).toBe(true);
    expect(existsSync(join(to, PLUGIN_WORKER_RUN_DIR_NAME))).toBe(false);
  });

  // Which side wins is decided by contents, never by location: a live
  // worker can `mkdir run/<id>` at either root while a swap is in flight.
  it("replaces an EMPTY destination with the source directory itself", async () => {
    const from = join(root, "old");
    const to = join(root, "new");
    await mkdir(join(from, PLUGIN_OWN_SOCKET_DIR_NAME), { recursive: true });
    await writeFile(join(from, PLUGIN_OWN_SOCKET_DIR_NAME, "egress.sock"), "live");
    await mkdir(join(to, PLUGIN_OWN_SOCKET_DIR_NAME), { recursive: true });
    const sourceInode = statSync(join(from, PLUGIN_OWN_SOCKET_DIR_NAME)).ino;

    await carryPluginSocketDirs(from, to, { onConflict: "reject" });

    expect(statSync(join(to, PLUGIN_OWN_SOCKET_DIR_NAME)).ino).toBe(sourceInode);
    expect(existsSync(join(to, PLUGIN_OWN_SOCKET_DIR_NAME, "egress.sock"))).toBe(true);
    expect(existsSync(join(from, PLUGIN_OWN_SOCKET_DIR_NAME))).toBe(false);
  });

  // An EMPTY source is still the directory the running children were wrapped
  // against (a bubblewrap child holds it by bind mount), so it is the
  // destination's entries that move, never the source that is dropped.
  it("keeps an EMPTY source's identity and moves the destination's entries into it", async () => {
    const from = join(root, "old");
    const to = join(root, "new");
    await mkdir(join(from, PLUGIN_WORKER_RUN_DIR_NAME), { recursive: true });
    await mkdir(join(to, PLUGIN_WORKER_RUN_DIR_NAME, "w2"), { recursive: true });
    const sourceInode = statSync(join(from, PLUGIN_WORKER_RUN_DIR_NAME)).ino;
    const w2 = statSync(join(to, PLUGIN_WORKER_RUN_DIR_NAME, "w2")).ino;

    await carryPluginSocketDirs(from, to, { onConflict: "reject" });

    expect(statSync(join(to, PLUGIN_WORKER_RUN_DIR_NAME)).ino).toBe(sourceInode);
    expect(statSync(join(to, PLUGIN_WORKER_RUN_DIR_NAME, "w2")).ino).toBe(w2);
    expect(existsSync(join(from, PLUGIN_WORKER_RUN_DIR_NAME))).toBe(false);
  });

  it.each(["reject", "keep-destination"] as const)(
    "merges two non-empty sides entry by entry under %s, each entry the same directory",
    async (onConflict) => {
      const from = join(root, "old");
      const to = join(root, "new");
      await mkdir(join(from, PLUGIN_WORKER_RUN_DIR_NAME, "w1"), { recursive: true });
      await writeFile(join(from, PLUGIN_WORKER_RUN_DIR_NAME, "w1", "control.sock"), "w1");
      await mkdir(join(to, PLUGIN_WORKER_RUN_DIR_NAME, "w2"), { recursive: true });
      const run = statSync(join(from, PLUGIN_WORKER_RUN_DIR_NAME)).ino;
      const w1 = statSync(join(from, PLUGIN_WORKER_RUN_DIR_NAME, "w1")).ino;
      const w2 = statSync(join(to, PLUGIN_WORKER_RUN_DIR_NAME, "w2")).ino;

      await carryPluginSocketDirs(from, to, onConflict === "reject" ? { onConflict } : keepDestination());

      expect(statSync(join(to, PLUGIN_WORKER_RUN_DIR_NAME)).ino).toBe(run);
      expect(statSync(join(to, PLUGIN_WORKER_RUN_DIR_NAME, "w1")).ino).toBe(w1);
      expect(statSync(join(to, PLUGIN_WORKER_RUN_DIR_NAME, "w2")).ino).toBe(w2);
      expect(existsSync(join(to, PLUGIN_WORKER_RUN_DIR_NAME, "w1", "control.sock"))).toBe(true);
    },
  );

  it("refuses the same entry on both sides under reject", async () => {
    const from = join(root, "old");
    const to = join(root, "new");
    await mkdir(join(from, PLUGIN_OWN_SOCKET_DIR_NAME), { recursive: true });
    await mkdir(join(to, PLUGIN_OWN_SOCKET_DIR_NAME), { recursive: true });
    await writeFile(join(from, PLUGIN_OWN_SOCKET_DIR_NAME, "egress.sock"), "source");
    await writeFile(join(to, PLUGIN_OWN_SOCKET_DIR_NAME, "egress.sock"), "destination");

    await expect(carryPluginSocketDirs(from, to, { onConflict: "reject" }))
      .rejects.toThrow(/both roots hold sockets\/egress\.sock/);

    // Refused before anything moved: both sides exactly as they were.
    expect(readFileSync(join(from, PLUGIN_OWN_SOCKET_DIR_NAME, "egress.sock"), "utf8")).toBe("source");
    expect(readFileSync(join(to, PLUGIN_OWN_SOCKET_DIR_NAME, "egress.sock"), "utf8")).toBe("destination");
  });

  it("keeps the destination's entry for the same name under keep-destination", async () => {
    const from = join(root, "old");
    const to = join(root, "new");
    await mkdir(join(from, PLUGIN_OWN_SOCKET_DIR_NAME), { recursive: true });
    await mkdir(join(to, PLUGIN_OWN_SOCKET_DIR_NAME), { recursive: true });
    await writeFile(join(from, PLUGIN_OWN_SOCKET_DIR_NAME, "egress.sock"), "source");
    await writeFile(join(to, PLUGIN_OWN_SOCKET_DIR_NAME, "egress.sock"), "destination");

    await carryPluginSocketDirs(from, to, keepDestination());

    expect(readFileSync(join(to, PLUGIN_OWN_SOCKET_DIR_NAME, "egress.sock"), "utf8")).toBe("destination");
  });

  // renameDirectory retries a Windows lock on its own; the caller still has
  // to be able to log the contention it no longer wraps.
  it("reports each retried Windows lock through onRetry", async () => {
    const from = join(root, "old");
    const to = join(root, "new");
    await mkdir(join(from, PLUGIN_OWN_SOCKET_DIR_NAME), { recursive: true });
    await mkdir(to);
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    renameLock.lockRenameEndingWith = `${sep}new${sep}${PLUGIN_OWN_SOCKET_DIR_NAME}`;
    const retries: Array<[number, string]> = [];
    try {
      await carryPluginSocketDirs(from, to, {
        onConflict: "reject",
        onRetry: (attempt, code) => retries.push([attempt, code]),
      });
    } finally {
      Object.defineProperty(process, "platform", platform);
      renameLock.lockRenameEndingWith = undefined;
    }

    expect(retries).toEqual([[1, "EBUSY"]]);
    expect(existsSync(join(to, PLUGIN_OWN_SOCKET_DIR_NAME))).toBe(true);
  });

  it("moves nothing under the recovery policy when no destination root survives", async () => {
    const from = join(root, "old");
    await mkdir(join(from, PLUGIN_OWN_SOCKET_DIR_NAME), { recursive: true });

    await carryPluginSocketDirs(from, join(root, "gone"), keepDestination());

    expect(existsSync(join(from, PLUGIN_OWN_SOCKET_DIR_NAME))).toBe(true);
    expect(existsSync(join(root, "gone"))).toBe(false);
  });
});

/**
 * The resolving policy recovery uses. Every conflict must end in a decision:
 * refusing leaves `pendingUpdate` set and the plugin unloadable forever.
 */
describe("carryPluginDataDir — resolving conflict policy", () => {
  let root: string;
  let parked: string[];

  /**
   * `unattributedRoot` names the live install path — the only root a stray
   * write can reach. Whichever side of the carry is under it loses.
   */
  const resolvePolicy = (unattributedRoot: string) => ({
    onConflict: "resolve" as const,
    unattributedRoot,
    moveAside: async (dir: string): Promise<void> => {
      const target = join(root, `parked-${String(parked.length)}`);
      await rename(dir, target);
      parked.push(target);
    },
  });

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "plugin-data-carry-resolve-"));
    parked = [];
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const twoRoots = async (): Promise<{ from: string; to: string }> => {
    const from = join(root, "old");
    const to = join(root, "new");
    await mkdir(from);
    await mkdir(to);
    return { from, to };
  };

  it("removes an empty destination data directory and carries the real one in", async () => {
    const { from, to } = await twoRoots();
    await seedPluginDataFixture(from);
    // Exactly the state a storage call landing in the swap window used to
    // leave at the promoted root: the directory exists and holds nothing.
    await mkdir(join(to, PLUGIN_DATA_DIR_NAME));

    await expect(carryPluginDataDir(from, to, resolvePolicy(to))).resolves.toBe(true);

    expect(await readPluginDataFixture(to)).toEqual(PLUGIN_DATA_FIXTURE);
    expect(existsSync(join(from, PLUGIN_DATA_DIR_NAME))).toBe(false);
    expect(parked).toEqual([]);
  });

  it("keeps a real destination when the source directory is the empty one", async () => {
    const { from, to } = await twoRoots();
    await mkdir(join(from, PLUGIN_DATA_DIR_NAME));
    await seedPluginDataFixture(to);

    await expect(carryPluginDataDir(from, to, resolvePolicy(to))).resolves.toBe(false);

    expect(await readPluginDataFixture(to)).toEqual(PLUGIN_DATA_FIXTURE);
    expect(existsSync(join(from, PLUGIN_DATA_DIR_NAME))).toBe(false);
    expect(parked).toEqual([]);
  });

  it("parks the DESTINATION when the destination is the live path, then carries", async () => {
    const { from, to } = await twoRoots();
    await seedPluginDataFixture(from);
    await mkdir(join(to, PLUGIN_DATA_DIR_NAME), { recursive: true });
    await writeFile(join(to, PLUGIN_DATA_DIR_NAME, "unattributed.bin"), "keep me");

    await expect(carryPluginDataDir(from, to, resolvePolicy(to))).resolves.toBe(true);

    expect(await readPluginDataFixture(to)).toEqual(PLUGIN_DATA_FIXTURE);
    expect(parked).toHaveLength(1);
    expect(await readdir(parked[0]!)).toEqual(["unattributed.bin"]);
  });

  /**
   * The direction that made the source-always-wins rule wrong: when the LIVE
   * path is the carry's source, the destination is a backup holding state a
   * transaction deliberately put there, and it must survive untouched.
   */
  it("parks the SOURCE when the source is the live path, and leaves the destination alone", async () => {
    const { from, to } = await twoRoots();
    await mkdir(join(from, PLUGIN_DATA_DIR_NAME), { recursive: true });
    await writeFile(join(from, PLUGIN_DATA_DIR_NAME, "unattributed.bin"), "keep me");
    await seedPluginDataFixture(to);

    await expect(carryPluginDataDir(from, to, resolvePolicy(from))).resolves.toBe(false);

    expect(await readPluginDataFixture(to)).toEqual(PLUGIN_DATA_FIXTURE);
    expect(existsSync(join(from, PLUGIN_DATA_DIR_NAME))).toBe(false);
    expect(parked).toHaveLength(1);
    expect(await readdir(parked[0]!)).toEqual(["unattributed.bin"]);
  });

  it("refuses a conflict it cannot attribute to either root", async () => {
    const { from, to } = await twoRoots();
    await seedPluginDataFixture(from);
    await mkdir(join(to, PLUGIN_DATA_DIR_NAME), { recursive: true });
    await writeFile(join(to, PLUGIN_DATA_DIR_NAME, "unattributed.bin"), "keep me");

    await expect(
      carryPluginDataDir(from, to, resolvePolicy(join(root, "somewhere-else"))),
    ).rejects.toThrow(/cannot attribute a data directory conflict/);

    expect(await readPluginDataFixture(from)).toEqual(PLUGIN_DATA_FIXTURE);
    expect(parked).toEqual([]);
  });

  it("refuses when moveAside leaves the losing directory in place", async () => {
    const { from, to } = await twoRoots();
    await seedPluginDataFixture(from);
    await mkdir(join(to, PLUGIN_DATA_DIR_NAME), { recursive: true });
    await writeFile(join(to, PLUGIN_DATA_DIR_NAME, "unattributed.bin"), "keep me");

    await expect(carryPluginDataDir(from, to, {
      onConflict: "resolve",
      unattributedRoot: to,
      moveAside: async () => undefined,
    })).rejects.toThrow(/was not moved aside/);

    expect(await readPluginDataFixture(from)).toEqual(PLUGIN_DATA_FIXTURE);
  });
});

describe("pluginPayloadCopyFilter", () => {
  it("excludes every top-level runtime directory and nothing else", () => {
    const pluginRoot = resolve(sep, "plugins", PLUGIN_ID);
    const filter = pluginPayloadCopyFilter(pluginRoot);
    for (const runtimeDir of PLUGIN_RUNTIME_DIR_NAMES) {
      // `run/` and `sockets/` hold live Unix sockets: `cp` over one fails the
      // whole copy with ERR_FS_CP_SOCKET rather than skipping it.
      expect(filter(resolve(pluginRoot, runtimeDir))).toBe(false);
    }
    expect(filter(resolve(pluginRoot, "plugin.json"))).toBe(true);
    expect(filter(resolve(pluginRoot, "dist", PLUGIN_DATA_DIR_NAME))).toBe(true);
    expect(filter(resolve(pluginRoot, "database"))).toBe(true);
  });
});

/**
 * The carry asks the filesystem (`lstat`) and the copy filter compares
 * strings. On a case-folding volume those two must not disagree about `Data/`,
 * or the filter copies a directory the carry then has to reconcile.
 */
describe("isSamePluginPath", () => {
  it("folds case only where the filesystem does", () => {
    const dataDir = resolve(sep, "plugins", PLUGIN_ID, PLUGIN_DATA_DIR_NAME);
    const aliased = resolve(sep, "plugins", PLUGIN_ID, "Data");
    expect(isSamePluginPath(dataDir, aliased, true)).toBe(true);
    expect(isSamePluginPath(dataDir, aliased, false)).toBe(false);
    expect(isSamePluginPath(dataDir, dataDir, false)).toBe(true);
  });

  it("agrees with the filesystem this test is running on", async () => {
    const root = await mkdtemp(join(tmpdir(), "plugin-data-case-"));
    try {
      await mkdir(join(root, PLUGIN_DATA_DIR_NAME));
      const filter = pluginPayloadCopyFilter(root);
      // `existsSync` is the filesystem's own answer; the filter must give the
      // same one, whichever platform this runs on.
      const filesystemSeesAlias = existsSync(join(root, "Data"));
      expect(filter(join(root, "Data"))).toBe(!filesystemSeesAlias);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("isPluginRuntimeDirName", () => {
  it("names every runtime directory, case-insensitively on every platform", () => {
    for (const runtimeDir of PLUGIN_RUNTIME_DIR_NAMES) {
      expect(isPluginRuntimeDirName(runtimeDir)).toBe(true);
      expect(isPluginRuntimeDirName(runtimeDir.toUpperCase())).toBe(true);
    }
    expect(isPluginRuntimeDirName("dist")).toBe(false);
    expect(isPluginRuntimeDirName("database")).toBe(false);
  });
});
