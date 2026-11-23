import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, parse } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createHostGit, type HostGit } from "../host-git.js";
import type { OwnedDir } from "../owned-fs.js";
import { createStageWorkspaceProvider } from "../stage-workspaces.js";
import { RUN_FILE } from "../workspace-layout.js";
import { gitFixture, stageRoot } from "./stage-git-fixture.js";

/** Runs before the run folder is made in its project folder, with that folder's path: where another process's release can come between. */
const between = vi.hoisted(() => ({
  act: undefined as ((projectFolder: string) => void) | undefined,
  /** Runs right after an entry of a held folder was removed, with the entry's path. */
  removed: undefined as ((path: string) => void) | undefined,
  /** A home on a share: the run folder as the host reached it, the volume it is really on, and the share that stands for that volume. */
  share: undefined as { run: string; volume: string; root: string } | undefined,
}));

vi.mock("node:fs", async (original) => {
  const real = await original<typeof import("node:fs")>();
  const native = (path: string): string => {
    const found = real.realpathSync.native(path);
    return between.share?.run === path ? between.share.root + found.slice(between.share.volume.length) : found;
  };
  return { ...real, realpathSync: Object.assign((path: string) => real.realpathSync(path), { native }) };
});

vi.mock("../owned-fs.js", async (original) => {
  const real = await original<typeof import("../owned-fs.js")>();
  const held = (dir: OwnedDir, depth: number): OwnedDir => new Proxy(dir, {
    get(target, key) {
      if (key === "ensure") return (name: string) => held(target.ensure(name), depth + 1);
      if (key === "existing") return (name: string) => { const found = target.existing(name); return found === undefined ? undefined : held(found, depth + 1); };
      if (key === "remove") return async (name: string, expect?: string) => { await target.remove(name, expect); between.removed?.(join(target.path, name)); };
      if (key === "make" && depth === 2) return (name: string) => { between.act?.(target.path); return target.make(name); };
      const value = Reflect.get(target, key) as unknown;
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
  // What is asked of the share is answered by the volume behind it.
  const local = (path: string): string => {
    const share = between.share;
    return share !== undefined && path.toLowerCase().startsWith(share.root) ? share.volume + path.slice(share.root.length) : path;
  };
  return { ...real, holdDir: (path: string, id?: string) => held(real.holdDir(path, id), 0), nodeIdOf: (path: string) => real.nodeIdOf(local(path)), realDirId: (path: string) => real.realDirId(local(path)) };
});

let base: string;
const hostGit = (): HostGit => createHostGit({ env: { ...process.env, GIT_CONFIG_GLOBAL: join(base, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1", GIT_CEILING_DIRECTORIES: base } });
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
  rmSync(base, { recursive: true, force: true, maxRetries: 3 });
});

it("an open whose project folder another run's release took away makes it again", async () => {
  const provider = createStageWorkspaceProvider({ git: hostGit() });
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
  expect(await createStageWorkspaceProvider({ git: hostGit() }).open(run(), join(base, "project"))).toEqual({ ok: false, code: "workspace-unavailable" });
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
    expect(await createStageWorkspaceProvider({ git: hostGit() }).open(run(), join(base, "project"))).toEqual({ ok: false, code: "home-boundary-unverified" });
    // Nothing is made in the folder that took the name.
    expect(swaps).toBe(1);
    expect(readdirSync(join(home, "worktrees"))).toEqual([]);
  } finally {
    if (before === undefined) delete process.env.AVE_HOME; else process.env.AVE_HOME = before;
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
    const record = JSON.parse(readFileSync(recordPath, "utf8")) as { registrations: Record<string, { admin: string }> };
    const admin = record.registrations.s1?.admin as string;
    const real = realpathSync.native(stage);
    const volume = parse(real).root;
    between.share = { run: open.workspace.runRoot, volume, root: "\\\\server\\share\\" };
    // As git leaves it on a share, with a stop before the host recorded it: the admin folder names the stage by the share's path.
    writeFileSync(join(admin, "gitdir"), `//server/share/${real.slice(volume.length).replaceAll("\\", "/")}/.git\n`);
    delete record.registrations.s1;
    writeFileSync(recordPath, JSON.stringify(record));
    await handle.provider.release(handle.run, ["s1"]);
    expect(existsSync(stage)).toBe(false);
    expect(existsSync(admin)).toBe(false);
  } finally {
    between.share = undefined;
    await fx.done();
  }
});
