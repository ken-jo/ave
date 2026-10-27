vi.mock("../../shared/windows-path-facts.js", async original => (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedWindowsPathFacts(await original()));
vi.mock("../../shared/windows-configuration-handles.js", async original => (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedConfigurationHandles(await original()));
vi.mock("node:fs", async original => (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedConfigurationFs(await original()));

import { canCreateSymlinks } from "../../__tests__/support/symlink-capability.js";
/** The writable root must be data/, never the plugin root containing executable payload. */
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
  PLUGIN_HOST_STORAGE_DIR_NAME,
  PLUGIN_OWN_SOCKET_DIR_NAME,
  PLUGIN_RUNTIME_DIR_NAMES,
  PLUGIN_SOCKET_CARRY_DIR_NAME,
  PLUGIN_SOCKET_DISCARD_DIR_NAME,
  PLUGIN_WORKER_RUN_DIR_NAME,
  assertUnixSocketPathFits,
  carryPluginStateDirs,
  carryPluginSocketDirs,
  isPluginRuntimeDirName,
  isSamePluginPath,
  assertPayloadOnlyPluginTree,
  pluginPayloadCopyFilter,
  resolvePluginSocketDir,
  resolvePluginWritableRoot,
  sweepPluginSocketDiscardDirs,
  writeGrantsReachingHostStorage,
} from "../plugin-storage-layout.js";
import { _resetConfinedProcessPhaseForTests, noteConfinedProcessesMayRun } from "../../lib/confined-process-phase.js";
import { aveHome } from "../../shared/ave-home.js";
import { isPathWithin, isResolvedPathWithin } from "../plugin-storage-containment.js";
import { isGrantPathWithin, outermostContainingRoots } from "../../permissions/asrt-sandbox.js";
import { PLUGIN_DATA_FIXTURE, makeTestTreeWritable, readPluginDataFixture, seedChildLockedTree, seedPluginDataFixture } from "./test-helpers.js";

/** Inject one transient destination lock; other renames use the real filesystem. */
const renameLock = vi.hoisted(() => ({
  lockRenameEndingWith: undefined as string | undefined,
  /** Runs once, right before the first rename or link into `to` or out of `from`. */
  beforeMove: undefined as { to?: string; from?: string; run: () => Promise<void> } | undefined,
  unlinkFailure: undefined as string | undefined,
  recursiveRms: [] as string[],
  /** One-shot: the entry is removed right before the first lstat of it. */
  vanishOnLstat: undefined as string | undefined,
  /** While set, every rmdir of this directory first gains one more entry. */
  fillOnRmdir: undefined as { dir: string; added: number } | undefined,
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
    lstat: async (...args: Parameters<typeof actual.lstat>) => {
      if (String(args[0]) === renameLock.vanishOnLstat) {
        renameLock.vanishOnLstat = undefined;
        await actual.rm(String(args[0]), { recursive: true, force: true });
      }
      return actual.lstat(...args);
    },
    rmdir: async (path: Parameters<typeof actual.rmdir>[0]) => {
      const fill = renameLock.fillOnRmdir;
      if (fill && String(path) === fill.dir) {
        fill.added += 1;
        await actual.writeFile(`${fill.dir}/late-${fill.added}`, "late");
      }
      return actual.rmdir(path);
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
    // Bare prefix matching would admit a sibling such as /srv/data-evil.
    const root = resolve("/srv", "data");
    expect(isPathWithin(root, `${root}-evil`)).toBe(false);
  });

  it("accepts a descendant of a root that already ends in a separator", () => {
    // A drive root already ends in a separator; appending another would reject contained paths.
    const root = resolve("/srv", "data");
    const rootWithTrailingSeparator = `${root}${sep}`;
    expect(isPathWithin(rootWithTrailingSeparator, under(root, "file.txt"))).toBe(true);
    expect(isPathWithin(rootWithTrailingSeparator, `${root}-evil`)).toBe(false);
  });
});

describe("isResolvedPathWithin", () => {
  it("keeps a directory whose own name begins with two dots", () => {
    // A ..foo segment is a contained name; only a complete .. segment escapes.
    const root = resolve("/srv", "data");
    expect(isResolvedPathWithin(root, resolve(root, "..foo"))).toBe(true);
    expect(isResolvedPathWithin(root, resolve(root, "..foo", "bar.txt"))).toBe(true);
  });

  it("still refuses the real escapes the old predicate caught", () => {
    const root = resolve("/srv", "data");
    expect(isResolvedPathWithin(root, resolve("/srv", "data-evil"))).toBe(false);
    expect(isResolvedPathWithin(root, resolve("/etc", "passwd"))).toBe(false);
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
    // Relative inputs must resolve against cwd.
    expect(isResolvedPathWithin(process.cwd(), "package.json")).toBe(true);
    expect(isResolvedPathWithin(resolve(process.cwd(), "src"), "package.json")).toBe(false);
  });
});

describe("resolvePluginSocketDir", () => {
  it("sits BESIDE the data directory, not inside it", () => {
    // Keep sockets outside data/ so the socket allowance does not cover every writable plugin file.
    const dataDir = resolvePluginWritableRoot(PLUGIN_ID);
    expect(resolvePluginSocketDir(dataDir)).toBe(
      resolve(aveHome(), "plugins", PLUGIN_ID, PLUGIN_OWN_SOCKET_DIR_NAME),
    );
  });

  it("follows a relocated data directory rather than rebuilding from the home", () => {
    // Derive grants from the actual data root so created and confined directories match.
    // Resolve the root to retain the drive on Windows.
    const relocated = resolve("/somewhere/else/plugins/p");
    expect(resolvePluginSocketDir(join(relocated, "data"))).toBe(
      join(relocated, PLUGIN_OWN_SOCKET_DIR_NAME),
    );
  });
});

describe("assertUnixSocketPathFits", () => {
  const limit = process.platform === "darwin" ? 103 : 107;

  it("accepts a path exactly at the limit", () => {
    expect(() => assertUnixSocketPathFits("/".repeat(limit), "probe")).not.toThrow();
  });

  it("refuses one byte over, and says the length rather than leaving EINVAL to explain it", () => {
    // Reject oversized socket paths with a length error before bind returns opaque EINVAL.
    expect(() => assertUnixSocketPathFits("/".repeat(limit + 1), "probe")).toThrow(
      new RegExp(`${String(limit + 1)} bytes`),
    );
    expect(() => assertUnixSocketPathFits("/".repeat(limit + 1), "worker control socket")).toThrow(
      /worker control socket/,
    );
  });

  it("counts BYTES, not characters", () => {
    // Kernel socket-path limits count bytes, not JavaScript characters.
    const multiByte = "가".repeat(Math.ceil(limit / 3));
    expect(multiByte.length).toBeLessThanOrEqual(limit);
    expect(() => assertUnixSocketPathFits(multiByte, "probe")).toThrow(/bytes/);
  });
});

const REJECT = { onConflict: "reject" } as const;

describe("carryPluginStateDirs", () => {
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

    await expect(carryPluginStateDirs(from, to, REJECT)).resolves.toBe(true);

    expect(await readPluginDataFixture(to)).toEqual(PLUGIN_DATA_FIXTURE);
    expect(existsSync(join(from, PLUGIN_DATA_DIR_NAME))).toBe(false);
  });

  it("reports nothing to carry when the source root holds no data directory", async () => {
    const from = join(root, "old");
    const to = join(root, "new");
    await mkdir(from);
    await mkdir(to);

    await expect(carryPluginStateDirs(from, to, REJECT)).resolves.toBe(false);

    expect(existsSync(join(to, PLUGIN_DATA_DIR_NAME))).toBe(false);
  });

  it("refuses to replace a data directory the target root already holds", async () => {
    const from = join(root, "old");
    const to = join(root, "new");
    await mkdir(from);
    await mkdir(to);
    await seedPluginDataFixture(from);
    await seedPluginDataFixture(to);

    await expect(carryPluginStateDirs(from, to, REJECT)).rejects.toThrow(/both roots hold a plugin data directory/);

    expect(await readPluginDataFixture(from)).toEqual(PLUGIN_DATA_FIXTURE);
    expect(await readPluginDataFixture(to)).toEqual(PLUGIN_DATA_FIXTURE);
  });

  it("refuses before moving anything when only the host storage directories collide", async () => {
    const from = join(root, "old");
    const to = join(root, "new");
    await mkdir(from);
    await mkdir(to);
    await seedPluginDataFixture(from);
    await mkdir(join(to, PLUGIN_HOST_STORAGE_DIR_NAME));

    await expect(carryPluginStateDirs(from, to, REJECT)).rejects.toThrow(
      /both roots hold a plugin host storage directory/,
    );

    expect(await readPluginDataFixture(from)).toEqual(PLUGIN_DATA_FIXTURE);
    expect(existsSync(join(to, PLUGIN_DATA_DIR_NAME))).toBe(false);
  });

  it("carries the host storage directory of a plugin that has no data directory", async () => {
    const from = join(root, "old");
    const to = join(root, "new");
    await mkdir(join(from, PLUGIN_HOST_STORAGE_DIR_NAME, "auth"), { recursive: true });
    await writeFile(join(from, PLUGIN_HOST_STORAGE_DIR_NAME, "auth", "token-default.json"), "ENC(token)");
    await mkdir(to);

    await expect(carryPluginStateDirs(from, to, REJECT)).resolves.toBe(true);

    expect(readFileSync(join(to, PLUGIN_HOST_STORAGE_DIR_NAME, "auth", "token-default.json"), "utf-8")).toBe("ENC(token)");
    expect(existsSync(join(from, PLUGIN_HOST_STORAGE_DIR_NAME))).toBe(false);
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
    renameLock.vanishOnLstat = undefined;
    renameLock.fillOnRmdir = undefined;
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
    // Keep an entry host-staged if it left the writable directory before a link refusal.
    expect(statSync(join(from, PLUGIN_SOCKET_CARRY_DIR_NAME, "late")).ino).toBe(carriedInode);
  });

  // macOS link(2) follows symlinks; a child swap must never yield a hard link to an outside file.
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

  // Interrupted staging belongs to the receiving root and must survive directory replacement.
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

  // Recovery must remove malformed child entries without following them so every update reaches a disposition.
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

  // Rename child-writable entries into host-only staging before recursive deletion to prevent link-swap escapes.
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

  // Entries can disappear between readdir and carry; absence is neither failure nor conflict.
  it("treats a socket its child unlinked after readdir as nothing to move", async () => {
    const from = join(root, "old");
    const to = join(root, "new");
    await mkdir(join(from, "sockets"), { recursive: true });
    await mkdir(join(to, "sockets"), { recursive: true });
    const entry = join(to, "sockets", "gone.sock");
    await writeFile(entry, "bound");
    const sockets = statSync(join(from, "sockets")).ino;
    renameLock.beforeMove = { from: entry, run: async () => { await rm(entry); } };

    await carryPluginSocketDirs(from, to, { onConflict: "reject" });

    expect(renameLock.beforeMove).toBeUndefined();
    expect(statSync(join(to, "sockets")).ino).toBe(sockets);
    expect(await readdir(join(to, "sockets"))).toEqual([]);
    expect(existsSync(join(from, PLUGIN_SOCKET_CARRY_DIR_NAME))).toBe(false);
  });

  it("treats a worker leaf removed after readdir as nothing to move", async () => {
    const from = join(root, "old");
    const to = join(root, "new");
    await mkdir(join(from, "run", "w1"), { recursive: true });
    await mkdir(join(to, "run", "w2"), { recursive: true });
    const leaf = join(to, "run", "w2");
    renameLock.beforeMove = { from: leaf, run: async () => { await rm(leaf, { recursive: true }); } };

    await carryPluginSocketDirs(from, to, { onConflict: "reject" });

    expect(renameLock.beforeMove).toBeUndefined();
    expect(await readdir(join(to, "run"))).toEqual(["w1"]);
  });

  it("discards nothing for a replaced source entry its child already removed", async () => {
    const from = join(root, "old");
    const to = join(root, "new");
    await mkdir(join(from, "sockets"), { recursive: true });
    await mkdir(join(to, "sockets"), { recursive: true });
    const replaced = join(from, "sockets", "egress.sock");
    await writeFile(replaced, "source");
    await writeFile(join(to, "sockets", "egress.sock"), "destination");
    renameLock.beforeMove = { from: replaced, run: async () => { await rm(replaced); } };

    await carryPluginSocketDirs(from, to, keepDestination());

    expect(renameLock.beforeMove).toBeUndefined();
    expect(readFileSync(join(to, "sockets", "egress.sock"), "utf8")).toBe("destination");
  });

  it("does not count an entry that vanished before the conflict check as a conflict", async () => {
    const from = join(root, "old");
    const to = join(root, "new");
    await mkdir(join(from, "run", "w1"), { recursive: true });
    await mkdir(join(to, "run", "w1"), { recursive: true });
    const run = statSync(join(from, "run")).ino;
    renameLock.vanishOnLstat = join(to, "run", "w1");

    await carryPluginSocketDirs(from, to, { onConflict: "reject" });

    expect(renameLock.vanishOnLstat).toBeUndefined();
    expect(statSync(join(to, "run")).ino).toBe(run);
    expect(await readdir(join(to, "run"))).toEqual(["w1"]);
  });

  it("refuses nothing for a socket that vanished before preflight inspected it", async () => {
    const from = join(root, "old");
    const to = join(root, "new");
    await mkdir(join(from, "sockets"), { recursive: true });
    await mkdir(join(to, "sockets"), { recursive: true });
    renameLock.vanishOnLstat = join(to, "sockets", "gone.sock");
    await writeFile(join(to, "sockets", "gone.sock"), "bound");

    await carryPluginSocketDirs(from, to, { onConflict: "reject" });

    expect(renameLock.vanishOnLstat).toBeUndefined();
    expect(await readdir(join(to, "sockets"))).toEqual([]);
  });

  // Repeated binds may prevent rmdir; preserve every socket and return a retryable error.
  it("fails clearly, losing nothing, when a live child keeps filling the destination", async () => {
    const from = join(root, "old");
    const to = join(root, "new");
    await mkdir(join(from, "sockets"), { recursive: true });
    await mkdir(join(to, "sockets"), { recursive: true });
    await writeFile(join(to, "sockets", "a.sock"), "a");
    renameLock.fillOnRmdir = { dir: join(to, "sockets"), added: 0 };

    const error = await carryPluginSocketDirs(from, to, { onConflict: "reject" }).then(() => undefined, (caught: unknown) => caught);
    renameLock.fillOnRmdir = undefined;

    expect(String(error)).toMatch(/kept gaining entries from a live process across 3 carry attempts; retry/);
    expect((error as NodeJS.ErrnoException).code).toBe("ENOTEMPTY");
    expect([...await readdir(join(from, "sockets")), ...await readdir(join(to, "sockets"))].sort())
      .toEqual(["a.sock", "late-1", "late-2", "late-3"]);
  });

  // The next carry must finish interrupted host-only discards.
  it("empties a discard directory an interrupted carry left in either root", async () => {
    const from = join(root, "old");
    const to = join(root, "new");
    await mkdir(join(from, "sockets"), { recursive: true });
    await mkdir(join(from, PLUGIN_SOCKET_DISCARD_DIR_NAME, "x-nested"), { recursive: true });
    await writeFile(join(from, PLUGIN_SOCKET_DISCARD_DIR_NAME, "x-nested", "f"), "left");
    await mkdir(join(to, PLUGIN_SOCKET_DISCARD_DIR_NAME), { recursive: true });
    await writeFile(join(to, PLUGIN_SOCKET_DISCARD_DIR_NAME, "y-entry"), "left");

    await carryPluginSocketDirs(from, to, { onConflict: "reject" });

    expect(existsSync(join(from, PLUGIN_SOCKET_DISCARD_DIR_NAME))).toBe(false);
    expect(existsSync(join(to, PLUGIN_SOCKET_DISCARD_DIR_NAME))).toBe(false);
  });

  // A discarded leaf may remain bound into a live worker; recursive deletion waits for boot.
  describe("discards and the confined-process phase", () => {
    afterEach(() => { _resetConfinedProcessPhaseForTests(); });

    it("leaves discarded entries for the boot sweep, which empties them", async () => {
      const from = join(root, "old");
      const to = join(root, "new");
      await mkdir(join(from, "run", "w1"), { recursive: true });
      await writeFile(join(from, "run", "w1", "stale"), "stale");
      await mkdir(join(to, "run", "w1"), { recursive: true });
      await writeFile(join(to, "run", "w1", "control.sock"), "bound");
      await mkdir(join(to, PLUGIN_SOCKET_DISCARD_DIR_NAME, "x-left"), { recursive: true });
      noteConfinedProcessesMayRun();
      renameLock.recursiveRms = [];

      await carryPluginSocketDirs(from, to, keepDestination());

      expect(renameLock.recursiveRms).toEqual([]);
      expect(await readdir(join(to, "run", "w1"))).toEqual(["control.sock"]);
      const discarded = await readdir(join(from, PLUGIN_SOCKET_DISCARD_DIR_NAME));
      expect(discarded).toHaveLength(1);
      expect(discarded[0]).toMatch(/-w1$/);
      expect(await readdir(join(from, PLUGIN_SOCKET_DISCARD_DIR_NAME, discarded[0]!))).toEqual(["stale"]);
      expect(await readdir(join(to, PLUGIN_SOCKET_DISCARD_DIR_NAME))).toEqual(["x-left"]);
      await expect(sweepPluginSocketDiscardDirs(root)).rejects.toThrow(/confined processes may already be running/);

      _resetConfinedProcessPhaseForTests();
      expect((await sweepPluginSocketDiscardDirs(root)).sort()).toEqual([to, from].sort());
      expect(existsSync(join(from, PLUGIN_SOCKET_DISCARD_DIR_NAME))).toBe(false);
      expect(existsSync(join(to, PLUGIN_SOCKET_DISCARD_DIR_NAME))).toBe(false);
      expect(await readdir(join(to, "run", "w1"))).toEqual(["control.sock"]);
    });

    it.runIf(process.platform !== "win32")(
      "empties a discard holding a directory a child made unreadable or, on macOS, immutable",
      async () => {
        const plugin = join(root, "acme");
        const leaf = join(plugin, PLUGIN_SOCKET_DISCARD_DIR_NAME, "x-w1");
        await mkdir(leaf, { recursive: true });
        await seedChildLockedTree(leaf);
        try {
          expect(await sweepPluginSocketDiscardDirs(root)).toEqual([plugin]);
          expect(existsSync(join(plugin, PLUGIN_SOCKET_DISCARD_DIR_NAME))).toBe(false);
        } finally {
          await makeTestTreeWritable(root);
        }
      },
    );

    it.skipIf(!canCreateSymlinks())("empties every other root's discard when one root's discard name is a link", async () => {
      const linked = join(root, "linked");
      const plain = join(root, "plain");
      const outside = join(root, "outside");
      await mkdir(outside);
      await writeFile(join(outside, "foreign"), "untouched");
      await mkdir(linked);
      await symlink(outside, join(linked, PLUGIN_SOCKET_DISCARD_DIR_NAME), "dir");
      await mkdir(join(plain, PLUGIN_SOCKET_DISCARD_DIR_NAME, "x-left"), { recursive: true });

      await expect(sweepPluginSocketDiscardDirs(root)).rejects.toThrow(/1 socket discard/);

      expect(existsSync(join(plain, PLUGIN_SOCKET_DISCARD_DIR_NAME))).toBe(false);
      expect(await readdir(outside)).toEqual(["foreign"]);
    });

    it("leaves a discarded sockets/ directory a child made for the boot sweep", async () => {
      const from = join(root, "old");
      const to = join(root, "new");
      await mkdir(join(from, "sockets"), { recursive: true });
      await mkdir(join(to, "sockets", "nested"), { recursive: true });
      const discarded: string[] = [];
      noteConfinedProcessesMayRun();
      renameLock.recursiveRms = [];

      await carryPluginSocketDirs(from, to, keepDestination(discarded));

      expect(discarded).toEqual([join(to, "sockets", "nested")]);
      expect(renameLock.recursiveRms).toEqual([]);
      const left = await readdir(join(to, PLUGIN_SOCKET_DISCARD_DIR_NAME));
      expect(left).toHaveLength(1);
      expect(left[0]).toMatch(/-nested$/);
    });
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

  // Choose the original directory by contents, not location; live workers can create leaves at either root.
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

  // Even an empty source may be bind-mounted; merge into it without replacing its identity.
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

  // The caller must still observe Windows contention handled by renameDirectory retries.
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

/** Recovery must resolve every conflict or pendingUpdate prevents the plugin from loading. */
describe("carryPluginStateDirs — resolving conflict policy", () => {
  let root: string;
  let parked: string[];

  /** unattributedRoot is the stray-writable live path; whichever side is under it loses. */
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
    await mkdir(join(to, PLUGIN_DATA_DIR_NAME));

    await expect(carryPluginStateDirs(from, to, resolvePolicy(to))).resolves.toBe(true);

    expect(await readPluginDataFixture(to)).toEqual(PLUGIN_DATA_FIXTURE);
    expect(existsSync(join(from, PLUGIN_DATA_DIR_NAME))).toBe(false);
    expect(parked).toEqual([]);
  });

  it("resolves each state directory on its own: an empty destination storage/ goes, the real one comes in", async () => {
    const { from, to } = await twoRoots();
    await seedPluginDataFixture(from);
    await mkdir(join(to, PLUGIN_HOST_STORAGE_DIR_NAME));

    await expect(carryPluginStateDirs(from, to, resolvePolicy(to))).resolves.toBe(true);

    expect(await readPluginDataFixture(to)).toEqual(PLUGIN_DATA_FIXTURE);
    expect(existsSync(join(from, PLUGIN_HOST_STORAGE_DIR_NAME))).toBe(false);
    expect(parked).toEqual([]);
  });

  it("keeps a real destination when the source directory is the empty one", async () => {
    const { from, to } = await twoRoots();
    await mkdir(join(from, PLUGIN_DATA_DIR_NAME));
    await seedPluginDataFixture(to);

    await expect(carryPluginStateDirs(from, to, resolvePolicy(to))).resolves.toBe(false);

    expect(await readPluginDataFixture(to)).toEqual(PLUGIN_DATA_FIXTURE);
    expect(existsSync(join(from, PLUGIN_DATA_DIR_NAME))).toBe(false);
    expect(parked).toEqual([]);
  });

  it("parks the DESTINATION when the destination is the live path, then carries", async () => {
    const { from, to } = await twoRoots();
    await seedPluginDataFixture(from);
    await mkdir(join(to, PLUGIN_DATA_DIR_NAME), { recursive: true });
    await writeFile(join(to, PLUGIN_DATA_DIR_NAME, "unattributed.bin"), "keep me");

    await expect(carryPluginStateDirs(from, to, resolvePolicy(to))).resolves.toBe(true);

    expect(await readPluginDataFixture(to)).toEqual(PLUGIN_DATA_FIXTURE);
    expect(parked).toHaveLength(1);
    expect(await readdir(parked[0]!)).toEqual(["unattributed.bin"]);
  });

  /** When the live path is the source, the destination backup remains authoritative. */
  it("parks the SOURCE when the source is the live path, and leaves the destination alone", async () => {
    const { from, to } = await twoRoots();
    await mkdir(join(from, PLUGIN_DATA_DIR_NAME), { recursive: true });
    await writeFile(join(from, PLUGIN_DATA_DIR_NAME, "unattributed.bin"), "keep me");
    await seedPluginDataFixture(to);

    await expect(carryPluginStateDirs(from, to, resolvePolicy(from))).resolves.toBe(false);

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
      carryPluginStateDirs(from, to, resolvePolicy(join(root, "somewhere-else"))),
    ).rejects.toThrow(/cannot attribute a data directory conflict/);

    expect(await readPluginDataFixture(from)).toEqual(PLUGIN_DATA_FIXTURE);
    expect(parked).toEqual([]);
  });

  it("refuses when moveAside leaves the losing directory in place", async () => {
    const { from, to } = await twoRoots();
    await seedPluginDataFixture(from);
    await mkdir(join(to, PLUGIN_DATA_DIR_NAME), { recursive: true });
    await writeFile(join(to, PLUGIN_DATA_DIR_NAME, "unattributed.bin"), "keep me");

    await expect(carryPluginStateDirs(from, to, {
      onConflict: "resolve",
      unattributedRoot: to,
      moveAside: async () => undefined,
    })).rejects.toThrow(/was not moved aside/);

    expect(await readPluginDataFixture(from)).toEqual(PLUGIN_DATA_FIXTURE);
  });
});

// Immediate deletion requires a payload-only root; runtime directories must refuse it.
describe("assertPayloadOnlyPluginTree", () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "payload-only-")); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it("accepts payload and a missing tree", async () => {
    await writeFile(join(root, "plugin.json"), "{}");
    await mkdir(join(root, "dist"));
    await expect(assertPayloadOnlyPluginTree(root)).resolves.toBeUndefined();
    await expect(assertPayloadOnlyPluginTree(join(root, "absent"))).resolves.toBeUndefined();
  });

  it.each([...PLUGIN_RUNTIME_DIR_NAMES])("refuses a tree holding %s/", async (name) => {
    await mkdir(join(root, name));
    await expect(assertPayloadOnlyPluginTree(root)).rejects.toThrow(new RegExp(`holds runtime directory ${name}/`));
  });
});

describe("pluginPayloadCopyFilter", () => {
  it("excludes every top-level runtime directory and nothing else", () => {
    const pluginRoot = resolve(sep, "plugins", PLUGIN_ID);
    const filter = pluginPayloadCopyFilter(pluginRoot);
    for (const runtimeDir of PLUGIN_RUNTIME_DIR_NAMES) {
      // Copying live Unix sockets fails with ERR_FS_CP_SOCKET; exclude run/ and sockets/.
      expect(filter(resolve(pluginRoot, runtimeDir))).toBe(false);
    }
    expect(filter(resolve(pluginRoot, "plugin.json"))).toBe(true);
    expect(filter(resolve(pluginRoot, "dist", PLUGIN_DATA_DIR_NAME))).toBe(true);
    expect(filter(resolve(pluginRoot, "database"))).toBe(true);
  });
});

/** String-based copy filters must agree with lstat on case-folding volumes. */
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
      const filesystemSeesAlias = existsSync(join(root, "Data"));
      expect(filter(join(root, "Data"))).toBe(!filesystemSeesAlias);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("outermostContainingRoots", () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "outermost-roots-")); });
  afterEach(async () => {
    await rm(join(root, "data", "link"), { force: true }).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });

  it("hands a grant the envelope root, never a component the plugin can turn into a link", async () => {
    // A child can repoint data/link; an access grant must not follow it outside the allowed roots.
    const data = join(root, "data");
    const outside = join(root, "outside");
    await mkdir(data);
    await mkdir(outside);
    await symlink(outside, join(data, "link"), process.platform === "win32" ? "junction" : "dir");
    const sockets = join(root, "sockets");
    await mkdir(sockets);
    const chosenInData = join(data, "index");

    const throughLink = [join(data, "link", "segments"), join(data, "link")];
    const roots = [data, sockets, chosenInData];
    // Windows admission checks canonical paths so repointed links cannot receive outside grants.
    // Other platforms use lexical containment.
    const granted = process.platform === "win32"
      ? outermostContainingRoots([chosenInData, join(sockets, "a.sock")], roots)
      : outermostContainingRoots([throughLink[0]!, chosenInData, join(sockets, "a.sock"), throughLink[1]!], roots);
    if (process.platform === "win32") {
      expect(() => outermostContainingRoots(throughLink, roots)).toThrow(/lies under none/);
    }

    expect(granted).toEqual([data, sockets]);
    for (const path of granted) expect((await lstat(path)).isSymbolicLink()).toBe(false);
  });

  it("refuses a path no root contains", () => {
    expect(() => outermostContainingRoots([resolve(sep, "elsewhere")], [resolve(sep, "ave", "data")])).toThrow(/lies under none/);
  });

  describe("on Windows, where a root's spelling is not its identity", () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    beforeEach(() => { Object.defineProperty(process, "platform", { value: "win32" }); });
    afterEach(() => { Object.defineProperty(process, "platform", platform); });

    it("takes a case-variant spelling of a nested root for the root it is inside", async () => {
      // Case-folded DATA/work belongs to data/ and must not become a separately grantable root.
      const data = join(root, "data");
      await mkdir(join(data, "work"), { recursive: true });
      const variant = join(root, "DATA", "work");

      expect(outermostContainingRoots([join(variant, "segments"), variant], [data, variant])).toEqual([data]);
      expect(isGrantPathWithin(data, join(variant, "segments"))).toBe(true);
    });

    it("still refuses a look-alike sibling of a root", () => {
      expect(isGrantPathWithin(join(root, "data"), join(root, "DATA-other"))).toBe(false);
    });
  });
});

describe("writeGrantsReachingHostStorage", () => {
  const pluginRoot = resolve(sep, "ave", "plugins", "acme");
  const dataDir = join(pluginRoot, PLUGIN_DATA_DIR_NAME);
  const storage = join(pluginRoot, PLUGIN_HOST_STORAGE_DIR_NAME);

  it("names the storage directory, anything in it, and every ancestor of it", () => {
    const reaching = [storage, join(storage, "auth"), pluginRoot, resolve(pluginRoot, ".."), resolve(sep)];
    expect(writeGrantsReachingHostStorage(dataDir, reaching)).toEqual(reaching);
  });

  it("passes the child's own directories and a look-alike sibling", () => {
    const own = [dataDir, join(dataDir, "index"), join(pluginRoot, PLUGIN_OWN_SOCKET_DIR_NAME), `${storage}-other`, resolve(sep, "elsewhere")];
    expect(writeGrantsReachingHostStorage(dataDir, own)).toEqual([]);
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
