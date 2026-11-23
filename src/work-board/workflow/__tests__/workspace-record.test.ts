import { resolve } from "node:path";
import { beforeEach, expect, it, vi } from "vitest";
import { adminNameIn, runFolderOf } from "../workspace-record.js";

const disk = vi.hoisted(() => ({ asked: [] as string[], resolved: [] as string[], real: undefined as string | undefined, gone: false }));

vi.mock("../owned-fs.js", async (original) => ({
  ...await original<typeof import("../owned-fs.js")>(),
  // Every directory answers as the run folder, so only the path's own form can refuse it.
  realDirId: (path: string) => { disk.asked.push(path); return "1:1"; },
}));

vi.mock("node:fs", async (original) => {
  const real = await original<typeof import("node:fs")>();
  const native = (path: string): string => {
    disk.resolved.push(path);
    if (disk.gone) throw new Error("ENOENT");
    return disk.real ?? path;
  };
  return { ...real, realpathSync: Object.assign((path: string) => real.realpathSync(path), { native }) };
});

const onShares = it.skipIf(process.platform !== "win32");
const HOME_RUN = String.raw`\\server\share\home\run`;
const run = (path: string): { path: string; id: "1:1" } => ({ path, id: "1:1" });

beforeEach(() => { disk.asked.length = 0; disk.resolved.length = 0; disk.real = undefined; disk.gone = false; });

it("a registration on a local path is looked up on disk, and the run folder's own path is not resolved for it", () => {
  expect(runFolderOf(run(resolve("/run")), "_join", resolve("/run", "_join", ".git"))).toBe(resolve("/run", "_join"));
  expect(disk.asked).toEqual([resolve("/run")]);
  expect(disk.resolved).toEqual([]);
});

onShares("a drive path under the long-path prefix is the drive path", () => {
  expect(runFolderOf(run(String.raw`C:\run`), "_join", String.raw`\\?\C:\run\_join\.git`)).toBe(String.raw`C:\run\_join`);
  expect(disk.asked).toEqual([String.raw`C:\run`]);
  expect(disk.resolved).toEqual([]);
});

onShares("a registration in the run folder of a home on a share is kept, however the share path is spelled", () => {
  const spellings = ["//server/share/home/run/_join/.git", String.raw`\\SERVER\Share\home\run\_join\.git`, String.raw`\\?\UNC\server\share\home\run\_join\.git`, "//?/UNC/server/share/home/run/_join/.git",
    String.raw`\\?\UNC\server\share\..\..\other\..\home\run\_join\.git`];
  for (const gitdir of spellings) expect(runFolderOf(run(HOME_RUN), "_join", gitdir)?.toLowerCase(), gitdir).toBe(String.raw`${HOME_RUN}\_join`);
  // Only the plain spelling of the run folder is ever asked about.
  expect(new Set(disk.asked.map(path => path.toLowerCase()))).toEqual(new Set([HOME_RUN]));
  expect(new Set(disk.resolved)).toEqual(new Set([HOME_RUN]));
});

onShares("a home reached by a drive letter that is really a share keeps a registration git wrote with the share's path", () => {
  disk.real = String.raw`\\?\UNC\server\share\home\run`;
  expect(runFolderOf(run(String.raw`Z:\home\run`), "s1", "//server/share/home/run/s1/.git")).toBe(String.raw`${HOME_RUN}\s1`);
  expect(disk.resolved).toEqual([String.raw`Z:\home\run`]);
  expect(disk.asked).toEqual([HOME_RUN]);
});

onShares("a share or device path outside the run folder names nothing, and nothing is asked of it", () => {
  const outside = [String.raw`\\other\share\home\run\_join\.git`, "//server/other/home/run/_join/.git", String.raw`\\server\share\home\other\_join\.git`, String.raw`\\server\share\home\run\deeper\_join\.git`,
    String.raw`\\?\UNC\other\share\home\run\_join\.git`, String.raw`\\.\C:\run\_join\.git`, String.raw`\\.\UNC\server\share\home\run\_join\.git`, String.raw`\\?\Volume{1}\run\_join\.git`,
    String.raw`\\?\GLOBALROOT\Device\X\run\_join\.git`, String.raw`\\?\UNC\?\C:\run\_join\.git`, String.raw`\\?\UNC\.\C:\run\_join\.git`, "//./pipe/run/_join/.git"];
  for (const from of [HOME_RUN, String.raw`C:\run`]) for (const gitdir of outside) expect(runFolderOf(run(from), "_join", gitdir), gitdir).toBeUndefined();
  expect(disk.asked).toEqual([]);
  // The run folder's own path is the only one resolved.
  expect(disk.resolved.every(path => path === HOME_RUN || path === String.raw`C:\run`)).toBe(true);
});

onShares("a run folder whose real path is a device path keeps no share registration", () => {
  disk.real = String.raw`\\.\C:\run`;
  expect(runFolderOf(run(HOME_RUN), "_join", String.raw`${HOME_RUN}\_join\.git`)).toBeUndefined();
  expect(disk.asked).toEqual([]);
});

onShares("a run folder whose real path cannot be read keeps no share registration", () => {
  disk.gone = true;
  expect(runFolderOf(run(HOME_RUN), "_join", "//server/share/home/run/_join/.git")).toBeUndefined();
  expect(disk.resolved).toEqual([HOME_RUN]);
  expect(disk.asked).toEqual([]);
});

const SHARE_GIT = String.raw`\\server\share\project\.git`;

it("an admin folder on a local path is named when its parent is the repository's worktrees folder, which is looked up on disk", () => {
  expect(adminNameIn(resolve("/project/.git"), "1:1", resolve("/project/.git/worktrees/s1"))).toBe("s1");
  expect(adminNameIn(resolve("/project/.git"), "2:2", resolve("/project/.git/worktrees/s1"))).toBeUndefined();
  expect(disk.asked).toEqual([resolve("/project/.git/worktrees"), resolve("/project/.git/worktrees")]);
  expect(disk.resolved).toEqual([]);
});

it("an admin path whose last part is no plain name names nothing, and nothing is asked of it", () => {
  for (const admin of [resolve("/"), resolve("/project/.git/worktrees/s1:stream")]) expect(adminNameIn(resolve("/project/.git"), "1:1", admin), admin).toBeUndefined();
  expect(disk.asked).toEqual([]);
});

it("an admin path that only passes through the worktrees folder is asked about where it ends", () => {
  expect(adminNameIn(resolve("/project/.git"), "1:1", `${resolve("/project/.git/worktrees")}/../../other/x`)).toBe("x");
  expect(disk.asked).toEqual([resolve("/project/other")]);
});

onShares("an admin folder in the worktrees folder of a repository on a share is named, however the share path is spelled", () => {
  const spellings = ["//server/share/project/.git/worktrees/s1", String.raw`\\SERVER\Share\Project\.GIT\Worktrees\s1`, String.raw`\\?\UNC\server\share\project\.git\worktrees\s1`,
    String.raw`\\server\share\project\.git\worktrees\other\..\s1`, "//server/share/project/.git/worktrees/s1/"];
  for (const admin of spellings) expect(adminNameIn(SHARE_GIT, "1:1", admin), admin).toBe("s1");
  // Only the worktrees folder of the repository's own directory is ever asked about.
  expect(new Set(disk.asked.map(path => path.toLowerCase()))).toEqual(new Set([String.raw`${SHARE_GIT}\worktrees`]));
  expect(disk.resolved).toEqual([]);
});

onShares("a share or device admin path outside the repository's worktrees folder names nothing, and nothing is asked of it", () => {
  const outside = [String.raw`\\other\share\project\.git\worktrees\x`, "//server/other/project/.git/worktrees/x", String.raw`\\server\share\project\.git\x`, String.raw`\\server\share\project\.git\worktrees\deeper\x`,
    String.raw`\\server\share\project\.git\worktrees\..\x`, String.raw`\\server\share\project\.git\worktrees\x\..`, String.raw`\\server\share\project\.git\worktrees\.`, String.raw`\\server\share\project\.git\worktrees\x:stream`,
    String.raw`\\?\UNC\other\share\project\.git\worktrees\x`, String.raw`\\.\C:\project\.git\worktrees\x`, String.raw`\\.\UNC\server\share\project\.git\worktrees\x`, String.raw`\\?\GLOBALROOT\Device\X\project\.git\worktrees\x`,
    String.raw`\\?\Volume{1}\project\.git\worktrees\x`, "//./pipe/project/.git/worktrees/x"];
  for (const gitDir of [SHARE_GIT, String.raw`C:\project\.git`]) for (const admin of outside) expect(adminNameIn(gitDir, "1:1", admin), admin).toBeUndefined();
  expect(disk.asked).toEqual([]);
  expect(disk.resolved).toEqual([]);
});

onShares("a drive path under the long-path prefix names the admin folder of a repository on that drive", () => {
  expect(adminNameIn(String.raw`C:\project\.git`, "1:1", String.raw`\\?\C:\project\.git\worktrees\s1`)).toBe("s1");
  expect(disk.asked).toEqual([String.raw`C:\project\.git\worktrees`]);
});
