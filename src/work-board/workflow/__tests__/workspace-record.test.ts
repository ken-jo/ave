import { resolve } from "node:path";
import { beforeEach, expect, it, vi } from "vitest";
import { runFolderOf, vetRecordPath } from "../workspace-record.js";

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

type Kind = Parameters<typeof vetRecordPath>[0];
type Live = NonNullable<Parameters<typeof vetRecordPath>[2]>;
/** A kind, the open project, the path given, and what is taken of it: undefined when it is refused. */
type Case = [kind: Kind, live: Live | undefined, text: string, taken: string | undefined];

const ROOT = resolve("/project");
const GIT = resolve("/project/.git");
const LOCAL: Live = { root: ROOT, gitDir: GIT };
const anyPlace: Case[] = [
  ["project", LOCAL, ROOT, ROOT],
  ["project", LOCAL, `${ROOT}/sub/..`, ROOT],
  ["project", LOCAL, resolve("/other"), undefined],
  ["project", LOCAL, resolve("/project/sub"), undefined],
  ["project", LOCAL, "project", undefined],
  ["project", undefined, ROOT, undefined],
  ["gitDir", LOCAL, GIT, GIT],
  ["gitDir", LOCAL, `${ROOT}/other/../.git`, GIT],
  ["gitDir", LOCAL, resolve("/other/.git"), undefined],
  ["gitDir", LOCAL, ROOT, undefined],
  // Git was not asked yet: no repository to compare with.
  ["gitDir", { root: ROOT }, GIT, undefined],
  ["gitDir", undefined, GIT, undefined],
  ["admin", LOCAL, resolve("/project/.git/worktrees/s1"), resolve("/project/.git/worktrees/s1")],
  ["admin", LOCAL, `${resolve("/project/.git/worktrees")}/other/../s1`, resolve("/project/.git/worktrees/s1")],
  ["admin", LOCAL, `${resolve("/project/.git/worktrees")}/../../other/x`, undefined],
  ["admin", LOCAL, resolve("/project/.git/worktrees/deeper/x"), undefined],
  ["admin", LOCAL, resolve("/project/.git/x"), undefined],
  ["admin", LOCAL, resolve("/project/.git/worktrees"), undefined],
  ["admin", LOCAL, resolve("/other/.git/worktrees/x"), undefined],
  ["admin", LOCAL, resolve("/"), undefined],
  ["admin", LOCAL, "worktrees/s1", undefined],
  ["admin", { root: ROOT }, resolve("/project/.git/worktrees/s1"), undefined],
  ["admin", undefined, resolve("/project/.git/worktrees/s1"), undefined],
  ["link", LOCAL, `gitdir: ${resolve("/project/.git/worktrees/s1")}\n`, resolve("/project/.git/worktrees/s1")],
  ["link", LOCAL, `gitdir: ${resolve("/project/.git/worktrees/s1")}\r\n`, resolve("/project/.git/worktrees/s1")],
  ["link", LOCAL, resolve("/project/.git/worktrees/s1"), undefined],
  ["link", LOCAL, "gitdir: ../../project/.git/worktrees/s1\n", undefined],
  ["link", LOCAL, `gitdir: ${resolve("/other/.git/worktrees/s1")}\n`, undefined],
  ["link", LOCAL, `gitdir: ${resolve("/project/.git/worktrees/s1")}\nmore\n`, undefined],
  ["link", LOCAL, "", undefined],
  ["link", undefined, `gitdir: ${resolve("/project/.git/worktrees/s1")}\n`, undefined],
];

const SHARE: Live = { root: String.raw`\\server\share\project`, gitDir: String.raw`\\server\share\project\.git` };
const DRIVE: Live = { root: String.raw`C:\project`, gitDir: String.raw`C:\project\.git` };
const S1 = String.raw`\\server\share\project\.git\worktrees\s1`;
const devices = (tail: string): string[] => [String.raw`\\.\C:\project${tail}`, String.raw`\\.\UNC\server\share\project${tail}`, String.raw`\\?\GLOBALROOT\Device\X\project${tail}`,
  String.raw`\\?\Volume{1}\project${tail}`, String.raw`\\?\UNC\?\C:\project${tail}`, `//./pipe/project${tail.replaceAll("\\", "/")}`];
const onShare: Case[] = [
  // A project on a share is taken however the path is spelled, and by the open project's own text.
  ...["//server/share/project", String.raw`\\SERVER\Share\Project`, String.raw`\\?\UNC\server\share\project`, String.raw`\\server\share\project\sub\..`].map((text): Case => ["project", SHARE, text, SHARE.root]),
  ...["//server/share/project/.git", String.raw`\\SERVER\Share\project\.GIT`, String.raw`\\?\UNC\server\share\project\.git`].map((text): Case => ["gitDir", SHARE, text, SHARE.gitDir]),
  ...["//server/share/project/.git/worktrees/s1", String.raw`\\SERVER\Share\Project\.GIT\Worktrees\s1`, String.raw`\\?\UNC\server\share\project\.git\worktrees\s1`,
    String.raw`\\server\share\project\.git\worktrees\other\..\s1`, "//server/share/project/.git/worktrees/s1/"].map((text): Case => ["admin", SHARE, text, S1]),
  ["link", SHARE, "gitdir: //SERVER/Share/project/.git/worktrees/s1\n", S1],
  ["project", DRIVE, String.raw`\\?\c:\Project`, DRIVE.root],
  ["gitDir", DRIVE, String.raw`\\?\C:\project\.git`, String.raw`C:\project\.git`],
  ["admin", DRIVE, String.raw`\\?\c:\Project\.git\worktrees\s1`, String.raw`C:\project\.git\worktrees\s1`],
  // Another share, another server, the same share under another name of its server, and a share for a project on a drive.
  ...[String.raw`\\other\share\project`, "//server/other/project", String.raw`\\server.example\share\project`, String.raw`\\?\UNC\other\share\project`, ...devices("")]
    .flatMap((text): Case[] => [["project", SHARE, text, undefined], ["project", DRIVE, text, undefined], ["gitDir", SHARE, String.raw`${text}\.git`, undefined], ["gitDir", DRIVE, String.raw`${text}\.git`, undefined]]),
  ["project", DRIVE, SHARE.root, undefined],
  ["gitDir", DRIVE, String.raw`\\server\share\project\.git`, undefined],
  ...[String.raw`\\other\share\project\.git\worktrees\x`, "//server/other/project/.git/worktrees/x", String.raw`\\server\share\project\.git\x`, String.raw`\\server\share\project\.git\worktrees\deeper\x`,
    String.raw`\\server\share\project\.git\worktrees\..\x`, String.raw`\\server\share\project\.git\worktrees\x\..`, String.raw`\\server\share\project\.git\worktrees\.`, String.raw`\\server\share\project\.git\worktrees\x:stream`,
    String.raw`\\?\UNC\other\share\project\.git\worktrees\x`, ...devices(String.raw`\.git\worktrees\x`)]
    .flatMap((text): Case[] => [["admin", SHARE, text, undefined], ["admin", DRIVE, text, undefined], ["link", SHARE, `gitdir: ${text}\n`, undefined], ["link", DRIVE, `gitdir: ${text}\n`, undefined]]),
  ["admin", DRIVE, S1, undefined],
  // An open project whose own path is a device path gives nothing to compare with.
  ["project", { root: String.raw`\\.\C:\project` }, String.raw`C:\project`, undefined],
  ["gitDir", { root: DRIVE.root, gitDir: String.raw`\\?\Volume{1}\project\.git` }, String.raw`\\?\Volume{1}\project\.git`, undefined],
];

it("a path of the record or of a link file is taken only as the open project's own, by its text, and nothing is asked of any of them", () => {
  const cases = process.platform === "win32" ? [...anyPlace, ...onShare] : anyPlace;
  for (const [kind, live, text, taken] of cases) {
    const got = vetRecordPath(kind, text, live);
    expect(process.platform === "win32" && kind !== "project" ? got?.toLowerCase() : got, `${kind} ${text} with ${JSON.stringify(live)}`).toBe(process.platform === "win32" && kind !== "project" ? taken?.toLowerCase() : taken);
  }
  expect(cases.filter(([, , , taken]) => taken === undefined).length).toBeGreaterThan(20);
  expect(disk.asked).toEqual([]);
  expect(disk.resolved).toEqual([]);
});
