import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, parse, resolve } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { aveHome } from "../../../shared/ave-home.js";
import { createHostGit, type HostGit } from "../host-git.js";
import type { OwnedDir } from "../owned-fs.js";
import { createStageWorkspaceProvider } from "../stage-workspaces.js";
import { JOIN_DIR, OUT_DIR, RUN_FILE, runRootOf, runSlug } from "../workspace-layout.js";
import { removeLink, stageOf } from "./stage-fixtures.js";
import { type GitFixture, type GitHandle, gitFixture, sealed, stageRoot } from "./stage-git-fixture.js";

/** Runs before the run folder is made in its project folder, with that folder's path: where another process's release can come between. */
const between = vi.hoisted(() => ({
  act: undefined as ((projectFolder: string) => void) | undefined,
  /** Runs right after an entry of a held folder was removed, with the entry's path. */
  removed: undefined as ((path: string) => void) | undefined,
  /** A home on a share: the run folder as the host reached it, the volume it is really on, and the share that stands for that volume. */
  share: undefined as { run: string; volume: string; root: string; git?: string } | undefined,
  /** Every path off this machine the disk was asked about; none of them is really asked. */
  foreign: [] as string[],
  /** Every path the disk was asked which directory it is. */
  asked: [] as string[],
  /** The home as the host names it, when that is not the path the test's home is at. */
  home: undefined as string | undefined,
  /** The name of a held folder whose listing fails. */
  unlisted: undefined as string | undefined,
  /** Runs right after a held folder was listed, with its path. */
  listed: undefined as ((path: string) => void) | undefined,
  /** Runs right after a held folder gave one of its folders by the identity recorded for it, with that folder's path. */
  child: undefined as ((path: string | undefined) => void) | undefined,
  /** A path the disk gives no answer about. */
  unread: undefined as string | undefined,
  /** A file that cannot be opened. */
  unopened: undefined as string | undefined,
  configHandle: undefined as ((path: string, handle: FileHandle) => void) | undefined,
  configIdentified: undefined as ((path: string) => void) | undefined,
  configOpening: undefined as ((path: string) => void) | undefined,
}));

vi.mock("../../../shared/ave-home.js", async (original) => {
  const real = await original<typeof import("../../../shared/ave-home.js")>();
  return { ...real, aveHome: () => between.home ?? real.aveHome() };
});

vi.mock("node:fs", async (original) => {
  const real = await original<typeof import("node:fs")>();
  const native = (path: string): string => {
    const found = real.realpathSync.native(path);
    return between.share !== undefined && (between.share.run === path || between.share.git === found) ? between.share.root + found.slice(between.share.volume.length) : found;
  };
  const lstatSync = ((path: string, options?: object) => {
    if (between.unread !== undefined && String(path).toLowerCase() === between.unread.toLowerCase()) throw Object.assign(new Error("fixture: the path cannot be read"), { code: "EACCES" });
    return real.lstatSync(path, options as never);
  }) as typeof real.lstatSync;
  const openSync = ((path: string, ...rest: unknown[]) => {
    if (between.unopened !== undefined && String(path).toLowerCase() === between.unopened.toLowerCase()) throw Object.assign(new Error("fixture: the file cannot be opened"), { code: "EACCES" });
    return (real.openSync as (...args: unknown[]) => number)(path, ...rest);
  }) as typeof real.openSync;
  return { ...real, lstatSync, openSync, realpathSync: Object.assign((path: string) => real.realpathSync(path), { native }) };
});

vi.mock("node:fs/promises", async (original) => {
  const real = await original<typeof import("node:fs/promises")>();
  const open: typeof real.open = async (file, flags, mode) => {
    between.configOpening?.(String(file));
    const handle = await real.open(file, flags, mode);
    between.configHandle?.(String(file), handle);
    return handle;
  };
  return { ...real, open };
});

vi.mock("../owned-fs.js", async (original) => {
  const real = await original<typeof import("../owned-fs.js")>();
  const held = (dir: OwnedDir, depth: number): OwnedDir => new Proxy(dir, {
    get(target, key) {
      if (key === "ensure") return (name: string) => held(target.ensure(name), depth + 1);
      if (key === "existing") return (name: string) => { const found = target.existing(name); return found === undefined ? undefined : held(found, depth + 1); };
      if (key === "remove") return async (name: string, expect?: string) => { await target.remove(name, expect); between.removed?.(join(target.path, name)); };
      if (key === "make" && depth === 2) return (name: string) => { between.act?.(target.path); return target.make(name); };
      if (key === "list" && between.unlisted === basename(target.path)) return () => { throw Object.assign(new Error("fixture: the folder cannot be listed"), { code: "EACCES" }); };
      if (key === "child") return (name: string, id: string) => { const found = target.child(name, id); between.child?.(found?.path); return found; };
      if (key === "entryId") return (name: string) => {
        const id = target.entryId(name);
        if (name === "config" && id !== undefined) between.configIdentified?.(join(target.path, name));
        return id;
      };
      if (key === "list") return () => { const names = target.list(); between.listed?.(target.path); return names; };
      const value = Reflect.get(target, key) as unknown;
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
  // What is asked of the share is answered by the volume behind it.
  const local = (path: string): string => {
    const share = between.share;
    return share !== undefined && path.toLowerCase().startsWith(share.root) ? share.volume + path.slice(share.root.length) : path;
  };
  const asked = (path: string): string | undefined => {
    between.asked.push(path);
    const at = local(path);
    if (!/^[\\/]{2}/u.test(at)) return at;
    between.foreign.push(path);
    return undefined;
  };
  const answer = <T>(path: string, ask: (path: string) => T): T | undefined => { const at = asked(path); return at === undefined ? undefined : ask(at); };
  return {
    ...real,
    holdDir: (path: string, id?: string) => {
      const at = asked(path);
      if (at === undefined) throw new real.OwnedFsError("not-plain", "not on this machine");
      return held(real.holdDir(at, id), 0);
    },
    nodeIdOf: (path: string) => answer(path, real.nodeIdOf),
    realDirId: (path: string, unread?: "known") => answer(path, at => real.realDirId(at, unread)),
  };
});

let base: string;
const hostGit = (): HostGit => createHostGit({ env: { ...process.env, GIT_CONFIG_GLOBAL: join(base, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1" } });
const run = (): { itemId: number; runId: string; runKey: string } => ({ itemId: 7, runId: `run-race-${process.pid}-${Date.now()}`, runKey: "key" });

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "swr-"));
  mkdirSync(join(base, "project"));
  writeFileSync(join(base, "gitconfig"), "");
});

afterEach(() => {
  between.act = undefined;
  between.removed = undefined;
  between.share = undefined;
  between.home = undefined;
  between.unlisted = undefined;
  between.listed = undefined;
  between.child = undefined;
  between.unread = undefined;
  between.foreign.length = 0;
  between.asked.length = 0;
  rmSync(base, { recursive: true, force: true, maxRetries: 3 });
});

it("an open whose project folder another run's release took away makes it again", async () => {
  const provider = createStageWorkspaceProvider({ plainCeiling: base, git: hostGit() });
  const opening = run();
  let taken = 0;
  between.act = (projectFolder) => {
    if (taken++ === 0) rmdirSync(projectFolder);
  };
  expect(await provider.open(opening, join(base, "project"))).toMatchObject({ ok: true });
  expect(taken).toBe(2);
  await provider.release(opening, "all");
});

it("an open whose project folder keeps going away is refused as unavailable, not as an unsafe home", async () => {
  between.act = projectFolder => rmdirSync(projectFolder);
  expect(await createStageWorkspaceProvider({ plainCeiling: base, git: hostGit() }).open(run(), join(base, "project"))).toEqual({ ok: false, code: "workspace-unavailable" });
});

it("an open whose worktrees folder is swapped for another while the run folder is made is refused as an unsafe home", async () => {
  const home = join(base, "home");
  mkdirSync(home);
  const before = process.env.AVE_HOME;
  process.env.AVE_HOME = home;
  let swaps = 0;
  between.act = (projectFolder) => {
    const worktrees = dirname(projectFolder);
    renameSync(worktrees, join(base, `away-${swaps++}`));
    mkdirSync(worktrees);
  };
  try {
    expect(await createStageWorkspaceProvider({ plainCeiling: base, git: hostGit() }).open(run(), join(base, "project"))).toEqual({ ok: false, code: "home-boundary-unverified" });
    // Nothing is made in the folder that took the name.
    expect(swaps).toBe(1);
    expect(readdirSync(join(home, "worktrees"))).toEqual([]);
  } finally {
    if (before === undefined) delete process.env.AVE_HOME; else process.env.AVE_HOME = before;
  }
});

/** A run whose record went and that has no folder: what was held for it is told as used. */
const gone = "run-gone";
const givenGone = (): Map<string, { projectRoot: string; itemId: number }> => new Map([[gone, { projectRoot: join(base, "project"), itemId: 7 }]]);

it.each([
  ["a project's folder", (worktrees: string) => join(worktrees, "fixture-file")],
  ["the run's own folder", (worktrees: string) => join(worktrees, "fixture-project", runSlug(7, gone))],
])("a plain file where %s would be holds no run and keeps no root", async (_where, at) => {
  const provider = createStageWorkspaceProvider({ plainCeiling: base, git: hostGit(), removable: async () => () => false });
  const worktrees = join(aveHome(), "worktrees");
  const project = join(worktrees, "fixture-project");
  mkdirSync(project, { recursive: true });
  try {
    expect(await provider.discard(givenGone())).toEqual([gone]);
    writeFileSync(at(worktrees), "");
    try {
      expect(await provider.discard(givenGone())).toEqual([gone]);
    } finally {
      rmSync(at(worktrees));
    }
  } finally {
    rmSync(project, { recursive: true });
  }
});

it("a link under worktrees, or a worktrees that cannot be listed, may hold any run's: every root is kept", async () => {
  const provider = createStageWorkspaceProvider({ plainCeiling: base, git: hostGit(), removable: async () => () => false });
  const worktrees = join(aveHome(), "worktrees");
  const project = join(worktrees, "fixture-project");
  mkdirSync(project, { recursive: true });
  try {
    const link = join(worktrees, "fixture-link");
    mkdirSync(join(base, "outside"));
    symlinkSync(join(base, "outside"), link, "junction");
    try {
      expect(await provider.discard(givenGone())).toEqual([]);
    } finally {
      removeLink(link, aveHome());
    }
    between.unlisted = "worktrees";
    expect(await provider.discard(givenGone())).toEqual([]);
    between.unlisted = undefined;
    expect(await provider.discard(givenGone())).toEqual([gone]);
  } finally {
    rmSync(project, { recursive: true });
  }
});

it.each(["worktrees", "fixture-project"])("a %s that is no longer the folder that was listed holds what is not known: a file where the folder that took its place has one keeps the root", async (level) => {
  const home = join(base, "home");
  const worktrees = join(home, "worktrees");
  const project = join(worktrees, "fixture-project");
  // A folder with the run's name and no record: the run's own, for all that can be read of it.
  mkdirSync(join(project, runSlug(7, gone)), { recursive: true });
  const before = process.env.AVE_HOME;
  process.env.AVE_HOME = home;
  let swaps = 0;
  between.listed = (path) => {
    if (basename(path) !== level || swaps++ > 0) return;
    renameSync(path, join(base, "away"));
    mkdirSync(path);
    // Where the listed folder held a folder, the one that took its name holds a file.
    writeFileSync(join(path, level === "worktrees" ? "fixture-project" : runSlug(7, gone)), "");
  };
  try {
    expect(await createStageWorkspaceProvider({ plainCeiling: base, git: hostGit(), removable: async () => () => false }).discard(givenGone())).toEqual([]);
    expect(swaps).toBe(1);
  } finally {
    if (before === undefined) delete process.env.AVE_HOME; else process.env.AVE_HOME = before;
  }
});

it("an output folder that is no longer the one the run made tells nothing of a file in it: a path two stages answer is not told as left open there", async () => {
  const provider = createStageWorkspaceProvider({ plainCeiling: base, git: hostGit() });
  const opening = run();
  const open = await provider.open(opening, join(base, "project"));
  if (!open.ok) throw new Error(open.code);
  const out = join(open.workspace.runRoot, OUT_DIR);
  const away = join(base, "away-out");
  try {
    for (const stageId of ["s1", "s2"]) {
      const prepared = await provider.prepare(opening, stageOf(stageId), 1);
      if (!prepared.ok) throw new Error(prepared.code);
      writeFileSync(join(prepared.workspace.root, "report.md"), `from ${stageId}`);
      expect(await provider.seal(opening, stageId)).toEqual({ ok: true });
    }
    let swaps = 0;
    between.child = (path) => {
      if (path === undefined || basename(path) !== OUT_DIR || swaps++ > 0) return;
      renameSync(path, away);
      mkdirSync(path);
    };
    // The user's own file at the path would settle it; whether the folder the run made holds one is not known.
    expect(await provider.integrate(opening, "j1", ["s1", "s2"]).then(result => result.ok ? "collected" : result.conflict.reason, () => "refused")).toBe("refused");
    expect(swaps).toBe(1);
  } finally {
    between.child = undefined;
    if (existsSync(away)) {
      rmdirSync(out);
      renameSync(away, out);
    }
    await provider.release(opening, "all");
  }
});

it("a project's folder that cannot be listed keeps every root, and the runs of the other projects still go", async () => {
  const first = run();
  const runs = [first, { ...first, runId: `${first.runId}-second` }];
  const provider = createStageWorkspaceProvider({ plainCeiling: base, git: hostGit(), removable: async () => at => runs.some(one => one.runId === at.runId) });
  mkdirSync(join(base, "second"));
  const roots: string[] = [];
  for (const [index, project] of ["project", "second"].entries()) {
    const open = await provider.open(runs[index] as typeof first, join(base, project));
    if (!open.ok) throw new Error(open.code);
    roots.push(open.workspace.runRoot);
  }
  try {
    // The project listed first is the one that cannot be read: the other one's run comes after it.
    const listed = readdirSync(dirname(dirname(roots[0] as string)));
    const order = (index: number): number => listed.indexOf(basename(dirname(roots[index] as string)));
    const [unlisted, read] = order(0) < order(1) ? [0, 1] : [1, 0];
    const gone = "run-gone";
    const given = new Map([[gone, { projectRoot: join(base, "project"), itemId: 7 }]]);
    between.unlisted = basename(dirname(roots[unlisted] as string));
    expect(await provider.discard(given)).toEqual([runs[read]?.runId]);
    expect(roots.map(root => existsSync(root))).toEqual(unlisted === 0 ? [true, false] : [false, true]);
    between.unlisted = undefined;
    expect(await provider.discard(given)).toEqual([runs[unlisted]?.runId, gone]);
    expect(roots.map(root => existsSync(root))).toEqual([false, false]);
  } finally {
    between.unlisted = undefined;
    for (const one of runs) await provider.release(one, "all");
  }
});

it("a project root the disk gives no answer about may still be the recorded one: a release then leaves the whole run, and takes it apart once the root is read", async () => {
  const fx = gitFixture();
  try {
    const handle = fx.start();
    const open = await handle.provider.open(handle.run, fx.repo);
    if (!open.ok) throw new Error("expected a workspace");
    const stage = await stageRoot(handle, "s1");
    between.unread = realpathSync.native(fx.repo);
    await handle.provider.release(handle.run, "all");
    between.unread = undefined;
    expect([existsSync(stage), existsSync(join(open.workspace.runRoot, RUN_FILE))]).toEqual([true, true]);
    await handle.provider.release(handle.run, "all");
    expect(existsSync(open.workspace.runRoot)).toBe(false);
  } finally {
    between.unread = undefined;
    await fx.done();
  }
});

it("a registration whose ownership cannot be read may still be the run's own: a release leaves the whole run, and takes it apart once it is read", async () => {
  const fx = gitFixture();
  try {
    const handle = fx.start();
    const open = await handle.provider.open(handle.run, fx.repo);
    if (!open.ok) throw new Error("expected a workspace");
    const stage = await stageRoot(handle, "s1");
    const admin = realpathSync.native(resolve(stage, readFileSync(join(stage, ".git"), "utf8").replace(/^gitdir: /u, "").trim()));
    between.unopened = join(admin, "gitdir");
    await handle.provider.release(handle.run, "all");
    between.unopened = undefined;
    expect([existsSync(stage), existsSync(admin), existsSync(join(open.workspace.runRoot, RUN_FILE))]).toEqual([true, true, true]);
    await handle.provider.release(handle.run, "all");
    expect([existsSync(open.workspace.runRoot), existsSync(admin)]).toEqual([false, false]);
  } finally {
    between.unopened = undefined;
    await fx.done();
  }
});

it("a registration whose stage name another folder took after the removal stays, and goes once the name is free", async () => {
  const fx = gitFixture();
  try {
    const handle = fx.start();
    const open = await handle.provider.open(handle.run, fx.repo);
    if (!open.ok) throw new Error("expected a workspace");
    const stage = await stageRoot(handle, "s1");
    const record = (): { registrations: Record<string, { admin: string }> } => JSON.parse(readFileSync(join(open.workspace.runRoot, RUN_FILE), "utf8"));
    const admin = record().registrations.s1?.admin as string;
    expect(existsSync(admin)).toBe(true);
    between.removed = (path) => { if (path === stage) mkdirSync(path); };
    await expect(handle.provider.release(handle.run, ["s1"])).rejects.toThrow("a folder the run did not make");
    between.removed = undefined;
    expect(existsSync(admin)).toBe(true);
    expect(record().registrations.s1?.admin).toBe(admin);
    expect(readdirSync(stage)).toEqual([]);
    // The other folder is not the run's to remove; with the name free again the registration goes.
    rmdirSync(stage);
    await handle.provider.release(handle.run, ["s1"]);
    expect(existsSync(admin)).toBe(false);
    expect(record().registrations.s1).toBeUndefined();
  } finally {
    between.removed = undefined;
    await fx.done();
  }
});

it.skipIf(process.platform !== "win32")("a home on a share keeps the registration git wrote with the share's path", async () => {
  const fx = gitFixture();
  try {
    const handle = fx.start();
    const open = await handle.provider.open(handle.run, fx.repo);
    if (!open.ok) throw new Error("expected a workspace");
    const stage = await stageRoot(handle, "s1");
    const recordPath = join(open.workspace.runRoot, RUN_FILE);
    const record = JSON.parse(readFileSync(recordPath, "utf8")) as { registrations: Record<string, { admin: string; gitdir: string }> };
    const admin = record.registrations.s1?.admin as string;
    const joined = record.registrations[JOIN_DIR] as { gitdir: string };
    const local = joined.gitdir;
    const real = realpathSync.native(stage);
    const volume = parse(real).root;
    between.share = { run: open.workspace.runRoot, volume, root: "\\\\server\\share\\" };
    // As git leaves it on a share, with a stop before the host recorded it: the admin folder names the stage by the share's path.
    writeFileSync(join(admin, "gitdir"), `//server/share/${real.slice(volume.length).replaceAll("\\", "/")}/.git\n`);
    delete record.registrations.s1;
    // The integration folder's registration is recorded by the share's path as well: the run folder is really there.
    joined.gitdir = `\\\\server\\share\\${join(dirname(real), JOIN_DIR, ".git").slice(volume.length)}`;
    writeFileSync(recordPath, JSON.stringify(record));
    try {
      await handle.provider.release(handle.run, ["s1"]);
      expect(existsSync(stage)).toBe(false);
      expect(existsSync(admin)).toBe(false);
    } finally {
      const left = JSON.parse(readFileSync(recordPath, "utf8")) as typeof record;
      (left.registrations[JOIN_DIR] as { gitdir: string }).gitdir = local;
      writeFileSync(recordPath, JSON.stringify(left));
    }
  } finally {
    between.share = undefined;
    await fx.done();
  }
});

interface Recorded {
  project: { root: string };
  repo: { gitDir: string };
  registrations: Record<string, { admin: string; gitdir: string }>;
  stages: Record<string, { link?: string }>;
}
const onWindows = it.skipIf(process.platform !== "win32");
/** Git hides the link file, and a hidden file is not written over: it is put there anew. */
const relink = (stage: string, link: string): void => { rmSync(join(stage, ".git")); writeFileSync(join(stage, ".git"), link); };
const slashed = (path: string, volume: string): string => path.slice(volume.length).replaceAll("\\", "/");

it.each([
  "missing", "readable", "replaced", "over-cap", "timeout", "incomplete", "replaced-after-id", "replaced-during-open",
] as const)("partial release verifies a %s repository config before removing its stage", async (scenario) => {
  const fx = gitFixture();
  const config = join(fx.repo, ".git", "config");
  const saved = join(fx.repo, ".git", "config-saved");
  const real = createHostGit({ env: fx.env });
  let replaceOnRead = false;
  let queries = 0;
  const read = vi.fn();
  const pending = Promise.withResolvers<{ bytesRead: number; buffer: Buffer }>();
  const closed = Promise.withResolvers<void>();
  const replace = (): void => { renameSync(config, saved); writeFileSync(config, readFileSync(saved)); };
  const git: HostGit = { ...real, run: (cwd, args, call) => {
    if (args.includes("extensions.refStorage")) queries += 1;
    if (replaceOnRead && args.includes("extensions.refStorage")) {
      replaceOnRead = false;
      replace();
    }
    return real.run(cwd, args, call);
  } };
  try {
    const handle = fx.start({ git });
    const open = await handle.provider.open(handle.run, fx.repo);
    if (!open.ok) throw new Error(open.code);
    const stage = await stageRoot(handle, "s1");
    const record = JSON.parse(readFileSync(join(open.workspace.runRoot, RUN_FILE), "utf8")) as Recorded;
    const admin = record.registrations.s1?.admin;
    if (admin === undefined) throw new Error("expected a stage registration");
    expect(readFileSync(config, "utf8")).not.toMatch(/refStorage/iu);
    if (scenario === "missing") renameSync(config, saved);
    if (scenario === "over-cap") {
      renameSync(config, saved);
      writeFileSync(config, readFileSync(saved, "utf8") + "# fixture\n".repeat(110_000));
    }
    if (scenario === "replaced-after-id") between.configIdentified = (file) => {
      if (file !== config) return;
      between.configIdentified = undefined;
      replace();
    };
    if (scenario === "replaced-during-open") between.configOpening = (file) => {
      if (file !== config) return;
      between.configOpening = undefined;
      replace();
    };
    if (scenario === "timeout" || scenario === "incomplete") {
      if (scenario === "timeout") vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      between.configHandle = (file, handle) => {
        if (file !== config) return;
        const close = handle.close.bind(handle);
        vi.spyOn(handle, "close").mockImplementation(async () => {
          await close();
          closed.resolve();
        });
        vi.spyOn(handle, "read").mockImplementation(() => {
          read();
          if (scenario === "incomplete") return Promise.resolve({ bytesRead: 0, buffer: Buffer.alloc(0) });
          queueMicrotask(() => vi.advanceTimersByTime(120_000));
          return pending.promise;
        });
      };
    }
    replaceOnRead = scenario === "replaced";
    queries = 0;
    if (scenario === "readable") {
      await handle.provider.release(handle.run, ["s1"]);
      expect([existsSync(stage), existsSync(admin)]).toEqual([false, false]);
    } else {
      await expect(handle.provider.release(handle.run, ["s1"])).rejects.toThrow("repo.refStorage");
      expect([existsSync(stage), existsSync(admin)]).toEqual([true, true]);
      expect(queries).toBe(scenario === "replaced" ? 1 : 0);
      if (scenario === "timeout" || scenario === "incomplete") {
        expect(read).toHaveBeenCalledOnce();
        pending.resolve({ bytesRead: 0, buffer: Buffer.alloc(0) });
        await closed.promise;
        expect(queries).toBe(0);
      } else {
        expect(existsSync(saved)).toBe(true);
      }
    }
  } finally {
    between.configHandle = undefined;
    between.configIdentified = undefined;
    between.configOpening = undefined;
    vi.useRealTimers();
    pending.resolve({ bytesRead: 0, buffer: Buffer.alloc(0) });
    if (existsSync(saved)) {
      rmSync(config, { force: true });
      renameSync(saved, config);
    }
    await fx.done();
  }
});

it("reads repository configuration without synchronous bulk file I/O", () => {
  const workspace = readFileSync(new URL("../stage-workspaces.ts", import.meta.url), "utf8");
  const proof = workspace.slice(workspace.indexOf("async function refStoreOf("), workspace.indexOf("async function commonDirOf("));
  expect(proof).toContain(".readFileBounded(");
  expect(proof).not.toMatch(/\breadFile(?:Sync)?\(/u);
  const owned = readFileSync(new URL("../owned-fs.ts", import.meta.url), "utf8");
  const reader = owned.slice(owned.indexOf("async readFileBounded("), owned.indexOf("async remove("));
  expect(reader).toContain("await handle.read(");
  expect(reader).not.toMatch(/\breadFileSync\b/u);
});

/** A host git that notes where each call was made. */
function countedGit(fx: GitFixture): { git: HostGit; calls: string[] } {
  const real = createHostGit({ env: fx.env });
  const calls: string[] = [];
  return { calls, git: { run: (cwd, args, call) => { calls.push(resolve(cwd).toLowerCase()); return real.run(cwd, args, call); }, drivers: (cwd) => { calls.push(resolve(cwd).toLowerCase()); return real.drivers(cwd); }, floorHolds: real.floorHolds } };
}

onWindows("a project on a share keeps the registration a stage folder names by the share's path", async () => {
  const fx = gitFixture();
  try {
    const real = createHostGit({ env: fx.env });
    const configAnswer = vi.fn(() => ({ code: 1, stdout: "", stderr: "" }));
    const handle = fx.start({ git: { ...real, run: (cwd, args, call) =>
      between.share !== undefined && args.includes("extensions.refStorage") ? Promise.resolve(configAnswer()) : real.run(cwd, args, call),
    } });
    const open = await handle.provider.open(handle.run, fx.repo);
    if (!open.ok) throw new Error("expected a workspace");
    const stage = await stageRoot(handle, "s1");
    const recordPath = join(open.workspace.runRoot, RUN_FILE);
    const record = JSON.parse(readFileSync(recordPath, "utf8")) as Recorded;
    const admin = record.registrations.s1?.admin as string;
    const git = record.repo.gitDir;
    const volume = parse(git).root;
    between.share = { run: "", volume, root: "\\\\server\\share\\", git };
    // The repository as the host finds it on a share, with a stop before the host recorded the stage's registration.
    record.repo.gitDir = `\\\\server\\share\\${git.slice(volume.length)}`;
    delete record.registrations.s1;
    writeFileSync(recordPath, JSON.stringify(record));
    relink(stage, `gitdir: //SERVER/Share/${slashed(admin, volume)}\n`);
    await handle.provider.release(handle.run, ["s1"]);
    expect(existsSync(stage)).toBe(false);
    expect(existsSync(admin)).toBe(false);
    expect(between.foreign).toEqual([]);
    expect(configAnswer).toHaveBeenCalledTimes(2);
  } finally {
    try { await fx.done(); } finally { between.share = undefined; }
  }
});

onWindows("a record edited to name its repository on another share or a device keeps the stage folder and its registration, and nothing is asked of that path", async () => {
  for (const moved of [(git: string) => `\\\\other\\share\\${git.slice(parse(git).root.length)}`, (git: string) => `\\\\.\\${git}`]) {
    const fx = gitFixture();
    try {
      const handle = fx.start();
      const open = await handle.provider.open(handle.run, fx.repo);
      if (!open.ok) throw new Error("expected a workspace");
      const stage = await stageRoot(handle, "s1");
      const recordPath = join(open.workspace.runRoot, RUN_FILE);
      const record = JSON.parse(readFileSync(recordPath, "utf8")) as Recorded;
      const admins = [record.registrations[JOIN_DIR]?.admin as string, record.registrations.s1?.admin as string];
      // The record's shape and its own folder still fit: only the repository's path was changed.
      record.repo.gitDir = moved(record.repo.gitDir);
      writeFileSync(recordPath, JSON.stringify(record));
      between.asked.length = 0;
      // A stage is not half released: its folder stays while its registration cannot be taken out.
      await expect(handle.provider.release(handle.run, ["s1"])).rejects.toThrow("repo.gitDir");
      expect(existsSync(join(stage, ".git"))).toBe(true);
      // The whole run stays, with the record that names what it left in the repository.
      await handle.provider.release(handle.run, "all");
      expect(existsSync(recordPath)).toBe(true);
      expect(existsSync(join(stage, ".git"))).toBe(true);
      expect(admins.map(admin => existsSync(admin))).toEqual([true, true]);
      expect(between.asked.filter(path => path.toLowerCase().startsWith(record.repo.gitDir.toLowerCase()))).toEqual([]);
      expect(between.foreign).toEqual([]);
      rmSync(open.workspace.runRoot, { recursive: true, force: true });
    } finally {
      await fx.done();
    }
  }
});

/**
 * A run with a stage, as a provider that has not seen it finds it, with every git call noted. With `rootAs`, the record names its
 * project by that path, and the run folder is where a record of such a project belongs: the record still fits its folder.
 */
async function found(fx: GitFixture, rootAs?: (root: string) => string): Promise<{ provider: ReturnType<typeof createStageWorkspaceProvider>; calls: string[]; handle: GitHandle; runRoot: string; record: Recorded; local: string }> {
  const handle = fx.start();
  const open = await handle.provider.open(handle.run, fx.repo);
  if (!open.ok) throw new Error("expected a workspace");
  await stageRoot(handle, "s1");
  let runRoot = open.workspace.runRoot;
  const record = JSON.parse(readFileSync(join(runRoot, RUN_FILE), "utf8")) as Recorded;
  const local = record.project.root;
  if (rootAs !== undefined) {
    record.project.root = rootAs(local);
    const fits = runRootOf(aveHome(), record.project.root.toLowerCase(), handle.run.itemId, handle.run.runId);
    for (const [key, entry] of Object.entries(record.registrations)) entry.gitdir = join(fits, key, ".git");
    mkdirSync(dirname(fits), { recursive: true });
    renameSync(runRoot, fits);
    runRoot = fits;
    writeFileSync(join(runRoot, RUN_FILE), JSON.stringify(record));
  }
  const { git, calls } = countedGit(fx);
  return { provider: createStageWorkspaceProvider({ plainCeiling: base, git, removable: async () => () => true }), calls, handle, runRoot, record, local };
}

type Unverified = [what: string, rootAs: ((root: string) => string) | undefined, open: boolean];
onWindows.each<Unverified>([
  ["names its project on another share", root => `\\\\other\\share\\${root.slice(parse(root).root.length)}`, true],
  ["names its project by a device path", root => `\\\\.\\${root}`, true],
  ["is as it was written, with no project open", undefined, false],
])("a record that %s directs nothing: no path of it is asked about, git is not run, and the run stays whole with its record", async (_what, rootAs, open) => {
  const fx = gitFixture();
  try {
    const { provider, calls, handle, runRoot, record, local } = await found(fx, rootAs);
    const { projectRoot, ...closed } = handle.run;
    const run = open ? handle.run : closed;
    expect(projectRoot).toBe(fx.repo);
    between.asked.length = 0;
    try {
      // A stage's release, a new stage, a seal, a collection, the run's release, a sweep and a discard. The last two are given the
      // project the host's own run state names for the run: an edited record's root is not that one, and is not taken for it.
      await expect(provider.release(run, ["s1"])).rejects.toThrow("project.root");
      expect(await provider.prepare(run, stageOf("s2"), 1)).toEqual({ ok: false, code: "workspace-unavailable" });
      expect(await provider.seal(run, "s1")).toEqual({ ok: false, code: "workspace-unavailable" });
      await expect(provider.integrate(run, "j1", ["s1"])).rejects.toThrow("the run has no integration worktree");
      await provider.release(run, "all");
      await provider.sweep([], rootAs === undefined ? undefined : new Map([[run.runId, fx.repo]]));
      await provider.discard(new Map(rootAs === undefined ? [] : [[run.runId, { projectRoot: fx.repo, itemId: run.itemId }]]));
      expect(calls).toEqual([]);
      const paths = [record.project.root, local].map(path => path.toLowerCase());
      expect(between.asked.filter(path => paths.some(root => path.toLowerCase().startsWith(root)))).toEqual([]);
      expect(between.foreign).toEqual([]);
      expect(existsSync(join(runRoot, RUN_FILE))).toBe(true);
      expect(existsSync(join(runRoot, "s1", ".git"))).toBe(true);
      expect(existsSync(join(runRoot, "s2"))).toBe(false);
      expect(Object.values(record.registrations).map(entry => existsSync(entry.admin))).toEqual([true, true]);
    } finally {
      if (rootAs !== undefined) rmSync(runRoot, { recursive: true, force: true });
    }
  } finally {
    await fx.done();
  }
});

it("a record edited to name a registration's worktree outside the run folder is no record, and nothing is asked of that path", async () => {
  const fx = gitFixture();
  try {
    const { provider, calls, handle, runRoot, record } = await found(fx);
    const outside = join(fx.base, "outside");
    mkdirSync(join(outside, "s1"), { recursive: true });
    (record.registrations.s1 as { gitdir: string }).gitdir = join(outside, "s1", ".git");
    writeFileSync(join(runRoot, RUN_FILE), JSON.stringify(record));
    between.asked.length = 0;
    await provider.release(handle.run, "all");
    await provider.sweep([], new Map([[handle.run.runId, fx.repo]]));
    await provider.discard(new Map([[handle.run.runId, { projectRoot: fx.repo, itemId: handle.run.itemId }]]));
    expect(calls).toEqual([]);
    expect(between.asked.filter(path => path.toLowerCase().startsWith(outside.toLowerCase()))).toEqual([]);
    expect(existsSync(join(runRoot, "s1", ".git"))).toBe(true);
    record.registrations.s1 = { ...record.registrations.s1, gitdir: join(runRoot, "s1", ".git") } as typeof record.registrations.s1;
    writeFileSync(join(runRoot, RUN_FILE), JSON.stringify(record));
  } finally {
    await fx.done();
  }
});

onWindows("a folder of the run whose link names another share, a device or a folder outside the repository has no git run in it", async () => {
  const links = [(admin: string) => `gitdir: //other/share/${slashed(admin, parse(admin).root)}\n`, (admin: string) => `gitdir: //./${admin.replaceAll("\\", "/")}\n`, (admin: string) => `gitdir: ${admin}/../../../../other/x\n`];
  for (const linkTo of links) {
    const fx = gitFixture();
    try {
      mkdirSync(join(fx.base, "other", "x"), { recursive: true });
      const { git, calls } = countedGit(fx);
      const handle = fx.start({ git });
      const open = await handle.provider.open(handle.run, fx.repo);
      if (!open.ok) throw new Error("expected a workspace");
      writeFileSync(join(await stageRoot(handle, "s1"), "a.txt"), "two\n");
      await sealed(handle, "s1");
      const stage = await stageRoot(handle, "s2");
      const recordPath = join(open.workspace.runRoot, RUN_FILE);
      const record = JSON.parse(readFileSync(recordPath, "utf8")) as Recorded;
      const joinDir = join(open.workspace.runRoot, JOIN_DIR);
      const written = [readFileSync(join(joinDir, ".git"), "utf8"), readFileSync(join(stage, ".git"), "utf8")];
      relink(joinDir, linkTo(record.registrations[JOIN_DIR]?.admin as string));
      // The stage's link as the record has it too: the record's text is no more the run's than the file's.
      const link = linkTo(record.registrations.s2?.admin as string);
      relink(stage, link);
      (record.stages.s2 as { link?: string }).link = link;
      writeFileSync(recordPath, JSON.stringify(record));
      calls.length = 0;
      await expect(handle.provider.integrate(handle.run, "j1", ["s1"])).rejects.toThrow("the integration worktree is not the run's own");
      expect(await handle.provider.seal(handle.run, "s2")).toEqual({ ok: false, code: "workspace-unavailable" });
      const inside = [joinDir, stage].map(path => resolve(path).toLowerCase());
      expect(calls.filter(cwd => inside.includes(cwd))).toEqual([]);
      expect(between.foreign).toEqual([]);
      relink(joinDir, written[0] as string);
      relink(stage, written[1] as string);
    } finally {
      await fx.done();
    }
  }
});

onWindows("a project or a repository directory that is really at a path with no plain form gets no workspace", async () => {
  const fx = gitFixture();
  try {
    const real = realpathSync.native(fx.repo);
    const volume = parse(real).root;
    const root = "\\\\?\\volume{00000000-0000-0000-0000-000000000000}\\";
    const shares: [NonNullable<typeof between.share>, string][] = [[{ run: "", volume, root, git: join(real, ".git") }, "git-unavailable"], [{ run: fx.repo, volume, root }, "workspace-unavailable"]];
    for (const [share, code] of shares) {
      const handle = fx.start();
      between.share = share;
      expect(await handle.provider.open(handle.run, fx.repo)).toEqual({ ok: false, code });
      between.share = undefined;
      expect(await handle.provider.prepare(handle.run, stageOf("s1"), 1)).toEqual({ ok: false, code: "workspace-unavailable" });
    }
  } finally {
    between.share = undefined;
    await fx.done();
  }
});

/**
 * Collects a sealed stage with the integration folder's link file replaced right before the host reads it: after the last git call in
 * that folder, so no git process ever follows the link. Gives what the disk was asked from then on, and what a check of the
 * repository alone asks.
 */
async function collectWithLink(fx: GitFixture, linkTo: (admin: string) => string): Promise<{ asked: string[]; repository: string[] }> {
  const git = createHostGit({ env: fx.env });
  let joinDir = "";
  let admin = "";
  let replaced = false;
  const handle = fx.start({
    git: {
      floorHolds: git.floorHolds,
      drivers: (cwd, worktree) => git.drivers(cwd, worktree),
      run: async (cwd, args, call) => {
        if (replaced && resolve(cwd).toLowerCase() === joinDir.toLowerCase()) throw new Error("git was run in a folder whose link is not the run's");
        const result = await git.run(cwd, args, call);
        if (args[0] === "merge-base") {
          relink(joinDir, linkTo(admin));
          replaced = true;
          between.asked.length = 0;
        }
        return result;
      },
    },
  });
  const open = await handle.provider.open(handle.run, fx.repo);
  if (!open.ok) throw new Error("expected a workspace");
  writeFileSync(join(await stageRoot(handle, "s1"), "a.txt"), "two\n");
  await sealed(handle, "s1");
  const record = JSON.parse(readFileSync(join(open.workspace.runRoot, RUN_FILE), "utf8")) as Recorded;
  admin = record.registrations[JOIN_DIR]?.admin as string;
  joinDir = resolve(open.workspace.runRoot, JOIN_DIR);
  await expect(handle.provider.integrate(handle.run, "j1", ["s1"])).rejects.toThrow("the integration worktree is not the run's own");
  expect(replaced).toBe(true);
  return { asked: [...between.asked], repository: [record.project.root, record.repo.gitDir, record.repo.gitDir] };
}

onWindows("an integration folder whose link names another share or a device is not collected into, and nothing is asked of the link", async () => {
  for (const linkTo of [(admin: string) => `gitdir: //other/share/${slashed(admin, parse(admin).root)}\n`, (admin: string) => `gitdir: //./${admin.replaceAll("\\", "/")}\n`]) {
    const fx = gitFixture();
    try {
      const { asked, repository } = await collectWithLink(fx, linkTo);
      expect(between.foreign).toEqual([]);
      expect(asked).toEqual(repository);
    } finally {
      await fx.done();
    }
  }
});

it("an integration folder whose link leaves the repository's worktrees folder by `..` is not collected into, and the folder it names is not asked about", async () => {
  const fx = gitFixture();
  try {
    mkdirSync(join(fx.base, "other", "x"), { recursive: true });
    // Four levels up from the admin folder is the folder the project is in.
    const { asked, repository } = await collectWithLink(fx, admin => `gitdir: ${admin}/../../../../other/x\n`);
    expect(asked).toEqual(repository);
  } finally {
    await fx.done();
  }
});

onWindows("a stage folder that names an admin folder on another share or a device records nothing, and nothing off this machine is asked", async () => {
  const fx = gitFixture();
  try {
    const handle = fx.start();
    const open = await handle.provider.open(handle.run, fx.repo);
    if (!open.ok) throw new Error("expected a workspace");
    const stages = [await stageRoot(handle, "s1"), await stageRoot(handle, "s2")];
    const recordPath = join(open.workspace.runRoot, RUN_FILE);
    const record = JSON.parse(readFileSync(recordPath, "utf8")) as Recorded;
    const admins = [record.registrations.s1?.admin as string, record.registrations.s2?.admin as string];
    const volume = parse(admins[0] as string).root;
    record.registrations = {};
    writeFileSync(recordPath, JSON.stringify(record));
    relink(stages[0] as string, `gitdir: //other/share/${slashed(admins[0] as string, volume)}\n`);
    relink(stages[1] as string, `gitdir: //./${(admins[1] as string).replaceAll("\\", "/")}\n`);
    await handle.provider.release(handle.run, ["s1", "s2"]);
    expect(stages.map(stage => existsSync(stage))).toEqual([false, false]);
    // Neither admin folder was taken as the run's.
    expect(admins.map(admin => existsSync(admin))).toEqual([true, true]);
    expect(between.foreign).toEqual([]);
  } finally {
    await fx.done();
  }
});

onWindows("a record edited to name an admin folder on another share or a device is refused, and nothing off this machine is asked", async () => {
  const fx = gitFixture();
  try {
    const handle = fx.start();
    const open = await handle.provider.open(handle.run, fx.repo);
    if (!open.ok) throw new Error("expected a workspace");
    await stageRoot(handle, "s1");
    await stageRoot(handle, "s2");
    const recordPath = join(open.workspace.runRoot, RUN_FILE);
    const record = JSON.parse(readFileSync(recordPath, "utf8")) as Recorded;
    const admins = [record.registrations.s1?.admin as string, record.registrations.s2?.admin as string];
    const volume = parse(admins[0] as string).root;
    // The record's shape and its own folder still fit: only the admin paths were changed.
    (record.registrations.s1 as { admin: string }).admin = `\\\\other\\share\\${(admins[0] as string).slice(volume.length)}`;
    (record.registrations.s2 as { admin: string }).admin = `\\\\.\\${admins[1] as string}`;
    writeFileSync(recordPath, JSON.stringify(record));
    for (const stageId of ["s1", "s2"]) await expect(handle.provider.release(handle.run, [stageId])).rejects.toThrow("not in the run's repository");
    expect(admins.map(admin => existsSync(admin))).toEqual([true, true]);
    expect(between.foreign).toEqual([]);
  } finally {
    await fx.done();
  }
});
