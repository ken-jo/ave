import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { aveHome } from "../../../shared/ave-home.js";
import { createHostGit, type HostGit, HostGitError } from "../host-git.js";
import { nodeIdOf } from "../owned-fs.js";
import { createStageWorkspaceProvider } from "../stage-workspaces.js";
import { JOIN_DIR, RUN_FILE, runBranch, runRootOf } from "../workspace-layout.js";
import { setPath, writeUnder as write } from "./stage-fixtures.js";
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

/** As after a restart, with item 7 gone from the board and item 8 still on it. */
async function operate(operation: "discard" | "sweep"): Promise<void> {
  const provider = createStageWorkspaceProvider({ git: createHostGit({ env: fx.env }), removable: async () => run => run.itemId !== 8 });
  await (operation === "discard" ? provider.discard() : provider.sweep([]));
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
];

/** A field that names the project or its repository: the run folder is still the run's and goes; the repository is left as it is. */
const repositoryLeft: Row[] = [
  ["project.id", ["project", "id"], () => "1:1"],
  ["repo.gitDir", ["repo", "gitDir"], at => join(at.elsewhere, ".git")],
  ["repo.id", ["repo", "id"], () => "1:1"],
  ["registrations._join.admin", ["registrations", "_join", "admin"], at => at.userAdmin],
  ["registrations._join.id", ["registrations", "_join", "id"], () => "1:1"],
];

describe.each(["discard", "sweep"] as const)("what a %s may remove of a git run", (operation) => {
  it("with every field as it was written, the run's folder, registration and branch go and nothing else", async () => {
    const at = await scene();
    await operate(operation);
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
      setPath(at.record, path, value(at));
      try {
        await operate(operation);
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
    await operate(operation);
    expect(existsSync(at.runRoot)).toBe(false);
    expectRepositoryUntouched(at);
    expectUsersOwn(at);
    expect(warned.filter(line => line.includes("repository is left as it is"))).toEqual([expect.stringContaining(field.split(".").slice(0, 2).join("."))]);
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
const makesBranch = (args: readonly string[]): boolean => args.includes("-b") || (args[0] === "update-ref" && args.length === 4 && args[3] === "");

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
    for (const [folder, args] of [[attached, [attached, "ave/workflow/pin"]], [detached, ["--detach", detached, "HEAD"]]] as const) {
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
    const handle = fx.start({ git: { run, drivers: real.drivers } });
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
    const handle = fx.start({ git: { run, drivers: real.drivers } });
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
    const handle = fx.start();
    const open = await handle.provider.open(handle.run, child);
    const base = open.ok && open.workspace.kind === "git" ? open.workspace.baseCommit : undefined;
    if (!open.ok || base === undefined) throw new Error("expected a git workspace");
    await stageRoot(handle, "s1");
    // The child is now a plain folder of the parent's work tree, and the parent has a branch of the run's name at the run's commit.
    rmSync(join(child, ".git"), { recursive: true, force: true });
    const branch = runBranch(handle.run.runId);
    userGit(repo, "update-ref", `refs/heads/${branch}`, base);
    const listed = userGit(repo, "worktree", "list", "--porcelain");
    await handle.provider.release(handle.run, "all");
    await createStageWorkspaceProvider({ git: createHostGit({ env: fx.env }), removable: async () => () => true }).sweep([]);
    expect(userGit(repo, "rev-parse", `refs/heads/${branch}`)).toBe(base);
    expect(userGit(repo, "worktree", "list", "--porcelain")).toBe(listed);
    expect(existsSync(open.workspace.runRoot)).toBe(false);
    expect(warned.filter(line => line.includes("repository is left as it is"))).toEqual([expect.stringContaining("repo.gitDir")]);
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
  writeFileSync(link, readFileSync(join(userwt, ".git"), "utf8"));
  try {
    await expect(handle.provider.integrate(handle.run, "j1", ["s1"])).rejects.toThrow();
    expect(userGit(userwt, "rev-parse", "HEAD")).toBe(head);
    expect(existsSync(join(userwt, "new.txt"))).toBe(false);
  } finally {
    writeFileSync(link, written);
  }
});
