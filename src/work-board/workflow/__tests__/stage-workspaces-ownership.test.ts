import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { aveHome } from "../../../shared/ave-home.js";
import { createHostGit, type HostGit, HostGitError } from "../host-git.js";
import { nodeIdOf } from "../owned-fs.js";
import { createStageWorkspaceProvider } from "../stage-workspaces.js";
import { JOIN_DIR, RUN_FILE, runBranch, runRootOf, runSlug } from "../workspace-layout.js";
import { removeTree, setPath, stageOf, writeUnder as write } from "./stage-fixtures.js";
import { type GitFixture, type GitHandle, gitFixture, sealed, stageRoot } from "./stage-git-fixture.js";

const warned = vi.hoisted(() => [] as string[]);
vi.mock("../../../lib/logger.js", () => {
  const quiet = (): void => undefined;
  return { createLogger: () => ({ warn: (...said: unknown[]) => { warned.push(said.join(" ")); }, info: quiet, debug: quiet, error: quiet }) };
});

let fx: GitFixture;
/** Set while a group of tests that change nothing shares one fixture. */
let shared = false;

beforeEach(() => {
  if (!shared) fx = gitFixture();
  warned.length = 0;
});

afterEach(async () => {
  if (!shared) await fx.done();
});

/** The exit code of plain git, for a call that may fail. */
const code = (cwd: string, ...args: string[]): number | null => spawnSync("git", args, { cwd, env: fx.env, encoding: "utf8" }).status;
/** The admin folder a worktree's `.git` file names. */
const adminOf = (worktree: string): string => resolve(worktree, readFileSync(join(worktree, ".git"), "utf8").replace(/^gitdir: /u, "").trim());

/**
 * Item 7's run, parked with a sealed stage and nothing collected, so that a release takes its branch too; item 8's run of the same
 * project with a stage collected onto its branch; and the user's own branch, worktree and second repository.
 */
interface Scene {
  target: GitHandle; runRoot: string; record: string; written: string; stage: string; admin: string; branch: string;
  base: string; other: GitHandle; otherRoot: string; userwt: string; userAdmin: string; elsewhere: string;
}

async function scene(): Promise<Scene> {
  const { repo, userGit } = fx;
  const base = userGit(repo, "rev-parse", "HEAD");
  userGit(repo, "branch", "keep");
  const userwt = join(fx.base, "userwt");
  userGit(repo, "worktree", "add", "-q", "--detach", userwt);
  const elsewhere = join(fx.base, "elsewhere");
  mkdirSync(elsewhere);
  userGit(elsewhere, "init", "-q");
  userGit(elsewhere, "-c", "user.name=Bob Example", "-c", "user.email=bob@example.com", "commit", "-q", "--allow-empty", "-m", "first");

  const target = fx.start();
  const open = await target.provider.open(target.run, repo);
  if (!open.ok) throw new Error(open.code);
  const runRoot = open.workspace.runRoot;
  const stage = await stageRoot(target, "s1");
  await sealed(target, "s1");

  const other = fx.start({}, 8);
  const otherOpen = await other.provider.open(other.run, repo);
  if (!otherOpen.ok) throw new Error(otherOpen.code);
  write(await stageRoot(other, "s1"), "new.txt", "new\n");
  await sealed(other, "s1");
  expect(await other.provider.integrate(other.run, "j1", ["s1"])).toEqual({ ok: true });

  const record = join(runRoot, RUN_FILE);
  return {
    target, runRoot, record, written: readFileSync(record, "utf8"), stage, admin: adminOf(join(runRoot, JOIN_DIR)), branch: runBranch(target.run.runId),
    base, other, otherRoot: otherOpen.workspace.runRoot, userwt, userAdmin: adminOf(userwt), elsewhere,
  };
}

/** As after a restart, with item 7 gone from the board and item 8 still on it. A discard and a sweep have no project open; a release
 * is item 7's, with its project open, and a `swept` sweep and a `discarded` discard are given item 7's project as the host's run
 * state names it. */
/** A run's project as the host's run file named it when its record went. */
const named = ({ run }: GitHandle): [string, { projectRoot: string; itemId: number }] => [run.runId, { projectRoot: fx.repo, itemId: run.itemId }];

async function operate(operation: "discard" | "sweep" | "release" | "swept" | "discarded", at?: Scene): Promise<void> {
  const provider = createStageWorkspaceProvider({ git: createHostGit({ env: fx.env }), removable: async () => run => run.itemId !== 8 });
  if (operation === "release") await provider.release((at as Scene).target.run, "all");
  else if (operation === "swept") await provider.sweep([], new Map([[(at as Scene).target.run.runId, fx.repo]]));
  else if (operation === "discarded") await provider.discard(new Map([named((at as Scene).target)]));
  else await (operation === "discard" ? provider.discard(new Map()) : provider.sweep([]));
}

function expectUsersOwn(at: Scene): void {
  const { repo, userGit } = fx;
  expect(userGit(repo, "rev-parse", "keep")).toBe(at.base);
  expect(existsSync(join(at.userwt, "a.txt"))).toBe(true);
  expect(existsSync(at.userAdmin)).toBe(true);
  expect(userGit(repo, "show", `${runBranch(at.other.run.runId)}:new.txt`)).toBe("new");
}

function expectRepositoryUntouched(at: Scene): void {
  expect(fx.userGit(fx.repo, "rev-parse", `refs/heads/${at.branch}`)).toBe(at.base);
  expect(existsSync(at.admin)).toBe(true);
}

const keptFile = (): string => join(fx.base, "kept.txt");
type Row = [field: string, path: (string | number)[], value: (at: Scene) => unknown];

/** One field of the record, changed in place: the run folder is then not the one the record names, and nothing of the run goes. */
const refused: Row[] = [
  ["v", ["v"], () => 1],
  ["runId", ["runId"], at => `${at.target.run.runId}-other`],
  ["itemId", ["itemId"], () => 99],
  ["kind", ["kind"], () => "folder"],
  ["self", ["self"], () => "1:1"],
  ["project.root", ["project", "root"], at => at.elsewhere],
  ["branch", ["branch"], () => "keep"],
  ["joinDir", ["joinDir"], () => "1:1"],
  ["stages.s1.dir", ["stages", "s1", "dir"], () => "1:1"],
  ["baseCommit", ["baseCommit"], at => fx.userGit(fx.repo, "rev-parse", runBranch(at.other.run.runId))],
  ["refs[0].name", ["refs", 0, "name"], () => "refs/heads/keep"],
  ["refs[0].oid", ["refs", 0, "oid"], at => fx.userGit(fx.repo, "rev-parse", runBranch(at.other.run.runId))],
  ["registrations._join.gitdir", ["registrations", "_join", "gitdir"], at => join(at.otherRoot, JOIN_DIR, ".git")],
  // A commit the record would hand to git, written as an option that names a file to write.
  ...[["stages", "s1", "base"], ["stages", "s1", "sealCommit"], ["merging"]].map((path): Row => [path.join("."), path, () => `--output=${keptFile()}`]),
  ["baseCommit, as such an option,", ["baseCommit"], () => `--output=${keptFile()}`],
  ["refs[0].oid, as such an option,", ["refs", 0, "oid"], () => `--output=${keptFile()}`],
];

/** A field that names the project or its repository: the run folder is still the run's and goes; the repository is left as it is. */
const repositoryLeft: Row[] = [
  ["project.id", ["project", "id"], () => "1:1"],
  ["repo.id", ["repo", "id"], () => "1:1"],
  ["registrations._join.admin", ["registrations", "_join", "admin"], at => at.userAdmin],
  ["registrations._join.id", ["registrations", "_join", "id"], () => "1:1+ave.id:1"],
];

/** A path of the record that is not the open project's by text: nothing is asked of it, and the run stays whole with its record. */
const unverified: Row[] = [
  ["repo.gitDir", ["repo", "gitDir"], at => join(at.elsewhere, ".git")],
  ["registrations._join.admin", ["registrations", "_join", "admin"], at => join(at.elsewhere, ".git", "worktrees", "_join")],
];

function expectLeftWhole(at: Scene, field: string): void {
  expect(existsSync(at.record)).toBe(true);
  expect(existsSync(join(at.stage, "a.txt"))).toBe(true);
  expect(existsSync(join(at.runRoot, JOIN_DIR, "a.txt"))).toBe(true);
  expectRepositoryUntouched(at);
  expectUsersOwn(at);
  expect(warned.filter(line => line.includes("cleanup is unverified") && line.includes(at.target.run.runId))).toEqual([expect.stringContaining(field.split(".").slice(0, 2).join("."))]);
}

it.each(["discard", "sweep"] as const)("a %s has no project open: a git run stays whole with its record, its cleanup unverified", async (operation) => {
  const at = await scene();
  await operate(operation);
  expectLeftWhole(at, "project.root");
});

it("a sweep leaves a git run whose project it is given under another run's id", async () => {
  const at = await scene();
  await createStageWorkspaceProvider({ git: createHostGit({ env: fx.env }) }).sweep([], new Map([[at.other.run.runId, fx.repo], [`${at.target.run.runId}-other`, fx.repo]]));
  expectLeftWhole(at, "project.root");
  expect(existsSync(at.otherRoot)).toBe(false);
});

it("a run whose release was refused for want of its project goes at a discard given the root its removed record named, and stays at one given none", async () => {
  const at = await scene();
  const { projectRoot, ...closed } = at.target.run;
  expect(projectRoot).toBe(fx.repo);
  const provider = createStageWorkspaceProvider({ git: createHostGit({ env: fx.env }), removable: async () => run => run.itemId !== 8 });
  await provider.release(closed, "all");
  expectLeftWhole(at, "project.root");
  // An entry the run file held with no project carries none. Left whole or taken apart, the run was taken in hand: what the caller
  // held for it has been used.
  expect(await provider.discard(new Map())).toEqual([at.target.run.runId]);
  expectLeftWhole(at, "project.root");
  expect(await provider.discard(new Map([named(at.target)]))).toEqual([at.target.run.runId]);
  expect(existsSync(at.runRoot)).toBe(false);
  expect(existsSync(at.admin)).toBe(false);
  expect(fx.userGit(fx.repo, "branch", "--list", at.branch)).toBe("");
  expectUsersOwn(at);
});

it("a run a discard left whole on the root it was given is not judged again by a discard given none for it, another run's own included: one report, until a root is told anew", async () => {
  const at = await scene();
  const real = createHostGit({ env: fx.env });
  let answers = false;
  const git: HostGit = {
    drivers: real.drivers, floorHolds: real.floorHolds,
    run: (cwd, args, call) => !answers && args.includes("--git-common-dir") ? Promise.reject(new HostGitError("timeout", "git gave no answer")) : real.run(cwd, args, call),
  };
  const provider = createStageWorkspaceProvider({ git, removable: async () => run => run.itemId !== 8 });
  expect.soft(await provider.discard(new Map([named(at.target)]))).toEqual([at.target.run.runId]);
  answers = true;
  // As the engine discards a run whose start was refused: with that run's root alone, and every folder under `worktrees` read.
  expect.soft(await provider.discard(new Map([["run-refused", { projectRoot: fx.repo, itemId: 70 }]]))).toEqual(["run-refused"]);
  expect.soft(await provider.discard(new Map())).toEqual([]);
  expectLeftWhole(at, "repo.gitDir");
  // The same record, and a root told anew: the run is judged on it.
  expect(await provider.discard(new Map([named(at.target)]))).toEqual([at.target.run.runId]);
  expect(existsSync(at.runRoot)).toBe(false);
  expect(fx.userGit(fx.repo, "branch", "--list", at.branch)).toBe("");
  expectUsersOwn(at);
});

it("a run left whole on the root it was given is still checked by a later discard given none: a stage folder replaced since is told once", async () => {
  const at = await scene();
  const real = createHostGit({ env: fx.env });
  const git: HostGit = { drivers: real.drivers, floorHolds: real.floorHolds, run: (cwd, args, call) => args.includes("--git-common-dir") ? Promise.reject(new HostGitError("timeout", "git gave no answer")) : real.run(cwd, args, call) };
  const provider = createStageWorkspaceProvider({ git, removable: async () => run => run.itemId !== 8 });
  await provider.discard(new Map([named(at.target)]));
  renameSync(at.stage, `${at.stage}-away`);
  mkdirSync(at.stage);
  await provider.discard(new Map());
  await provider.discard(new Map());
  expect(warned.filter(line => line.includes("stays as it is") && line.includes("stages.s1.dir") && line.includes(at.target.run.runId))).toHaveLength(1);
  expect(existsSync(at.record)).toBe(true);
  rmdirSync(at.stage);
  renameSync(`${at.stage}-away`, at.stage);
});

it("a registration whose `gitdir` holds bytes that are no text is not read as other text: the release leaves the run whole until it is the path git wrote", async () => {
  const handle = fx.start();
  const open = await handle.provider.open(handle.run, fx.repo);
  if (!open.ok) throw new Error(open.code);
  const stage = await stageRoot(handle, "s1");
  const gitdir = join(adminOf(stage), "gitdir");
  const written = readFileSync(gitdir);
  writeFileSync(gitdir, Buffer.concat([written.subarray(0, -1), Buffer.from([0xff, 0x0a])]));
  await handle.provider.release(handle.run, "all");
  expect([existsSync(stage), existsSync(join(open.workspace.runRoot, RUN_FILE))]).toEqual([true, true]);
  writeFileSync(gitdir, written);
  await handle.provider.release(handle.run, "all");
  expect([existsSync(open.workspace.runRoot), existsSync(dirname(gitdir))]).toEqual([false, false]);
});

it("a folder run left whole because a stage folder was replaced is taken apart by a later discard once the folder is its own again", async () => {
  const provider = createStageWorkspaceProvider({ git: createHostGit({ env: fx.env }), removable: async () => () => true });
  const run = { itemId: 9, runId: `run-folder-${process.pid}-${Date.now()}`, runKey: "key" };
  const open = await provider.open(run, undefined);
  if (!open.ok) throw new Error(open.code);
  const prepared = await provider.prepare(run, stageOf("s1"), 1);
  if (!prepared.ok) throw new Error(prepared.code);
  const stage = prepared.workspace.root;
  renameSync(stage, `${stage}-away`);
  mkdirSync(stage);
  await provider.discard(new Map());
  expect(existsSync(join(open.workspace.runRoot, RUN_FILE))).toBe(true);
  rmdirSync(stage);
  renameSync(`${stage}-away`, stage);
  await provider.discard(new Map());
  expect(existsSync(open.workspace.runRoot)).toBe(false);
});

it("a discard tells of a run it was given a root for that has no folder left, whatever another run's folder it cannot read holds; not while a folder it cannot read carries the run's own name", async () => {
  const at = await scene();
  const provider = createStageWorkspaceProvider({ git: createHostGit({ env: fx.env }), removable: async () => run => run.itemId !== 8 });
  await provider.release(at.target.run, "all");
  expect(existsSync(at.runRoot)).toBe(false);
  // Item 8's run has its folder and its row: it is not taken in hand, and what is held for it waits.
  const given = new Map([named(at.target), named(at.other)]);
  expect(await provider.discard(given)).toEqual([at.target.run.runId]);
  const record = join(at.otherRoot, RUN_FILE);
  const written = readFileSync(record, "utf8");
  // Item 8's record can no longer be read: its folder may be its run's, and says nothing of item 7's.
  setPath(record, ["v"], 1);
  try {
    expect(await provider.discard(given)).toEqual([at.target.run.runId]);
  } finally {
    writeFileSync(record, written);
  }
  // A folder with no record where item 7's run had its own.
  mkdirSync(at.runRoot);
  try {
    expect(await provider.discard(given)).toEqual([]);
  } finally {
    rmSync(at.runRoot, { recursive: true });
  }
  expect(await provider.discard(given)).toEqual([at.target.run.runId]);
});

it("a folder a discard cannot read keeps the root of the run whose name it carries in another case", async () => {
  const at = await scene();
  const provider = createStageWorkspaceProvider({ git: createHostGit({ env: fx.env }), removable: async () => run => run.itemId !== 8 });
  await provider.release(at.target.run, "all");
  // A run of item 7 with no folder, and its folder's name in capitals: a volume that folds case finds the one by the other.
  const runId = "run-case";
  const slug = runSlug(7, runId);
  expect(slug.toUpperCase()).not.toBe(slug);
  const given = new Map([[runId, { projectRoot: fx.repo, itemId: 7 }]]);
  expect(await provider.discard(given)).toEqual([runId]);
  const candidate = join(dirname(at.otherRoot), slug.toUpperCase());
  mkdirSync(candidate);
  try {
    expect(await provider.discard(given)).toEqual([]);
  } finally {
    rmSync(candidate, { recursive: true });
  }
  expect(await provider.discard(given)).toEqual([runId]);
});

describe.each(["release", "swept", "discarded"] as const)("what a %s with its project open may remove of a git run", (operation) => {
  it("with every field as it was written, the run's folder, registration and branch go and nothing else", async () => {
    const at = await scene();
    await operate(operation, at);
    expect(existsSync(at.runRoot)).toBe(false);
    expect(existsSync(at.admin)).toBe(false);
    expect(fx.userGit(fx.repo, "branch", "--list", at.branch)).toBe("");
    expectUsersOwn(at);
  });

  describe("a record changed in place", () => {
    let at: Scene;

    beforeAll(async () => {
      fx = gitFixture();
      shared = true;
      at = await scene();
    });

    afterAll(async () => {
      shared = false;
      await fx.done();
    });

    it.each(refused)("a record whose %s no longer matches stops it: nothing of the run goes", async (_field, path, value) => {
      writeFileSync(keptFile(), "kept\n");
      setPath(at.record, path, value(at));
      try {
        await operate(operation, at);
        expect(readFileSync(keptFile(), "utf8")).toBe("kept\n");
        expect(existsSync(join(at.stage, "a.txt"))).toBe(true);
        expect(existsSync(join(at.runRoot, JOIN_DIR, "a.txt"))).toBe(true);
        expectRepositoryUntouched(at);
        expectUsersOwn(at);
      } finally {
        writeFileSync(at.record, at.written);
      }
    });
  });

  it.each(repositoryLeft)("a record whose %s no longer matches leaves the repository as it is: the run folder goes, and the field is named", async (field, path, value) => {
    const at = await scene();
    setPath(at.record, path, value(at));
    await operate(operation, at);
    expect(existsSync(at.runRoot)).toBe(false);
    expectRepositoryUntouched(at);
    expectUsersOwn(at);
    expect(warned.filter(line => line.includes("repository is left as it is"))).toEqual([expect.stringContaining(field.split(".").slice(0, 2).join("."))]);
  });

  it.each(unverified)("a record whose %s is not the open project's by text leaves the run whole, its cleanup unverified", async (field, path, value) => {
    const at = await scene();
    setPath(at.record, path, value(at));
    await operate(operation, at);
    expectLeftWhole(at, field);
  });
});

it("a run folder that stays is reported once, however often it is found again", async () => {
  const at = await scene();
  setPath(at.record, ["joinDir"], "1:1");
  try {
    for (const operation of ["sweep", "discard", "sweep"] as const) await operate(operation);
    expect(warned.filter(line => line.includes("workspace stays as it is"))).toEqual([expect.stringContaining("joinDir")]);
  } finally {
    writeFileSync(at.record, at.written);
  }
});

/** The call that makes the run's branch. */
const makesBranch = (args: readonly string[]): boolean => args.includes("-b") || (args[0] === "update-ref" && args.at(-1) === "");

describe("the run branch", () => {
  it("update-ref with an empty old value creates only an absent ref", () => {
    const { repo, userGit } = fx;
    const base = userGit(repo, "rev-parse", "HEAD");
    write(repo, "c.txt", "two\n");
    const next = fx.commitAll("second");
    expect(code(repo, "update-ref", "refs/heads/pin", base, "")).toBe(0);
    expect(code(repo, "update-ref", "refs/heads/pin", base, "")).not.toBe(0);
    expect(code(repo, "update-ref", "refs/heads/pin", next, "")).not.toBe(0);
    expect(userGit(repo, "rev-parse", "refs/heads/pin")).toBe(base);
  });

  it("update-ref -d with an old value deletes only a ref still there", () => {
    const { repo, userGit } = fx;
    const base = userGit(repo, "rev-parse", "HEAD");
    write(repo, "c.txt", "two\n");
    const next = fx.commitAll("second");
    userGit(repo, "update-ref", "refs/heads/pin", next);
    expect(code(repo, "update-ref", "-d", "refs/heads/pin", base)).not.toBe(0);
    expect(userGit(repo, "rev-parse", "refs/heads/pin")).toBe(next);
    expect(code(repo, "update-ref", "-d", "refs/heads/absent", base)).not.toBe(0);
    expect(code(repo, "update-ref", "-d", "refs/heads/pin", next)).toBe(0);
    expect(code(repo, "rev-parse", "--verify", "--quiet", "refs/heads/pin")).toBe(1);
  });

  it("a worktree add into an empty folder the host made attaches to the run branch by its short name and keeps the folder", () => {
    const { repo, userGit } = fx;
    userGit(repo, "update-ref", "refs/heads/ave/workflow/pin", userGit(repo, "rev-parse", "HEAD"), "");
    const attached = join(fx.base, "attached");
    const detached = join(fx.base, "detached");
    for (const [folder, args] of [[attached, ["--no-checkout", "--end-of-options", attached, "ave/workflow/pin"]], [detached, ["--detach", "--no-checkout", "--end-of-options", detached, "HEAD"]]] as const) {
      mkdirSync(folder);
      const made = nodeIdOf(folder);
      expect(code(repo, "worktree", "add", ...args)).toBe(0);
      expect(nodeIdOf(folder)).toBe(made);
    }
    expect(userGit(attached, "symbolic-ref", "HEAD")).toBe("refs/heads/ave/workflow/pin");
    expect(code(detached, "symbolic-ref", "-q", "HEAD")).toBe(1);
  });

  it("an open that loses the race for its branch leaves the other branch", async () => {
    const { repo, userGit } = fx;
    const real = createHostGit({ env: fx.env });
    let raced = false;
    const run: HostGit["run"] = async (cwd, args, call) => {
      if (makesBranch(args) && !raced) {
        raced = true;
        userGit(repo, "branch", runBranch(handle.run.runId));
      }
      return real.run(cwd, args, call);
    };
    const handle = fx.start({ git: { run, drivers: real.drivers, floorHolds: real.floorHolds } });
    const base = userGit(repo, "rev-parse", "HEAD");
    expect(await handle.provider.open(handle.run, repo)).toEqual({ ok: false, code: "git-unavailable" });
    expect(raced).toBe(true);
    expect(userGit(repo, "rev-parse", runBranch(handle.run.runId))).toBe(base);
    expect(userGit(repo, "worktree", "list", "--porcelain").match(/^worktree /gmu)).toHaveLength(1);
  });

  it("an open whose branch creation ends without an answer leaves the branch", async () => {
    const { repo, userGit } = fx;
    const real = createHostGit({ env: fx.env });
    const run: HostGit["run"] = async (cwd, args, call) => {
      const result = await real.run(cwd, args, call);
      if (makesBranch(args)) throw new HostGitError("terminated", "fixture: no answer");
      return result;
    };
    const handle = fx.start({ git: { run, drivers: real.drivers, floorHolds: real.floorHolds } });
    const base = userGit(repo, "rev-parse", "HEAD");
    expect(await handle.provider.open(handle.run, repo)).toEqual({ ok: false, code: "git-unavailable" });
    // Whether git made the branch is not known, so it is not the run's to delete.
    expect(userGit(repo, "rev-parse", runBranch(handle.run.runId))).toBe(base);
    const root = realpathSync.native(repo);
    expect(existsSync(runRootOf(realpathSync.native(aveHome()), process.platform === "win32" ? root.toLowerCase() : root, handle.run.itemId, handle.run.runId))).toBe(false);
    expect(userGit(repo, "worktree", "list", "--porcelain").match(/^worktree /gmu)).toHaveLength(1);
  });
});

describe("worktree registrations", () => {
  const worktrees = (): string => join(fx.repo, ".git", "worktrees");
  const admins = (): string[] => existsSync(worktrees()) ? readdirSync(worktrees()).sort() : [];
  const added = (folder: string, ...config: string[]): number | null => {
    mkdirSync(folder, { recursive: true });
    return code(fx.repo, ...config, "worktree", "add", "--detach", folder, "HEAD");
  };
  /** The user's worktree whose folder is gone: git would call it prunable. */
  function missingUserWorktree(): string {
    const userwt = join(fx.base, "userwt");
    expect(added(userwt)).toBe(0);
    const admin = adminOf(userwt);
    rmSync(userwt, { recursive: true, force: true });
    return admin;
  }

  it.skipIf(process.platform !== "win32")("a failed worktree add removes the folder it was given", () => {
    const { repo, userGit } = fx;
    // A tree with a name no folder here can hold: the checkout of the new worktree fails after git registered it.
    userGit(repo, "-c", "core.protectNTFS=false", "update-index", "--add", "--cacheinfo", `100644,${userGit(repo, "rev-parse", "HEAD:a.txt")},bad:name`);
    userGit(repo, "-c", "core.protectNTFS=false", "commit", "-q", "-m", "a name that cannot be checked out");
    const folder = join(fx.base, "failed");
    expect(added(folder)).not.toBe(0);
    expect(existsSync(folder)).toBe(false);
    expect(admins()).toEqual([]);
  });

  it("a second worktree with a taken basename gets a suffixed admin name", () => {
    const first = join(fx.base, "one", "_join");
    const second = join(fx.base, "two", "_join");
    expect([added(first), added(second)]).toEqual([0, 0]);
    expect(basename(adminOf(first))).toBe("_join");
    expect(basename(adminOf(second))).not.toBe("_join");
    expect(admins()).toHaveLength(2);
  });

  it("a missing registration blocks an add to its path until its admin folder goes", () => {
    const folder = join(fx.base, "again");
    expect(added(folder)).toBe(0);
    const admin = adminOf(folder);
    rmSync(folder, { recursive: true, force: true });
    expect(added(folder)).toBe(128);
    rmSync(admin, { recursive: true, force: true });
    expect(added(folder)).toBe(0);
  });

  it("the .git file and the admin gitdir name each other", () => {
    for (const relative of ["false", "true"]) {
      const folder = join(fx.base, `links-${relative}`);
      expect(added(folder, "-c", `worktree.useRelativePaths=${relative}`), relative).toBe(0);
      const link = readFileSync(join(folder, ".git"), "utf8").replace(/^gitdir: /u, "").trim();
      expect(isAbsolute(link), relative).toBe(relative === "false");
      const admin = resolve(folder, link);
      expect(realpathSync.native(dirname(admin)), relative).toBe(realpathSync.native(worktrees()));
      expect(realpathSync.native(resolve(admin, readFileSync(join(admin, "gitdir"), "utf8").trim())), relative).toBe(realpathSync.native(join(folder, ".git")));
    }
  });

  it("a stage retry succeeds beside the user's missing worktree", async () => {
    const userAdmin = missingUserWorktree();
    const handle = fx.start();
    expect(await handle.provider.open(handle.run, fx.repo)).toMatchObject({ ok: true });
    await stageRoot(handle, "s1");
    await handle.provider.release(handle.run, ["s1"]);
    expect(existsSync(join(await stageRoot(handle, "s1", 2), "a.txt"))).toBe(true);
    expect(existsSync(userAdmin)).toBe(true);
  });

  it("release takes the run's registrations even while the user has a missing worktree", async () => {
    const userAdmin = missingUserWorktree();
    const handle = fx.start();
    expect(await handle.provider.open(handle.run, fx.repo)).toMatchObject({ ok: true });
    await stageRoot(handle, "s1");
    expect(admins()).toHaveLength(3);
    await handle.provider.release(handle.run, "all");
    expect(admins()).toEqual([basename(userAdmin)]);
  });

  it("release leaves malformed, duplicate and copied registrations alone", async () => {
    const dupwt = join(fx.base, "dupwt");
    expect(added(dupwt)).toBe(0);
    const handle = fx.start();
    const open = await handle.provider.open(handle.run, fx.repo);
    if (!open.ok) throw new Error(open.code);
    const ours = [adminOf(join(open.workspace.runRoot, JOIN_DIR)), adminOf(await stageRoot(handle, "s1"))];
    write(worktrees(), "broken/HEAD", "ref: refs/heads/main\n");
    cpSync(adminOf(dupwt), join(worktrees(), "dupwt2"), { recursive: true });
    cpSync(ours[0] as string, join(worktrees(), "_joincopy"), { recursive: true });
    await handle.provider.release(handle.run, "all");
    expect(ours.map(admin => existsSync(admin))).toEqual([false, false]);
    expect(admins()).toEqual(["_joincopy", "broken", "dupwt", "dupwt2"]);
    expect(existsSync(open.workspace.runRoot)).toBe(false);
  });
});

describe("the repository's identity", () => {
  it("rev-parse --path-format=absolute --git-common-dir names the common dir from a linked worktree too", () => {
    const { repo, userGit } = fx;
    const linked = join(fx.base, "linked");
    userGit(repo, "worktree", "add", "-q", "--detach", linked);
    for (const cwd of [repo, linked]) {
      const named = userGit(cwd, "rev-parse", "--path-format=absolute", "--git-common-dir");
      expect(isAbsolute(named), cwd).toBe(true);
      expect(realpathSync.native(named), cwd).toBe(realpathSync.native(join(repo, ".git")));
    }
  });

  it("a child repository replaced by a plain folder leaves the parent's ref alone", async () => {
    const { repo, userGit } = fx;
    const child = join(repo, "child");
    userGit(repo, "clone", "-q", repo, child);
    const handle = fx.start({}, 7, child);
    const open = await handle.provider.open(handle.run, child);
    const base = open.ok && open.workspace.kind === "git" ? open.workspace.baseCommit : undefined;
    if (!open.ok || base === undefined) throw new Error("expected a git workspace");
    await stageRoot(handle, "s1");
    // The child is now a plain folder of the parent's work tree, and the parent has a branch of the run's name at the run's commit.
    removeTree(join(child, ".git"), fx.base);
    const branch = runBranch(handle.run.runId);
    userGit(repo, "update-ref", `refs/heads/${branch}`, base);
    const listed = userGit(repo, "worktree", "list", "--porcelain");
    await handle.provider.release(handle.run, "all");
    await createStageWorkspaceProvider({ git: createHostGit({ env: fx.env }), removable: async () => () => true }).sweep([]);
    expect(userGit(repo, "rev-parse", `refs/heads/${branch}`)).toBe(base);
    expect(userGit(repo, "worktree", "list", "--porcelain")).toBe(listed);
    // The repository git now gives for the project is not the record's by text: the run stays whole, with its record.
    expect(existsSync(join(open.workspace.runRoot, RUN_FILE))).toBe(true);
    // The sweep has no project open at all.
    expect(warned.filter(line => line.includes("cleanup is unverified") && line.includes(handle.run.runId))).toEqual([expect.stringContaining("repo.gitDir"), expect.stringContaining("project.root")]);
  });
});

it("a join folder whose worktree link was pointed at another worktree gets no merge", async () => {
  const { repo, userGit } = fx;
  const userwt = join(fx.base, "userwt");
  userGit(repo, "worktree", "add", "-q", "--detach", userwt);
  const handle = fx.start();
  const open = await handle.provider.open(handle.run, repo);
  if (!open.ok) throw new Error(open.code);
  write(await stageRoot(handle, "s1"), "new.txt", "new\n");
  await sealed(handle, "s1");
  const link = join(open.workspace.runRoot, JOIN_DIR, ".git");
  const written = readFileSync(link, "utf8");
  const head = userGit(userwt, "rev-parse", "HEAD");
  const relink = (text: string): void => {
    rmSync(link, { force: true });
    writeFileSync(link, text);
  };
  relink(readFileSync(join(userwt, ".git"), "utf8"));
  try {
    await expect(handle.provider.integrate(handle.run, "j1", ["s1"])).rejects.toThrow();
    expect(userGit(userwt, "rev-parse", "HEAD")).toBe(head);
    expect(existsSync(join(userwt, "new.txt"))).toBe(false);
  } finally {
    relink(written);
  }
});

/** A run with two sealed stages that both changed `a.txt`: collecting them is a real conflict. */
async function conflicting(git?: HostGit): Promise<{ handle: GitHandle; record: string }> {
  const handle = fx.start(git === undefined ? {} : { git });
  const open = await handle.provider.open(handle.run, fx.repo);
  if (!open.ok) throw new Error(open.code);
  for (const stageId of ["s1", "s2"]) write(await stageRoot(handle, stageId), "a.txt", `from ${stageId}\n`);
  for (const stageId of ["s1", "s2"]) await sealed(handle, stageId);
  return { handle, record: join(open.workspace.runRoot, RUN_FILE) };
}

it("a stage's commit that the record gives as an option is no record: a join conflict writes no file it names", async () => {
  const { handle, record } = await conflicting();
  const written = readFileSync(record, "utf8");
  writeFileSync(keptFile(), "kept\n");
  setPath(record, ["stages", "s1", "base"], `--output=${keptFile()}`);
  try {
    await expect(handle.provider.integrate(handle.run, "j1", ["s1", "s2"])).rejects.toThrow("the run has no workspace");
    expect(readFileSync(keptFile(), "utf8")).toBe("kept\n");
  } finally {
    writeFileSync(record, written);
  }
  expect(await handle.provider.integrate(handle.run, "j1", ["s1", "s2"])).toMatchObject({ ok: false, conflict: { reason: "merge-conflict", files: [{ path: "a.txt", stageIds: ["s1", "s2"] }] } });
});

it("every commit and ref git is given comes after the end of its options", async () => {
  const real = createHostGit({ env: fx.env });
  const calls: (readonly string[])[] = [];
  const { handle } = await conflicting({ drivers: real.drivers, floorHolds: real.floorHolds, run: (cwd, args, call) => { calls.push(args); return real.run(cwd, args, call); } });
  expect(await handle.provider.integrate(handle.run, "j1", ["s1", "s2"])).toMatchObject({ ok: false });
  await handle.provider.release(handle.run, "all");
  const branch = runBranch(handle.run.runId);
  const revision = (arg: string): boolean => /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(arg) || arg === branch || arg.startsWith(`refs/heads/${branch}`);
  const given = calls.filter(args => args.some(revision));
  // The branch's making and removal, both worktrees' making, the branch head's reading, and the join's ancestry test, merge and comparison.
  expect(new Set(given.map(args => args[0]))).toEqual(new Set(["update-ref", "worktree", "rev-parse", "merge-base", "merge", "diff"]));
  for (const args of given) expect(args.slice(0, args.findIndex(revision)), args.join(" ")).toContain("--end-of-options");
});

it("a release that git gives no answer to about the repository leaves the run whole: no answer is not another repository", async () => {
  const at = await scene();
  const real = createHostGit({ env: fx.env });
  const git: HostGit = {
    drivers: real.drivers, floorHolds: real.floorHolds,
    run: (cwd, args, call) => args.includes("--git-common-dir") ? Promise.reject(new HostGitError("timeout", "git gave no answer")) : real.run(cwd, args, call),
  };
  await createStageWorkspaceProvider({ git }).release(at.target.run, "all");
  expectLeftWhole(at, "repo.gitDir");
  await operate("release", at);
  expect(existsSync(at.runRoot)).toBe(false);
  expect(existsSync(at.admin)).toBe(false);
});

it("git in a folder of the run is given the registration the host checked: a link swapped after the check directs nothing", async () => {
  const { repo, userGit } = fx;
  const elsewhere = join(fx.base, "elsewhere");
  mkdirSync(elsewhere);
  userGit(elsewhere, "init", "-q");
  userGit(elsewhere, "-c", "user.name=Bob Example", "-c", "user.email=bob@example.com", "commit", "-q", "--allow-empty", "-m", "first");
  const decoy = join(fx.base, "decoy");
  userGit(elsewhere, "worktree", "add", "-q", "--detach", decoy);
  const decoyLink = `gitdir: ${adminOf(decoy)}\n`;
  const real = createHostGit({ env: fx.env });
  let runRoot = "";
  let swaps = 0;
  // Every git call in a folder of the run finds that folder's link pointing into the other repository, from after the host's check
  // until the call is over.
  const git: HostGit = {
    drivers: real.drivers, floorHolds: real.floorHolds,
    run: async (cwd, args, call) => {
      if (runRoot === "" || !resolve(cwd).toLowerCase().startsWith(runRoot.toLowerCase())) return real.run(cwd, args, call);
      const link = readFileSync(join(cwd, ".git"), "utf8");
      const put = (text: string): void => { rmSync(join(cwd, ".git")); writeFileSync(join(cwd, ".git"), text); };
      put(decoyLink);
      swaps += 1;
      try { return await real.run(cwd, args, call); } finally { put(link); }
    },
  };
  const handle = fx.start({ git });
  const open = await handle.provider.open(handle.run, repo);
  if (!open.ok) throw new Error(open.code);
  const stage = await stageRoot(handle, "s1");
  // From here on: the seal and the collection.
  runRoot = resolve(open.workspace.runRoot);
  write(stage, "a.txt", "two\n");
  write(stage, "new.txt", "new\n");
  const result = await handle.provider.seal(handle.run, "s1");
  // The other repository saw none of it: no entry staged, no commit.
  expect(userGit(decoy, "diff", "--cached", "--name-only")).toBe("");
  const seal = result.ok ? result.sealCommit : undefined;
  expect(seal).toBeDefined();
  expect(await handle.provider.integrate(handle.run, "j1", ["s1"])).toEqual({ ok: true });
  expect(swaps).toBeGreaterThan(4);
  const branch = runBranch(handle.run.runId);
  expect(userGit(repo, "show", `${branch}:a.txt`)).toBe("two");
  expect(userGit(repo, "show", `${seal}:new.txt`)).toBe("new");
  expect(userGit(decoy, "diff", "--cached", "--name-only")).toBe("");
  expect(userGit(elsewhere, "rev-list", "--all", "--count")).toBe("1");
  expect(code(elsewhere, "cat-file", "-e", `${seal}^{commit}`)).not.toBe(0);
});
