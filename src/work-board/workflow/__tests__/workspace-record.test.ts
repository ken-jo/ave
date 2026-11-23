import { resolve } from "node:path";
import { beforeEach, expect, it, vi } from "vitest";
import { runFolderOf } from "../workspace-record.js";

const disk = vi.hoisted(() => ({ asked: [] as string[], resolved: [] as string[], real: undefined as string | undefined }));

vi.mock("../owned-fs.js", async (original) => ({
  ...await original<typeof import("../owned-fs.js")>(),
  // Every directory answers as the run folder, so only the path's own form can refuse it.
  realDirId: (path: string) => { disk.asked.push(path); return "1:1"; },
}));

vi.mock("node:fs", async (original) => {
  const real = await original<typeof import("node:fs")>();
  const native = (path: string): string => { disk.resolved.push(path); return disk.real ?? path; };
  return { ...real, realpathSync: Object.assign((path: string) => real.realpathSync(path), { native }) };
});

const onShares = it.skipIf(process.platform !== "win32");
const HOME_RUN = String.raw`\\server\share\home\run`;
const run = (path: string): { path: string; id: "1:1" } => ({ path, id: "1:1" });

beforeEach(() => { disk.asked.length = 0; disk.resolved.length = 0; disk.real = undefined; });

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
