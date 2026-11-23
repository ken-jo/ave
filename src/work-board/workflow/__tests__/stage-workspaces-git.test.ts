import { appendFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { aveHome } from "../../../shared/ave-home.js";
import { createHostGit, type HostGit, HostGitError } from "../host-git.js";
import { createStageWorkspaceProvider } from "../stage-workspaces.js";
import { JOIN_DIR, RUN_FILE, runBranch } from "../workspace-layout.js";
import { removeLink, stageOf, writeUnder as write } from "./stage-fixtures.js";
import { type GitFixture, gitFixture, sealed, stageRoot } from "./stage-git-fixture.js";

let fx: GitFixture;
let base: string;
let repo: string;
let env: NodeJS.ProcessEnv;
const userGit = (cwd: string, ...args: string[]): string => fx.userGit(cwd, ...args);
const commitAll = (message: string): string => fx.commitAll(message);
const start = (): ReturnType<GitFixture["start"]> => fx.start();

beforeEach(() => {
  fx = gitFixture();
  ({ base, repo, env } = fx);
});

afterEach(() => fx.done());

describe("git stage workspaces", () => {
  it("a stage folder swapped after the tracked-file listing loses no outside file", async () => {
    write(repo, ".env", "tracked\n");
    write(repo, "conf/.env", "tracked\n");
    commitAll("tracked secrets");
    const outside = join(base, "outside");
    write(outside, ".env", "outside\n");
    write(outside, "conf/.env", "outside\n");
    const real = createHostGit({ env });
    let swap: "stage" | "folder" | undefined;
    const run: HostGit["run"] = async (cwd, args, call) => {
      const result = await real.run(cwd, args, call);
      if (args[0] !== "ls-files" || swap === undefined) return result;
      const target = swap === "stage" ? cwd : join(cwd, "conf");
      renameSync(target, join(base, `away-${swap}`));
      symlinkSync(swap === "stage" ? outside : join(outside, "conf"), target, "junction");
      return result;
    };
    const handle = fx.start({ git: { run, drivers: real.drivers }, sensitive: path => basename(path) === ".env" });
    expect(await handle.provider.open(handle.run, repo)).toMatchObject({ ok: true });
    for (swap of ["stage", "folder"] as const) {
      expect(await handle.provider.prepare(handle.run, stageOf(`s-${swap}`), 1), swap).toEqual({ ok: false, code: "git-unavailable" });
      expect(readFileSync(join(outside, ".env"), "utf8"), swap).toBe("outside\n");
      expect(readFileSync(join(outside, "conf", ".env"), "utf8"), swap).toBe("outside\n");
    }
    swap = undefined;
    const stage = await stageRoot(handle, "s1");
    expect(readdirSync(stage).sort()).toEqual([".git", "a.txt", "b.txt", "conf"]);
    expect(readdirSync(join(stage, "conf"))).toEqual([]);
  });

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

  it("a conflicting name with pattern characters is told of the stages that changed that very file", async () => {
    const handle = start();
    const open = await handle.provider.open(handle.run, repo);
    if (!open.ok) throw new Error(open.code);
    const [first, second, third] = [await stageRoot(handle, "s1"), await stageRoot(handle, "s2"), await stageRoot(handle, "s3")];
    write(first, "b[1].txt", "from s1\n");
    write(second, "b[1].txt", "from s2\n");
    write(third, "b1.txt", "from s3\n");
    for (const stageId of ["s1", "s2", "s3"]) await sealed(handle, stageId);
    expect(await handle.provider.integrate(handle.run, "j1", ["s3", "s1", "s2"])).toMatchObject({ ok: false, conflict: { reason: "merge-conflict", files: [{ path: "b[1].txt", stageIds: ["s1", "s2"] }] } });
  });

  /** A run with two sealed stages that conflict on `a.txt`, its provider's git failing the calls `fails` picks while `failing` is set. */
  async function conflicting(fails: (args: readonly string[]) => boolean): Promise<{ handle: ReturnType<typeof start>; joinDir: string; record: string; failing: { on: boolean } }> {
    const real = createHostGit({ env });
    const failing = { on: false };
    const git: HostGit = { drivers: real.drivers, run: (cwd, args, call) => failing.on && fails(args) ? Promise.resolve({ code: 128, stdout: "", stderr: "fatal: fixture" }) : real.run(cwd, args, call) };
    const handle = fx.start({ git });
    const open = await handle.provider.open(handle.run, repo);
    if (!open.ok) throw new Error(open.code);
    write(await stageRoot(handle, "s1"), "a.txt", "from s1\n");
    write(await stageRoot(handle, "s2"), "a.txt", "from s2\n");
    await sealed(handle, "s1");
    await sealed(handle, "s2");
    return { handle, joinDir: join(open.workspace.runRoot, JOIN_DIR), record: join(open.workspace.runRoot, RUN_FILE), failing };
  }

  it("a conflict whose files git could not list is refused, not told as a conflict of no file", async () => {
    const { handle, joinDir, failing } = await conflicting(args => args.includes("--diff-filter=U"));
    failing.on = true;
    await expect(handle.provider.integrate(handle.run, "j1", ["s1", "s2"])).rejects.toThrow();
    failing.on = false;
    expect(() => userGit(joinDir, "rev-parse", "--verify", "--quiet", "MERGE_HEAD")).toThrow();
    expect(await handle.provider.integrate(handle.run, "j1", ["s1", "s2"])).toMatchObject({ ok: false, conflict: { files: [{ path: "a.txt", stageIds: ["s1", "s2"] }] } });
  });

  it("a merge whose abort failed keeps its retry marker, and the next call aborts it", async () => {
    const { handle, joinDir, record, failing } = await conflicting(args => args[0] === "merge" && args[1] === "--abort");
    failing.on = true;
    await expect(handle.provider.integrate(handle.run, "j1", ["s1", "s2"])).rejects.toThrow();
    failing.on = false;
    expect(userGit(joinDir, "rev-parse", "--verify", "--quiet", "MERGE_HEAD")).not.toBe("");
    expect((JSON.parse(readFileSync(record, "utf8")) as { merging?: string }).merging).toBeDefined();
    expect(await handle.provider.integrate(handle.run, "j1", ["s1", "s2"])).toMatchObject({ ok: false, conflict: { files: [{ path: "a.txt", stageIds: ["s1", "s2"] }] } });
    expect(() => userGit(joinDir, "rev-parse", "--verify", "--quiet", "MERGE_HEAD")).toThrow();
  });

  it("a repository whose refs are kept in a folder its format names elsewhere gets no git workspace; one keeping them in its own folder does", async () => {
    userGit(repo, "refs", "migrate", "--ref-format=reftable");
    const store = join(base, "ref-store");
    mkdirSync(store);
    cpSync(join(repo, ".git", "reftable"), join(store, "reftable"), { recursive: true });
    userGit(repo, "config", "extensions.refStorage", `reftable://${store.split("\\").join("/")}`);
    expect(userGit(repo, "rev-parse", "--verify", "HEAD")).toMatch(/^[0-9a-f]{40}$/u);
    const refused = start();
    expect(await refused.provider.open(refused.run, repo)).toEqual({ ok: false, code: "git-unavailable" });
    // Refused before anything was made: no branch, no registration, in either folder.
    expect(userGit(repo, "for-each-ref", "--format=%(refname)", "refs/heads/")).toBe("refs/heads/main");
    expect([existsSync(join(repo, ".git", "worktrees")), existsSync(join(store, "worktrees"))]).toEqual([false, false]);
    userGit(repo, "config", "extensions.refStorage", "reftable");
    const handle = start();
    expect(await handle.provider.open(handle.run, repo)).toMatchObject({ ok: true, workspace: { kind: "git" } });
  });

  it("a merge state git gave no answer about is not taken for none", async () => {
    const { handle, failing } = await conflicting(args => args.includes("MERGE_HEAD"));
    failing.on = true;
    await expect(handle.provider.integrate(handle.run, "j1", ["s1", "s2"])).rejects.toThrow();
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

  it("a driver only a linked worktree's configuration names does not run when a folder is filled, sealed or collected", async () => {
    const marks = join(base, "marks");
    mkdirSync(marks);
    const driver = (name: string, then: string): string => {
      writeFileSync(join(base, `${name}.sh`), `echo ran >> '${join(marks, name).replace(/\\/g, "/")}'\n${then}\n`);
      return `sh '${join(base, `${name}.sh`).replace(/\\/g, "/")}'`;
    };
    // Included only for git that runs as a linked worktree: git in the project root reads none of it.
    const included = join(repo, ".git", "linked.cfg");
    userGit(repo, "config", "-f", included, "filter.mark.clean", driver("clean", "cat"));
    userGit(repo, "config", "-f", included, "filter.mark.smudge", driver("smudge", "cat"));
    userGit(repo, "config", "-f", included, "merge.mark.driver", driver("merge", "exit 0"));
    userGit(repo, "config", "includeIf.gitdir:**/worktrees/**.path", "linked.cfg");
    write(repo, ".gitattributes", "*.txt filter=mark merge=mark\n");
    write(repo, "a.txt", "two\n");
    commitAll("drivers");
    expect(readdirSync(marks)).toEqual([]);
    // Control: the user's own git runs them in a linked worktree.
    userGit(repo, "worktree", "add", "-q", "--detach", join(base, "control"));
    expect(readdirSync(marks)).toEqual(["smudge"]);
    rmSync(join(marks, "smudge"));

    const handle = start();
    const open = await handle.provider.open(handle.run, repo);
    if (!open.ok) throw new Error(open.code);
    const first = await stageRoot(handle, "s1");
    const second = await stageRoot(handle, "s2");
    expect(readFileSync(join(first, "a.txt"), "utf8")).toBe("two\n");
    write(first, "a.txt", "from s1\n");
    write(second, "a.txt", "from s2\n");
    await sealed(handle, "s1");
    await sealed(handle, "s2");
    expect(await handle.provider.integrate(handle.run, "j1", ["s1", "s2"])).toMatchObject({ ok: false, conflict: { reason: "merge-conflict", files: [{ path: "a.txt" }] } });
    expect(readdirSync(marks)).toEqual([]);
  });

  /** The ways git reads a filter's `required` as true, as the line of a configuration file. */
  const requiredAs = [["a word", "required = true"], ["no value", "required"], ["a number", "required = 2"]] as const;
  const needFilter = (required: string): string => `[filter "need"]\n\tclean = cat\n\tsmudge = cat\n\t${required}\n`;

  async function expectNoGitWorkspace(): Promise<void> {
    const handle = start();
    expect(await handle.provider.open(handle.run, repo)).toEqual({ ok: false, code: "git-unavailable" });
    expect(userGit(repo, "branch", "--list", "ave/*")).toBe("");
    expect(userGit(repo, "worktree", "list", "--porcelain").match(/^worktree /gmu)).toHaveLength(1);
  }

  it.each(requiredAs)("a filter that only a linked worktree's configuration requires, by %s, gets no git workspace", async (_form, required) => {
    writeFileSync(join(repo, ".git", "linked.cfg"), needFilter(required));
    userGit(repo, "config", "includeIf.gitdir:**/worktrees/**.path", "linked.cfg");
    write(repo, ".gitattributes", "*.txt filter=need\n");
    commitAll("filtered in a linked worktree");
    await expectNoGitWorkspace();
  });

  it.each(requiredAs)("a repository that requires a filter driver, by %s, gets no git workspace", async (_form, required) => {
    appendFileSync(join(repo, ".git", "config"), needFilter(required));
    write(repo, ".gitattributes", "*.txt filter=need\n");
    commitAll("required filter");
    await expectNoGitWorkspace();
  });

  it("a filter whose required setting is empty is not required and does not run; a setting git reads as no boolean gets no git workspace", async () => {
    const mark = join(base, "smudged");
    writeFileSync(join(base, "smudge.sh"), `echo ran >> '${mark.replace(/\\/g, "/")}'\ncat\n`);
    appendFileSync(join(repo, ".git", "config"), `[filter "need"]\n\tclean = cat\n\tsmudge = sh '${join(base, "smudge.sh").replace(/\\/g, "/")}'\n\trequired =\n`);
    write(repo, ".gitattributes", "*.txt filter=need\n");
    commitAll("a filter that is not required");
    // Control: the user's own git runs it.
    rmSync(join(repo, "a.txt"));
    userGit(repo, "checkout", "--", "a.txt");
    expect(existsSync(mark)).toBe(true);
    rmSync(mark);
    const handle = start();
    expect(await handle.provider.open(handle.run, repo)).toMatchObject({ ok: true, workspace: { kind: "git" } });
    expect(readFileSync(join(await stageRoot(handle, "s1"), "a.txt"), "utf8")).toBe("one\n");
    expect(existsSync(mark)).toBe(false);
    await handle.provider.release(handle.run, "all");
    // No tracked file uses this one: what cannot be read as required or not is refused all the same.
    appendFileSync(join(repo, ".git", "config"), '[filter "unclear"]\n\trequired = maybe\n');
    await expectNoGitWorkspace();
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

  it("a secret path stays out of a seal as the one file it names, whatever its name reads as to git, and every name git tells the host is asked for as text", async () => {
    const calls: { args: readonly string[]; exact: boolean }[] = [];
    const real = createHostGit({ env });
    const git: HostGit = { drivers: real.drivers, run: (cwd, args, call) => { calls.push({ args, exact: call?.exact === true }); return real.run(cwd, args, call); } };
    // The secret's name is, read as a pattern, the other file's.
    const handle = fx.start({ git, sensitive: path => basename(path) === "[n]ew.txt" });
    await handle.provider.open(handle.run, repo);
    const root = await stageRoot(handle, "s1");
    write(root, "new.txt", "new\n");
    write(root, "[n]ew.txt", "kept out\n");
    const seal = await sealed(handle, "s1");
    expect.soft(seal === undefined ? "no commit" : userGit(repo, "show", "--name-status", "--format=", seal)).toBe("A\tnew.txt");
    const kinds = ["ls-files", "check-attr", "check-ignore", "--show-toplevel", "--git-common-dir", "--name-only"];
    const names = calls.filter(({ args }) => !args.includes("--diff-filter=U") && kinds.some(kind => args.includes(kind)));
    expect.soft(names.filter(call => !call.exact).map(call => call.args.join(" "))).toEqual([]);
    expect.soft(kinds.filter(kind => names.some(({ args }) => args.includes(kind)))).toEqual(["ls-files", "--show-toplevel", "--git-common-dir", "--name-only"]);
  });

  it.each([
    ["--show-toplevel", "open", "git-unavailable"],
    ["--git-common-dir", "open", "git-unavailable"],
    ["ls-files", "prepare", "git-unavailable"],
    ["--name-only", "seal", "workspace-unavailable"],
  ])("an answer to %s that holds a name that is no text ends the %s as %s: no name is acted on under another", async (kind, step, code) => {
    const real = createHostGit({ env });
    let broken = false;
    // What a name that is no text has git answer, once the answer is asked for as it was written.
    const git: HostGit = { drivers: real.drivers, run: (cwd, args, call) => broken && args.includes(kind) && call?.exact === true ? Promise.reject(new HostGitError("not-text", "fixture: a name that is no text")) : real.run(cwd, args, call) };
    const handle = fx.start({ git });
    broken = step === "open";
    const open = await handle.provider.open(handle.run, repo);
    if (step === "open") return expect(open).toEqual({ ok: false, code });
    broken = step === "prepare";
    const prepared = await handle.provider.prepare(handle.run, stageOf("s1"), 1);
    if (step === "prepare") return expect(prepared).toEqual({ ok: false, code });
    if (!prepared.ok) throw new Error(prepared.code);
    write(prepared.workspace.root, "new.txt", "new\n");
    broken = true;
    expect(await handle.provider.seal(handle.run, "s1")).toEqual({ ok: false, code });
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

  it("finds the run again after a restart; a sweep has no project open and leaves a git run whole, a release with its project open takes it", async () => {
    const kept = start();
    const gone = start();
    const keptOpen = await kept.provider.open(kept.run, repo);
    const goneOpen = await gone.provider.open(gone.run, repo);
    if (!keptOpen.ok || !goneOpen.ok) throw new Error("open refused");
    const root = await stageRoot(kept, "s1");
    await stageRoot(gone, "s1");
    const restarted = createStageWorkspaceProvider({ git: createHostGit({ env }) });
    await restarted.sweep([kept.run.runId]);
    expect(existsSync(join(goneOpen.workspace.runRoot, RUN_FILE))).toBe(true);
    await restarted.release(gone.run, "all");
    expect(existsSync(goneOpen.workspace.runRoot)).toBe(false);
    expect(existsSync(root)).toBe(true);
    write(root, "new.txt", "new\n");
    expect((await restarted.seal(kept.run, "s1")).ok).toBe(true);
  });

  it("a record copied into another folder directs no cleanup", async () => {
    const handle = start();
    const open = await handle.provider.open(handle.run, repo);
    if (!open.ok) throw new Error(open.code);
    const runRoot = open.workspace.runRoot;
    const stage = await stageRoot(handle, "s1");
    // The record as it is, copied beside a folder of the same name under another project's folder.
    const copy = join(dirname(dirname(runRoot)), "elsewhere-0a1b2c3d", basename(runRoot));
    write(copy, "s1/kept.txt", "kept\n");
    writeFileSync(join(copy, RUN_FILE), readFileSync(join(runRoot, RUN_FILE), "utf8"));
    try {
      const restarted = createStageWorkspaceProvider({ git: createHostGit({ env }), removable: async () => () => true });
      await restarted.sweep([handle.run.runId]);
      await restarted.discard(new Map());
      await restarted.release(handle.run, "all");
      expect(existsSync(join(copy, "s1", "kept.txt"))).toBe(true);
      expect(existsSync(join(copy, RUN_FILE))).toBe(true);
    } finally {
      rmSync(dirname(copy), { recursive: true, force: true });
    }
    expect(existsSync(join(stage, "a.txt"))).toBe(false);
  });

  it("a run folder swapped for a link while it is released is not deleted through, by the host or by git", async () => {
    const handle = start();
    const open = await handle.provider.open(handle.run, repo);
    if (!open.ok) throw new Error(open.code);
    const runRoot = open.workspace.runRoot;
    await stageRoot(handle, "s1");
    write(await stageRoot(handle, "s2"), "sentinel.txt", "outside\n");
    const restored = join(base, "restored");
    const real = createHostGit({ env });
    const calls: string[] = [];
    // As a restore of the home does, at the first git call of the release: the folder is moved away and a link stands in its place.
    const run: HostGit["run"] = async (cwd, args, call) => {
      calls.push(args.join(" "));
      if (!existsSync(restored)) {
        renameSync(runRoot, restored);
        symlinkSync(restored, runRoot, "junction");
      }
      return real.run(cwd, args, call);
    };
    try {
      await createStageWorkspaceProvider({ git: { run, drivers: real.drivers } }).release(handle.run, "all").catch(() => undefined);
      expect(readFileSync(join(restored, "s2", "sentinel.txt"), "utf8")).toBe("outside\n");
      expect(existsSync(join(restored, "s2", "a.txt"))).toBe(true);
      expect(existsSync(join(restored, JOIN_DIR, "a.txt"))).toBe(true);
      expect(calls.filter(call => /^worktree|^branch|^update-ref/u.test(call))).toEqual([]);
    } finally {
      if (existsSync(restored)) {
        removeLink(runRoot, aveHome());
        renameSync(restored, runRoot);
      }
    }
  });

  it("a refused open leaves a branch it did not make and takes back the one it made", async () => {
    // A branch of the run's name that was there before, once with a commit of its own and once at the commit the run would start from.
    for (const ahead of [true, false]) {
      const taken = start();
      const branch = runBranch(taken.run.runId);
      userGit(repo, "branch", branch);
      if (ahead) {
        userGit(repo, "checkout", "-q", branch);
        write(repo, "mine.txt", "mine\n");
        commitAll("mine");
        userGit(repo, "checkout", "-q", "main");
      }
      const head = userGit(repo, "rev-parse", branch);
      expect(await taken.provider.open(taken.run, repo)).toEqual({ ok: false, code: "git-unavailable" });
      expect(userGit(repo, "rev-parse", branch)).toBe(head);
      userGit(repo, "branch", "-D", branch);
    }

    // The worktree is made, branch and all, and the call then counts as failed.
    const real = createHostGit({ env });
    const run: HostGit["run"] = async (cwd, args, call) => {
      const result = await real.run(cwd, args, call);
      return args[0] === "worktree" && args[1] === "add" ? { ...result, code: 128 } : result;
    };
    const failed = start();
    expect(await createStageWorkspaceProvider({ git: { run, drivers: real.drivers } }).open(failed.run, repo)).toEqual({ ok: false, code: "git-unavailable" });
    expect(userGit(repo, "branch", "--list", runBranch(failed.run.runId))).toBe("");
    expect(userGit(repo, "worktree", "list", "--porcelain").match(/^worktree /gmu)).toHaveLength(1);
  });

  it("a home reached through a link runs a git workspace from open to release", async () => {
    // Git names a worktree by its path as it really is on disk; the host reaches the home by the path it was given.
    mkdirSync(join(base, "real", "home"), { recursive: true });
    symlinkSync(join(base, "real"), join(base, "link"), "junction");
    const before = process.env.AVE_HOME;
    process.env.AVE_HOME = join(base, "link", "home");
    try {
      const handle = start();
      const open = await handle.provider.open(handle.run, repo);
      expect(open).toMatchObject({ ok: true, workspace: { kind: "git" } });
      if (!open.ok) throw new Error("expected a workspace");
      write(await stageRoot(handle, "s1"), "from-s1.txt", "s1\n");
      await sealed(handle, "s1");
      expect(await handle.provider.integrate(handle.run, "j1", ["s1"])).toEqual({ ok: true });
      expect(userGit(repo, "show", `${runBranch(handle.run.runId)}:from-s1.txt`)).toBe("s1");
      // Found again by a provider that has only the disk to go by.
      await createStageWorkspaceProvider({ git: createHostGit({ env }) }).release(handle.run, "all");
      expect(existsSync(open.workspace.runRoot)).toBe(false);
      expect(userGit(repo, "worktree", "list", "--porcelain").match(/^worktree /gmu)).toHaveLength(1);
      expect(readdirSync(join(repo, ".git", "worktrees"))).toEqual([]);
    } finally {
      if (before === undefined) delete process.env.AVE_HOME; else process.env.AVE_HOME = before;
    }
  });
});

it("a git fixture that cannot be made leaves nothing of itself in the temp folder", () => {
  const scratch = join(fx.base, "scratch");
  mkdirSync(scratch);
  for (const name of ["TEMP", "TMP", "TMPDIR"]) vi.stubEnv(name, scratch);
  // The first commit is refused: the repository and the objects of its files are there by then.
  vi.stubEnv("GIT_AUTHOR_DATE", "no date");
  try {
    expect.soft(() => gitFixture()).toThrow("invalid date format");
    expect.soft(readdirSync(scratch)).toEqual([]);
  } finally {
    vi.unstubAllEnvs();
  }
});
