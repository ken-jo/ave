import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
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

/** The admin folder a worktree's `.git` file names. */
const adminOf = (worktree: string): string => resolve(worktree, readFileSync(join(worktree, ".git"), "utf8").replace(/^gitdir: /u, "").trim());

/**
 * Item 7's run, parked with a sealed stage and nothing collected, so that a release takes its branch too; item 8's run of the same
 * project with a stage collected onto its branch; and the user's own branch, worktree and second repository.
 */
interface Scene {
  target: GitHandle; runRoot: string; record: string; written: string; stage: string; admin: string; branch: string;
  base: string; other: GitHandle; userwt: string; userAdmin: string; elsewhere: string;
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
  if (!(await other.provider.open(other.run, repo)).ok) throw new Error("open refused");
  write(await stageRoot(other, "s1"), "new.txt", "new\n");
  await sealed(other, "s1");
  expect(await other.provider.integrate(other.run, "j1", ["s1"])).toEqual({ ok: true });

  const record = join(runRoot, RUN_FILE);
  return {
    target, runRoot, record, written: readFileSync(record, "utf8"), stage, admin: adminOf(join(runRoot, JOIN_DIR)), branch: runBranch(target.run.runId),
    base, other, userwt, userAdmin: adminOf(userwt), elsewhere,
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
];

/** A field that names the project or its repository: the run folder is still the run's and goes; the repository is left as it is. */
const repositoryLeft: Row[] = [
  ["project.id", ["project", "id"], () => "1:1"],
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
    expect(warned.filter(line => line.includes("repository is left as it is"))).toEqual([expect.stringContaining(field)]);
  });
});

/** The call that makes the run's branch. */
const makesBranch = (args: readonly string[]): boolean => args.includes("-b") || (args[0] === "update-ref" && args.length === 4 && args[3] === "");

describe("the run branch", () => {
  const code = (cwd: string, ...args: string[]): number | null => spawnSync("git", args, { cwd, env: fx.env, encoding: "utf8" }).status;

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
