import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHostGit } from "../host-git.js";
import type { RunRef } from "../stage-workspace.js";
import { createStageWorkspaceProvider } from "../stage-workspaces.js";
import { JOIN_DIR, RUN_FILE, runBranch } from "../workspace-layout.js";
import { stageOf, writeUnder as write } from "./stage-fixtures.js";

let base: string;
let repo: string;
let env: NodeJS.ProcessEnv;
let runs = 0;
const opened: { provider: ReturnType<typeof createStageWorkspaceProvider>; run: RunRef }[] = [];

/** Plain git, the way the user would run it: hooks and drivers active. */
const userGit = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const commitAll = (message: string): string => { userGit(repo, "add", "-A"); userGit(repo, "commit", "-q", "-m", message); return userGit(repo, "rev-parse", "HEAD"); };

function start(): { provider: ReturnType<typeof createStageWorkspaceProvider>; run: RunRef } {
  runs += 1;
  const run: RunRef = { itemId: 7, runId: `run-git-${process.pid}-${Date.now()}-${runs}`, runKey: "key" };
  const handle = { provider: createStageWorkspaceProvider({ git: createHostGit({ env }) }), run };
  opened.push(handle);
  return handle;
}

async function stageRoot(handle: ReturnType<typeof start>, stageId: string, attempt = 1): Promise<string> {
  const prepared = await handle.provider.prepare(handle.run, stageOf(stageId), attempt);
  if (!prepared.ok) throw new Error(`prepare refused: ${prepared.code}`);
  return prepared.workspace.root;
}

async function sealed(handle: ReturnType<typeof start>, stageId: string): Promise<string | undefined> {
  const result = await handle.provider.seal(handle.run, stageId);
  if (!result.ok) throw new Error(`seal refused: ${result.code}`);
  return result.sealCommit;
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "swg-"));
  repo = join(base, "project");
  mkdirSync(repo);
  writeFileSync(join(base, "gitconfig"), "[core]\n\tautocrlf = false\n[init]\n\tdefaultBranch = main\n");
  env = { ...process.env, GIT_CONFIG_GLOBAL: join(base, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1" };
  userGit(repo, "init", "-q");
  userGit(repo, "config", "user.name", "Alice Example");
  userGit(repo, "config", "user.email", "alice@example.com");
  write(repo, "a.txt", "one\n");
  write(repo, "b.txt", "one\n");
  commitAll("first");
});

afterEach(async () => {
  for (const { provider, run } of opened.splice(0)) await provider.release(run, "all");
});

describe("git stage workspaces", () => {
  it("each stage gets its own worktree from the run branch head", async () => {
    const handle = start();
    const open = await handle.provider.open(handle.run, repo);
    expect(open).toMatchObject({ ok: true, workspace: { kind: "git", branch: runBranch(handle.run.runId), baseCommit: userGit(repo, "rev-parse", "HEAD") } });
    const first = await stageRoot(handle, "s1");
    const second = await stageRoot(handle, "s2");
    expect(first).not.toBe(second);
    expect(readFileSync(join(first, "a.txt"), "utf8")).toBe("one\n");
    // Detached at the head of the run branch, not on the user's branch.
    expect(userGit(first, "rev-parse", "HEAD")).toBe(userGit(repo, "rev-parse", runBranch(handle.run.runId)));
    expect(() => userGit(first, "symbolic-ref", "-q", "HEAD")).toThrow();
    // A repeated prepare is the same folder with its files.
    write(first, "kept.txt", "kept\n");
    expect(await stageRoot(handle, "s1")).toBe(first);
    expect(existsSync(join(first, "kept.txt"))).toBe(true);

    write(first, "from-s1.txt", "s1\n");
    await sealed(handle, "s1");
    expect(await handle.provider.integrate(handle.run, "j1", ["s1"])).toEqual({ ok: true });
    // A stage prepared after the join starts from what the join collected.
    const third = await stageRoot(handle, "s3");
    expect(readFileSync(join(third, "from-s1.txt"), "utf8")).toBe("s1\n");
    expect(existsSync(join(second, "from-s1.txt"))).toBe(false);
  });

  it("the join merges both stages onto ave/workflow/<run> and leaves the user's branch, index and files unchanged", async () => {
    write(repo, "staged.txt", "staged\n");
    userGit(repo, "add", "staged.txt");
    write(repo, "a.txt", "edited by the user, not committed\n");
    const before = { head: userGit(repo, "rev-parse", "HEAD"), branch: userGit(repo, "symbolic-ref", "HEAD"), status: userGit(repo, "status", "--porcelain"), index: userGit(repo, "ls-files", "-s") };

    const handle = start();
    await handle.provider.open(handle.run, repo);
    const first = await stageRoot(handle, "s1");
    const second = await stageRoot(handle, "s2");
    // The user's uncommitted edit is not in a stage: a worktree starts from the commit.
    expect(readFileSync(join(first, "a.txt"), "utf8")).toBe("one\n");
    write(first, "a.txt", "one\ns1\n");
    write(second, "c.txt", "s2\n");
    const seals = [await sealed(handle, "s1"), await sealed(handle, "s2")];
    expect(seals.every(seal => typeof seal === "string")).toBe(true);
    expect(await handle.provider.integrate(handle.run, "j1", ["s1", "s2"])).toEqual({ ok: true });
    // Repetition installs nothing more.
    const collected = userGit(repo, "rev-parse", runBranch(handle.run.runId));
    expect(await handle.provider.integrate(handle.run, "j1", ["s1", "s2"])).toEqual({ ok: true });
    expect(userGit(repo, "rev-parse", runBranch(handle.run.runId))).toBe(collected);

    expect(userGit(repo, "show", `${runBranch(handle.run.runId)}:a.txt`)).toBe("one\ns1");
    expect(userGit(repo, "show", `${runBranch(handle.run.runId)}:c.txt`)).toBe("s2");
    expect({ head: userGit(repo, "rev-parse", "HEAD"), branch: userGit(repo, "symbolic-ref", "HEAD"), status: userGit(repo, "status", "--porcelain"), index: userGit(repo, "ls-files", "-s") }).toEqual(before);
    expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("edited by the user, not committed\n");
  });

  it("a conflicting join returns the files and stages and leaves _join clean", async () => {
    const handle = start();
    const open = await handle.provider.open(handle.run, repo);
    if (!open.ok) throw new Error(open.code);
    const first = await stageRoot(handle, "s1");
    const second = await stageRoot(handle, "s2");
    write(first, "a.txt", "from s1\n");
    write(first, "only-s1.txt", "s1\n");
    write(second, "a.txt", "from s2\n");
    await sealed(handle, "s1");
    await sealed(handle, "s2");
    const result = await handle.provider.integrate(handle.run, "j1", ["s1", "s2"]);
    expect(result).toMatchObject({ ok: false, conflict: { reason: "merge-conflict", files: [{ path: "a.txt", stageIds: ["s1", "s2"] }] } });
    if (result.ok) throw new Error("expected a conflict");
    expect(result.conflict.conflictHash).toMatch(/^[0-9a-f]{64}$/u);
    const joinDir = join(open.workspace.runRoot, JOIN_DIR);
    expect(userGit(joinDir, "status", "--porcelain")).toBe("");
    expect(() => userGit(joinDir, "rev-parse", "--verify", "--quiet", "MERGE_HEAD")).toThrow();
    // Nothing was force-merged: the second stage's answer is not on the run branch.
    expect(userGit(joinDir, "show", "HEAD:a.txt")).toBe("from s1");
    // The same conflict has the same hash; the gate's decision is bound to it.
    const again = await handle.provider.integrate(handle.run, "j1", ["s1", "s2"]);
    expect(again.ok === false && again.conflict.conflictHash).toBe(result.conflict.conflictHash);
  });

  it("retry merge succeeds after the conflict is resolved", async () => {
    const handle = start();
    const open = await handle.provider.open(handle.run, repo);
    if (!open.ok) throw new Error(open.code);
    const first = await stageRoot(handle, "s1");
    const second = await stageRoot(handle, "s2");
    write(first, "a.txt", "from s1\n");
    write(second, "a.txt", "from s2\n");
    await sealed(handle, "s1");
    const secondSeal = await sealed(handle, "s2") as string;
    expect((await handle.provider.integrate(handle.run, "j1", ["s1", "s2"])).ok).toBe(false);

    // The user resolves in the integration folder. While they are in the middle, a retry touches nothing of theirs.
    const joinDir = join(open.workspace.runRoot, JOIN_DIR);
    expect(() => userGit(joinDir, "merge", "--no-edit", secondSeal)).toThrow();
    write(joinDir, "a.txt", "resolved by the user\n");
    const midway = await handle.provider.integrate(handle.run, "j1", ["s1", "s2"]);
    expect(midway).toMatchObject({ ok: false, conflict: { reason: "merge-conflict" } });
    expect(readFileSync(join(joinDir, "a.txt"), "utf8")).toBe("resolved by the user\n");
    expect(userGit(joinDir, "rev-parse", "MERGE_HEAD")).toBe(secondSeal);

    userGit(joinDir, "add", "a.txt");
    userGit(joinDir, "commit", "-q", "--no-edit");
    expect(await handle.provider.integrate(handle.run, "j1", ["s1", "s2"])).toEqual({ ok: true });
    expect(userGit(repo, "show", `${runBranch(handle.run.runId)}:a.txt`)).toBe("resolved by the user");
  });

  it("the seal commit carries the user's identity and the run and stage trailers", async () => {
    const handle = start();
    await handle.provider.open(handle.run, repo);
    const root = await stageRoot(handle, "s1");
    // An empty diff seals nothing.
    expect(await sealed(handle, "s1")).toBeUndefined();
    expect(userGit(root, "rev-parse", "HEAD")).toBe(userGit(repo, "rev-parse", "HEAD"));

    const other = await stageRoot(handle, "s2");
    write(other, "new.txt", "new\n");
    const seal = await sealed(handle, "s2") as string;
    expect(userGit(repo, "log", "-1", "--format=%an|%ae|%cn|%ce", seal)).toBe("Alice Example|alice@example.com|Alice Example|alice@example.com");
    const body = userGit(repo, "log", "-1", "--format=%B", seal);
    expect(body).toContain(`Ave-Run: ${handle.run.runId}`);
    expect(body).toContain("Ave-Stage: s2");
    expect(userGit(repo, "show", "--name-only", "--format=", seal)).toBe("new.txt");
    // The same seal again, without another commit.
    write(other, "later.txt", "later\n");
    expect(await sealed(handle, "s2")).toBe(seal);
  });

  it("seal refuses without a user identity", async () => {
    userGit(repo, "config", "--unset", "user.name");
    userGit(repo, "config", "--unset", "user.email");
    const handle = start();
    await handle.provider.open(handle.run, repo);
    const root = await stageRoot(handle, "s1");
    write(root, "new.txt", "new\n");
    expect(await handle.provider.seal(handle.run, "s1")).toEqual({ ok: false, code: "identity-missing" });
    expect(userGit(root, "rev-parse", "HEAD")).toBe(userGit(repo, "rev-parse", "HEAD"));
    expect(userGit(root, "diff", "--cached", "--name-only")).toBe("");
    // The join gate names the same cause.
    userGit(repo, "config", "user.name", "Alice Example");
    userGit(repo, "config", "user.email", "alice@example.com");
    await sealed(handle, "s1");
    userGit(repo, "config", "--unset", "user.email");
    expect(await handle.provider.integrate(handle.run, "j1", ["s1"])).toMatchObject({ ok: false, conflict: { reason: "identity-missing", files: [] } });
  });

  it("a repository hook, a clean filter and a textconv driver do not run during prepare, seal or integrate", async () => {
    const marks = join(base, "marks");
    mkdirSync(marks);
    const mark = (name: string): string => `echo ran >> '${join(marks, name).replace(/\\/g, "/")}'`;
    for (const hook of ["pre-commit", "post-commit", "post-checkout", "pre-merge-commit", "post-merge", "commit-msg"]) {
      writeFileSync(join(repo, ".git", "hooks", hook), `#!/bin/sh\n${mark(`hook-${hook}`)}\n`, { mode: 0o755 });
    }
    // Each driver is a script file, so no quoting rule of the configuration is in play.
    const driver = (name: string, then: string): string => {
      writeFileSync(join(base, `${name}.sh`), `${mark(name)}\n${then}\n`);
      return `sh '${join(base, `${name}.sh`).replace(/\\/g, "/")}'`;
    };
    userGit(repo, "config", "filter.mark.clean", driver("clean", "cat"));
    userGit(repo, "config", "filter.mark.smudge", driver("smudge", "cat"));
    userGit(repo, "config", "diff.mark.textconv", driver("textconv", 'cat "$1"'));
    userGit(repo, "config", "merge.mark.driver", driver("merge", "exit 0"));
    write(repo, ".gitattributes", "*.txt filter=mark diff=mark merge=mark\n");
    write(repo, "a.txt", "two\n");
    commitAll("drivers");
    // Control: the user's own git runs them.
    userGit(repo, "diff", "HEAD~1", "HEAD", "--", "a.txt");
    for (const name of ["hook-pre-commit", "hook-post-commit", "clean", "textconv"]) expect(existsSync(join(marks, name)), name).toBe(true);
    rmSync(marks, { recursive: true, force: true });
    mkdirSync(marks);

    const handle = start();
    const open = await handle.provider.open(handle.run, repo);
    if (!open.ok) throw new Error(open.code);
    const first = await stageRoot(handle, "s1");
    const second = await stageRoot(handle, "s2");
    write(first, "a.txt", "from s1\n");
    write(second, "a.txt", "from s2\n");
    write(second, "b.txt", "one\ns2\n");
    await sealed(handle, "s1");
    await sealed(handle, "s2");
    // The configured merge driver would have "resolved" this; it never runs, so the join reports the conflict.
    expect(await handle.provider.integrate(handle.run, "j1", ["s1", "s2"])).toMatchObject({ ok: false, conflict: { reason: "merge-conflict", files: [{ path: "a.txt" }] } });
    await handle.provider.release(handle.run, "all");
    expect(readdirSync(marks)).toEqual([]);
  });

  it("a repository that requires a filter driver gets no git workspace", async () => {
    userGit(repo, "config", "filter.need.clean", "cat");
    userGit(repo, "config", "filter.need.smudge", "cat");
    userGit(repo, "config", "filter.need.required", "true");
    write(repo, ".gitattributes", "*.txt filter=need\n");
    commitAll("required filter");
    const handle = start();
    expect(await handle.provider.open(handle.run, repo)).toEqual({ ok: false, code: "git-unavailable" });
    expect(userGit(repo, "branch", "--list", "ave/*")).toBe("");
    expect(userGit(repo, "worktree", "list", "--porcelain").match(/^worktree /gmu)).toHaveLength(1);
  });

  it("a tracked secret file is absent from the stage folder and is not committed as a deletion", async () => {
    write(repo, ".env", "TOKEN=fixture\n");
    commitAll("tracked secret");
    const handle = start();
    await handle.provider.open(handle.run, repo);
    const root = await stageRoot(handle, "s1");
    expect(existsSync(join(root, ".env"))).toBe(false);
    expect(existsSync(join(repo, ".env"))).toBe(true);
    write(root, "new.txt", "new\n");
    write(root, "keys/id_rsa", "fixture\n");
    const seal = await sealed(handle, "s1") as string;
    expect(userGit(repo, "show", "--name-status", "--format=", seal)).toBe("A\tnew.txt");
    expect(userGit(repo, "show", `${seal}:.env`)).toBe("TOKEN=fixture");
  });

  it("release removes worktrees and keeps the run branch", async () => {
    const handle = start();
    const open = await handle.provider.open(handle.run, repo);
    if (!open.ok) throw new Error(open.code);
    const first = await stageRoot(handle, "s1");
    const second = await stageRoot(handle, "s2");
    write(first, "new.txt", "new\n");
    await sealed(handle, "s1");
    await handle.provider.integrate(handle.run, "j1", ["s1"]);
    await handle.provider.release(handle.run, ["s1"]);
    expect(existsSync(first)).toBe(false);
    expect(existsSync(second)).toBe(true);
    await handle.provider.release(handle.run, "all");
    expect(existsSync(open.workspace.runRoot)).toBe(false);
    expect(userGit(repo, "worktree", "list", "--porcelain").match(/^worktree /gmu)).toHaveLength(1);
    expect(userGit(repo, "show", `${runBranch(handle.run.runId)}:new.txt`)).toBe("new");

    // A run that collected nothing leaves no branch behind.
    const empty = start();
    await empty.provider.open(empty.run, repo);
    await stageRoot(empty, "s1");
    await empty.provider.release(empty.run, "all");
    expect(userGit(repo, "branch", "--list", runBranch(empty.run.runId))).toBe("");
  });

  it("finds the run again after a restart and sweeps only runs that are not active", async () => {
    const kept = start();
    const gone = start();
    const keptOpen = await kept.provider.open(kept.run, repo);
    const goneOpen = await gone.provider.open(gone.run, repo);
    if (!keptOpen.ok || !goneOpen.ok) throw new Error("open refused");
    const root = await stageRoot(kept, "s1");
    await stageRoot(gone, "s1");
    const restarted = createStageWorkspaceProvider({ git: createHostGit({ env }) });
    await restarted.sweep([kept.run.runId]);
    expect(existsSync(goneOpen.workspace.runRoot)).toBe(false);
    expect(existsSync(root)).toBe(true);
    write(root, "new.txt", "new\n");
    expect((await restarted.seal(kept.run, "s1")).ok).toBe(true);
  });

  it("a record copied into another folder, or naming another repository or branch, directs no cleanup", async () => {
    const other = join(base, "other");
    mkdirSync(other);
    userGit(other, "init", "-q");
    userGit(other, "config", "user.name", "Bob Example");
    userGit(other, "config", "user.email", "bob@example.com");
    write(other, "o.txt", "one\n");
    userGit(other, "add", "-A");
    userGit(other, "commit", "-q", "-m", "first");
    userGit(other, "branch", "keep");
    userGit(repo, "branch", "keep");
    const handle = start();
    const open = await handle.provider.open(handle.run, repo);
    if (!open.ok) throw new Error(open.code);
    const runRoot = open.workspace.runRoot;
    const stage = await stageRoot(handle, "s1");
    const record = readFileSync(join(runRoot, RUN_FILE), "utf8");
    const sweepWith = async (changed: Record<string, unknown>): Promise<void> => {
      writeFileSync(join(runRoot, RUN_FILE), JSON.stringify({ ...JSON.parse(record) as Record<string, unknown>, ...changed }));
      await createStageWorkspaceProvider({ git: createHostGit({ env }) }).sweep([]);
    };
    try {
      // The run's folder, its record naming another repository and a branch of that one at its commit.
      await sweepWith({ projectRoot: other, branch: "keep", baseCommit: userGit(other, "rev-parse", "HEAD") });
      // Its own repository, and a branch that is not the run's.
      await sweepWith({ branch: "keep" });
      await sweepWith({ baseCommit: "HEAD" });
      expect(userGit(other, "branch", "--list", "keep")).toContain("keep");
      expect(userGit(repo, "branch", "--list", "keep")).toContain("keep");
      expect(existsSync(join(stage, "a.txt"))).toBe(true);

      // The record as it was, copied beside a folder of the same name under another project's folder.
      const copy = join(dirname(dirname(runRoot)), "elsewhere-0a1b2c3d", basename(runRoot));
      write(copy, "s1/kept.txt", "kept\n");
      writeFileSync(join(copy, RUN_FILE), record);
      writeFileSync(join(runRoot, RUN_FILE), record);
      await createStageWorkspaceProvider({ git: createHostGit({ env }) }).sweep([handle.run.runId]);
      expect(existsSync(join(copy, "s1", "kept.txt"))).toBe(true);
      expect(existsSync(join(copy, RUN_FILE))).toBe(true);
      rmSync(dirname(copy), { recursive: true, force: true });
    } finally {
      writeFileSync(join(runRoot, RUN_FILE), record);
    }
  });
});
