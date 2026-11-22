import { execFileSync } from "node:child_process";
import { cpSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { _resetAveHomePrivacyForTest, aveHome, setAveHomePrivacyAtBoot } from "../../../shared/ave-home.js";
import type { StageInputDecl } from "../../../shared/workflow-template-types.js";
import { type NameReader, plainFolderIgnore, projectFoldsCase } from "../folder-ignore.js";
import { createHostGit, type HostGit, HostGitError } from "../host-git.js";
import { holdDir, nodeIdOf } from "../owned-fs.js";
import type { RunRef } from "../stage-workspace.js";
import { createStageWorkspaceProvider, type StageWorkspaceOptions } from "../stage-workspaces.js";
import { OUT_DIR, RUN_FILE, runRootOf } from "../workspace-layout.js";
import { copySeedFiles, isInside, listSeedFiles } from "../workspace-seed.js";
import { setPath, stageOf, writeUnder as write } from "./stage-fixtures.js";

let base: string;
let project: string;
let env: NodeJS.ProcessEnv;
let runs = 0;
const opened: Handle[] = [];
interface Handle { provider: ReturnType<typeof createStageWorkspaceProvider>; run: RunRef; runRoot: string; out: string }

const read = (root: string, path: string): string => readFileSync(join(root, path), "utf8");
/** Every file under `root`, as sorted `/` paths. */
const tree = (root: string, prefix = ""): string[] => readdirSync(join(root, prefix), { withFileTypes: true })
  .flatMap(entry => entry.isDirectory() ? tree(root, `${prefix}${entry.name}/`) : [`${prefix}${entry.name}`]).sort();
/** Which entry a path names, as the provider reads it off the disk. */
const diskId = (path: string): string | undefined => {
  const stat = lstatSync(path, { bigint: true, throwIfNoEntry: false });
  return stat === undefined ? undefined : `${stat.dev}:${stat.ino}`;
};
const fromProject = (...paths: string[]): StageInputDecl => ({ from: "project", paths });

async function start(root: string | undefined, options: StageWorkspaceOptions = {}, itemId = 7): Promise<Handle> {
  runs += 1;
  const run: RunRef = { itemId, runId: `run-folder-${process.pid}-${Date.now()}-${runs}`, runKey: "key" };
  const provider = createStageWorkspaceProvider({ git: createHostGit({ env }), ...options });
  const open = await provider.open(run, root);
  if (!open.ok || open.workspace.kind !== "folder" || open.workspace.outputDir === undefined) throw new Error("expected a folder workspace");
  const handle = { provider, run, runRoot: open.workspace.runRoot, out: open.workspace.outputDir };
  opened.push(handle);
  return handle;
}

async function stageRoot(handle: Handle, stageId: string, over: Parameters<typeof stageOf>[1] = {}, attempt = 1): Promise<string> {
  const prepared = await handle.provider.prepare(handle.run, stageOf(stageId, over), attempt);
  if (!prepared.ok) throw new Error(`prepare refused: ${prepared.code}`);
  expect(prepared.workspace.kind).toBe("folder");
  return prepared.workspace.root;
}

/** The real host git, noting where each ignore matcher's repository is made and the case rule each matcher call is given; `broken` makes
 * a call fail after it ran, or throw instead. */
function watchedGit(broken?: (args: readonly string[]) => "fails" | HostGitError | undefined): { git: HostGit; made: string[]; matched: string[] } {
  const real = createHostGit({ env });
  const made: string[] = [];
  const matched: string[] = [];
  const run: HostGit["run"] = async (cwd, args, call) => {
    if (args[0] === "init") made.push(args.at(-1) ?? "");
    if (args.includes("check-ignore")) matched.push(...(call?.drivers ?? []).filter(entry => entry.startsWith("core.ignoreCase=")));
    const how = broken?.(args);
    if (how instanceof HostGitError) throw how;
    const result = await real.run(cwd, args, call);
    return how === "fails" ? { ...result, code: 128 } : result;
  };
  return { made, matched, git: { run, drivers: real.drivers } };
}

/** Runs `work` with the home at `home`, a folder of the test's own. */
async function withHome<T>(home: string, work: () => Promise<T>): Promise<T> {
  const before = process.env.AVE_HOME;
  process.env.AVE_HOME = home;
  try {
    return await work();
  } finally {
    if (before === undefined) delete process.env.AVE_HOME; else process.env.AVE_HOME = before;
  }
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "swf-"));
  project = join(base, "project");
  mkdirSync(project);
  writeFileSync(join(base, "gitconfig"), "[core]\n\tautocrlf = false\n");
  env = { ...process.env, GIT_CONFIG_GLOBAL: join(base, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1", GIT_CEILING_DIRECTORIES: base };
  write(project, "src/a.ts", "a\n");
  write(project, "src/deep/b.ts", "b\n");
  write(project, "docs/guide.md", "guide\n");
  write(project, "notes.txt", "notes\n");
});

afterEach(async () => {
  for (const { provider, run } of opened.splice(0)) await provider.release(run, "all");
  rmSync(base, { recursive: true, force: true, maxRetries: 3 });
});

describe("folder stage workspaces", () => {
  it("the layout carries no raw path, run id or title, and no stage is named like a host folder", async () => {
    // Both ends as they really are on disk: the home may be reached through a link.
    const under = (path: string): string[] => relative(realpathSync.native(aveHome()), realpathSync.native(path)).split(sep);
    const withProject = await start(project);
    expect(under(withProject.runRoot)).toEqual(["worktrees", expect.stringMatching(/^project-[0-9a-f]{8}$/u), expect.stringMatching(/^[0-9a-f]{12}$/u)]);
    expect(withProject.runRoot).not.toContain(withProject.run.runId);
    expect(under(await stageRoot(withProject, "s1"))).toHaveLength(4);
    const without = await start(undefined);
    expect(under(without.runRoot).slice(0, 2)).toEqual(["worktrees", "board-7"]);
    for (const name of ["_join", "_out", "_run.json", "..", "a/b", "S1"]) {
      expect(await without.provider.prepare(without.run, stageOf(name), 1), name).toEqual({ ok: false, code: "workspace-unavailable" });
    }
    expect(readdirSync(without.runRoot).sort()).toEqual(["_out", "_run.json"]);
  });

  it("opens nothing while the privacy of the home is not established", async () => {
    setAveHomePrivacyAtBoot({ enforcement: "none", home: aveHome(), category: "boundary-link", reason: "fixture" });
    const listed = (): string[] => existsSync(join(aveHome(), "worktrees")) ? tree(join(aveHome(), "worktrees")) : [];
    const before = listed();
    try {
      const provider = createStageWorkspaceProvider({ git: createHostGit({ env }) });
      const run: RunRef = { itemId: 8, runId: `run-unverified-${process.pid}-${Date.now()}`, runKey: "key" };
      expect(await provider.open(run, project)).toEqual({ ok: false, code: "home-boundary-unverified" });
      expect(listed()).toEqual(before);
      expect(await provider.prepare(run, stageOf("s1"), 1)).toEqual({ ok: false, code: "workspace-unavailable" });
    } finally {
      _resetAveHomePrivacyForTest();
    }
  });

  it("a folder project runs two stages in parallel in two folders", async () => {
    const handle = await start(project);
    expect(handle.out).toBe(join(handle.runRoot, OUT_DIR));
    const [first, second] = await Promise.all([
      stageRoot(handle, "s1", { inputFiles: [fromProject("src/**")] }),
      stageRoot(handle, "s2", { inputFiles: [fromProject("src/**")] }),
    ]);
    expect(first).not.toBe(second);
    write(first, "src/a.ts", "changed by s1\n");
    expect(read(second, "src/a.ts")).toBe("a\n");
    expect(read(project, "src/a.ts")).toBe("a\n");
    // A repeated prepare is the same folder with its files.
    expect(await stageRoot(handle, "s1", { inputFiles: [fromProject("src/**")] })).toBe(first);
    expect(read(first, "src/a.ts")).toBe("changed by s1\n");
  });

  it("seeds only the declared inputs", async () => {
    const handle = await start(project);
    expect(tree(await stageRoot(handle, "s1", { inputFiles: [fromProject("src/**", "notes.txt")] }))).toEqual(["notes.txt", "src/a.ts", "src/deep/b.ts"]);
    expect(tree(await stageRoot(handle, "s2", { inputFiles: [fromProject("docs")] }))).toEqual(["docs/guide.md"]);
    // No declared input: an empty folder, not the project.
    expect(tree(await stageRoot(handle, "s3"))).toEqual([]);
  });

  it("refuses project inputs when the item has no project", async () => {
    const handle = await start(undefined);
    expect(await handle.provider.prepare(handle.run, stageOf("s1", { inputFiles: [fromProject("**")] }), 1)).toEqual({ ok: false, code: "inputs-need-project" });
    expect(existsSync(join(handle.runRoot, "s1"))).toBe(false);
    expect(tree(await stageRoot(handle, "s2"))).toEqual([]);
  });

  it("never follows a link out of the project and never copies a secret or ignored file", async () => {
    const outside = join(base, "outside");
    write(outside, "private.txt", "outside the project\n");
    symlinkSync(outside, join(project, "linked"), "junction");
    write(project, ".env", "TOKEN=fixture\n");
    write(project, "keys/id_rsa", "fixture\n");
    write(project, "build/out.js", "built\n");
    write(project, "debug.log", "log\n");
    write(project, ".gitignore", "build/\n*.log\n");
    // A work tree with no commit yet is a folder project whose ignore rules still apply.
    execFileSync("git", ["init", "-q"], { cwd: project, env });

    const listed = await listSeedFiles(project, ["**"], { sensitive: path => path.endsWith(".env") });
    expect(listed.ok && listed.skipped).toEqual(expect.arrayContaining([{ path: "linked", why: "link" }, { path: ".env", why: "secret" }]));

    const handle = await start(project);
    const root = await stageRoot(handle, "s1", { inputFiles: [fromProject("**")] });
    expect(tree(root)).toEqual([".gitignore", "docs/guide.md", "notes.txt", "src/a.ts", "src/deep/b.ts"]);
    // Naming the link, the secret or the ignored file directly changes nothing.
    expect(tree(await stageRoot(handle, "s2", { inputFiles: [fromProject("linked/private.txt", "linked/**", ".env", "keys/id_rsa", "build/out.js", "debug.log")] }))).toEqual([]);
  });

  it("a plain folder outside any git work tree honours its own ignore files: an ignored declared input is not copied", async () => {
    write(project, "build/out.js", "built\n");
    write(project, "debug.log", "log\n");
    write(project, "keep.log", "kept\n");
    write(project, "docs/draft.md", "draft\n");
    write(project, ".gitignore", "build/\n*.log\n!keep.log\nnotes.txt\n");
    write(project, "docs/.gitignore", "draft.md\n");
    // The user's own excludes file is not one of the folder's ignore files.
    write(base, "user-excludes", "src/\n");
    writeFileSync(join(base, "gitconfig"), `[core]\n\tautocrlf = false\n\texcludesFile = ${join(base, "user-excludes").split(sep).join("/")}\n`);

    const handle = await start(project);
    const root = await stageRoot(handle, "s1", { inputFiles: [fromProject("**")] });
    expect(tree(root)).toEqual([".gitignore", "docs/.gitignore", "docs/guide.md", "keep.log", "src/a.ts", "src/deep/b.ts"]);
    // Named one by one, an ignored input is not copied either.
    expect(tree(await stageRoot(handle, "s2", { inputFiles: [fromProject("build/out.js", "debug.log", "notes.txt", "docs/draft.md", "src/a.ts")] }))).toEqual(["src/a.ts"]);
    // The matcher's repository is gone once the folder is seeded, and none was made in the project.
    expect(readdirSync(handle.runRoot).sort()).toEqual(["_out", "_run.json", "s1", "s2"]);
    expect(existsSync(join(project, ".git"))).toBe(false);
  });

  it("a plain folder's ignore rules do not change with the git configuration and variables the host process inherited", async () => {
    write(project, ".gitignore", "private.txt\n");
    write(project, "PRIVATE.TXT", "private\n");
    write(project, "user-ignored.txt", "the user's own rule, not the folder's\n");
    const slashed = (path: string): string => path.split(sep).join("/");
    write(base, "user-excludes", "user-ignored.txt\n");
    write(base, "xdg/git/ignore", "user-ignored.txt\n");
    write(base, "template/info/exclude", "src/\n");
    const elsewhere = join(base, "elsewhere");
    mkdirSync(elsewhere);
    execFileSync("git", ["init", "-q"], { cwd: elsewhere, env });
    // The matcher folds case as the platform's file names do, and by nothing it inherits.
    const folds = process.platform === "win32" || process.platform === "darwin";
    const expected = [".gitignore", ...(folds ? [] : ["PRIVATE.TXT"]), "docs/guide.md", "notes.txt", "src/a.ts", "src/deep/b.ts", "user-ignored.txt"];
    const clean = env;
    for (const inherited of ["true", "false"]) {
      writeFileSync(join(base, "gitconfig"), `[core]\n\tautocrlf = false\n\tignorecase = ${inherited}\n\texcludesFile = ${slashed(join(base, "user-excludes"))}\n`);
      env = {
        ...clean, XDG_CONFIG_HOME: join(base, "xdg"), GIT_TEMPLATE_DIR: join(base, "template"), GIT_DIR: join(elsewhere, ".git"), GIT_WORK_TREE: elsewhere,
        GIT_CONFIG_COUNT: "2", GIT_CONFIG_KEY_0: "core.ignorecase", GIT_CONFIG_VALUE_0: inherited,
        GIT_CONFIG_KEY_1: "core.excludesFile", GIT_CONFIG_VALUE_1: slashed(join(base, "user-excludes")),
        GIT_CONFIG_PARAMETERS: `'core.ignorecase=${inherited}'`,
      };
      const handle = await start(project);
      expect(tree(await stageRoot(handle, "s1", { inputFiles: [fromProject("**")] })), `inherited core.ignoreCase=${inherited}`).toEqual(expected);
    }
    expect(readdirSync(elsewhere)).toEqual([".git"]);
  });

  it("each seeding makes the ignore matcher's repository in a folder of its own under its run, and it is gone afterwards", async () => {
    write(project, "debug.log", "log\n");
    write(project, ".gitignore", "*.log\n");
    const watched = watchedGit();
    const [first, second] = [await start(project, { git: watched.git }), await start(project, { git: watched.git })];
    const seeded = await Promise.all([
      stageRoot(first, "s1", { inputFiles: [fromProject("**")] }),
      stageRoot(first, "s2", { inputFiles: [fromProject("**")] }),
      stageRoot(second, "s1", { inputFiles: [fromProject("**")] }),
    ]);
    for (const root of seeded) expect(tree(root)).toEqual([".gitignore", "docs/guide.md", "notes.txt", "src/a.ts", "src/deep/b.ts"]);
    expect(new Set(watched.made).size).toBe(3);
    expect(watched.made.map(folder => relative(first.runRoot, folder)).filter(path => /^_ignore-[^\\/]+$/u.test(path))).toHaveLength(2);
    expect(watched.made.map(folder => relative(second.runRoot, folder)).filter(path => /^_ignore-[^\\/]+$/u.test(path))).toHaveLength(1);
    expect(watched.made.filter(folder => existsSync(folder))).toEqual([]);
    expect(readdirSync(first.runRoot).sort()).toEqual(["_out", "_run.json", "s1", "s2"]);
    expect(readdirSync(second.runRoot).sort()).toEqual(["_out", "_run.json", "s1"]);
  });

  it("git failing after the matcher's repository was made refuses the stage as unreadable and leaves no repository behind", async () => {
    write(project, "debug.log", "log\n");
    write(project, ".gitignore", "*.log\n");
    const failures: [string, (args: readonly string[]) => "fails" | HostGitError | undefined][] = [
      ["the repository cannot be made", args => args[0] === "init" ? "fails" : undefined],
      ["the matcher exits with an error", args => args.includes("check-ignore") ? "fails" : undefined],
      ["the matcher does not finish in time", args => args.includes("check-ignore") ? new HostGitError("timeout", "fixture") : undefined],
      ["the matcher writes too much", args => args.includes("check-ignore") ? new HostGitError("output-limit", "fixture") : undefined],
      ["the matcher is ended from outside", args => args.includes("check-ignore") ? new HostGitError("terminated", "fixture") : undefined],
    ];
    for (const [name, broken] of failures) {
      const there: boolean[] = [];
      const watched = watchedGit((args) => {
        const how = broken(args);
        if (how !== undefined && args[0] !== "init") there.push(existsSync(join(watched.made.at(-1) ?? "", ".git")));
        return how;
      });
      const handle = await start(project, { git: watched.git });
      expect(await handle.provider.prepare(handle.run, stageOf("s1", { inputFiles: [fromProject("**")] }), 1), name).toEqual({ ok: false, code: "seed-unreadable" });
      expect(watched.made.map(folder => relative(handle.runRoot, folder)), name).toEqual([expect.stringMatching(/^_ignore-[^\\/]+$/u)]);
      expect(there.every(Boolean), name).toBe(true);
      expect(readdirSync(handle.runRoot).sort(), name).toEqual(["_out", "_run.json"]);
    }
  });

  it("a home inside the project gets no workspace at all, and neither does a project inside the home's worktrees", async () => {
    write(project, ".gitignore", "*.log\n");
    mkdirSync(join(project, "profile"));
    const before = tree(project);
    const run: RunRef = { itemId: 7, runId: `run-overlap-${process.pid}-${Date.now()}`, runKey: "key" };
    for (const home of [join(project, "profile"), project]) {
      await withHome(home, async () => {
        const provider = createStageWorkspaceProvider({ git: createHostGit({ env }) });
        expect(await provider.open(run, project), home).toEqual({ ok: false, code: "workspace-unavailable" });
        expect(await provider.prepare(run, stageOf("s1"), 1), home).toEqual({ ok: false, code: "workspace-unavailable" });
      });
      expect(readdirSync(join(project, "profile")), home).toEqual([]);
      expect(tree(project), home).toEqual(before);
    }
    // A folder under the home's worktrees is a run folder or the host's own, never a project.
    const home = join(base, "home");
    const inside = join(home, "worktrees", "project-0a1b2c3d", "0a1b2c3d4e5f", "s1");
    write(inside, "notes.txt", "notes\n");
    await withHome(home, async () => {
      const provider = createStageWorkspaceProvider({ git: createHostGit({ env }) });
      for (const root of [inside, join(home, "worktrees")]) expect(await provider.open(run, root), root).toEqual({ ok: false, code: "workspace-unavailable" });
      // The home's other folders are no run folders: a project there is one like any other.
      write(home, "projects/mine/notes.txt", "notes\n");
      expect(await provider.open(run, join(home, "projects", "mine"))).toMatchObject({ ok: true });
      await provider.release(run, "all");
    });
    expect(tree(join(home, "worktrees", "project-0a1b2c3d"))).toEqual(["0a1b2c3d4e5f/s1/notes.txt"]);
  });

  it("a worktrees, project or run folder that is a link gets nothing made through it", async () => {
    const home = join(base, "home");
    const outside = join(base, "outside");
    const run: RunRef = { itemId: 7, runId: `run-linked-${process.pid}-${Date.now()}`, runKey: "key" };
    const real = realpathSync.native(project);
    const runRoot = runRootOf(home, process.platform === "win32" ? real.toLowerCase() : real, run.itemId, run.runId);
    const levels: [string, string, string][] = [
      ["worktrees", join(home, "worktrees"), "home-boundary-unverified"],
      ["project", dirname(runRoot), "home-boundary-unverified"],
      ["run", runRoot, "workspace-unavailable"],
    ];
    for (const [name, level, code] of levels) {
      rmSync(home, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
      mkdirSync(dirname(level), { recursive: true });
      mkdirSync(outside);
      symlinkSync(outside, level, "junction");
      await withHome(home, async () => {
        const provider = createStageWorkspaceProvider({ git: createHostGit({ env }) });
        expect(await provider.open(run, project), name).toEqual({ ok: false, code });
        expect(await provider.prepare(run, stageOf("s1"), 1), name).toEqual({ ok: false, code: "workspace-unavailable" });
      });
      expect(readdirSync(outside), name).toEqual([]);
      rmSync(level);
    }
  });

  it("a call naming the run under another item finds no workspace", async () => {
    const handle = await start(project);
    const stage = await stageRoot(handle, "s1", { outputs: ["plan.md"] });
    write(stage, "plan.md", "the plan\n");
    const other: RunRef = { ...handle.run, itemId: 8 };
    expect(await handle.provider.prepare(other, stageOf("s2"), 1)).toEqual({ ok: false, code: "workspace-unavailable" });
    expect(await handle.provider.seal(other, "s1")).toEqual({ ok: false, code: "workspace-unavailable" });
    await expect(handle.provider.integrate(other, "j1", ["s1"])).rejects.toThrow("the run has no workspace");
    await handle.provider.release(other, "all");
    expect(read(stage, "plan.md")).toBe("the plan\n");
    expect(readdirSync(handle.runRoot).sort()).toEqual(["_out", "_run.json", "s1"]);
    // The same run id under the other item is a run of its own, in a folder of its own.
    const opened = await handle.provider.open(other, project);
    if (!opened.ok) throw new Error(opened.code);
    expect(opened.workspace.runRoot).not.toBe(handle.runRoot);
    await handle.provider.release(other, "all");
    await createStageWorkspaceProvider({ git: createHostGit({ env }), removable: async () => run => run.itemId === 8 }).discard();
    expect(existsSync(opened.workspace.runRoot)).toBe(false);
    expect(read(stage, "plan.md")).toBe("the plan\n");
  });

  it("the matcher takes each path whole: a name with a line break in it is one path", async () => {
    write(project, ".gitignore", "*.log\n");
    const runRoot = join(base, "run");
    mkdirSync(runRoot);
    const removed: string[] = [];
    const held = holdDir(runRoot);
    const rules = plainFolderIgnore(createHostGit({ env }), runRoot, project, {
      check: () => held.check(),
      makeTemp: () => held.makeTemp("_ignore-"),
      remove: async (scratch) => { removed.push(scratch.path); await held.remove(basename(scratch.path), scratch.id); },
    });
    expect([...await rules.ignored(["line\nbreak.log", "line\nbreak.txt", "plain.log", "notes.txt", "src/"])].sort()).toEqual(["line\nbreak.log", "plain.log"]);
    await rules.done();
    expect(removed).toHaveLength(1);
    expect(readdirSync(runRoot)).toEqual([]);
  });

  it("a plain folder's negation and nested-directory rules seed exactly what git leaves unignored in a repository of the same tree", async () => {
    const twin = join(base, "twin");
    const files: Record<string, string> = {
      ".gitignore": "*.log\n!keep.log\n/top.txt\nbuild/\ndeep/**/cache/\n!deep/a/cache/kept.txt\ndocs/**/draft-*.md\n",
      "docs/.gitignore": "!important.log\n/guide.md\nsub/\n!sub/readme.md\n!draft-keep.md\n",
      "a.log": "", "keep.log": "", "top.txt": "", "src/top.txt": "", "build/out.js": "", "src/build/out.js": "", "src/builder.ts": "",
      "deep/a/cache/kept.txt": "", "deep/a/b/cache/x.bin": "", "deep/cache.txt": "", "deep/a/kept.txt": "",
      "docs/draft-1.md": "", "docs/draft-keep.md": "", "docs/x/y/draft-2.md": "", "docs/x/y/final.md": "", "docs/important.log": "", "docs/other.log": "",
      "docs/sub/readme.md": "", "docs/sub/more.md": "", "docs/guide.md": "guide\n", "docs/x/guide.md": "", "notes.txt": "notes\n", "src/a.ts": "a\n", "src/deep/b.ts": "b\n",
    };
    for (const [path, text] of Object.entries(files)) { write(project, path, text); write(twin, path, text); }
    execFileSync("git", ["init", "-q", "--template="], { cwd: twin, env });
    // Nothing is committed there, so every file git does not ignore is listed as untracked.
    const status = execFileSync("git", ["-c", "core.excludesFile=", "status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd: twin, env, encoding: "utf8" });
    const unignored = status.split("\0").filter(Boolean).map((entry) => { expect(entry.slice(0, 3)).toBe("?? "); return entry.slice(3); }).sort();
    // The fixture does exercise both: a negation that takes effect, one under an excluded folder that cannot, and rules that prune folders.
    expect(unignored).toEqual(expect.arrayContaining(["keep.log", "docs/important.log", "docs/draft-keep.md", "src/top.txt", "docs/x/guide.md"]));
    for (const path of ["a.log", "top.txt", "build/out.js", "src/build/out.js", "deep/a/cache/kept.txt", "deep/a/b/cache/x.bin", "docs/sub/readme.md", "docs/x/y/draft-2.md", "docs/guide.md"]) expect(unignored, path).not.toContain(path);

    const handle = await start(project);
    expect(tree(await stageRoot(handle, "s1", { inputFiles: [fromProject("**")] }))).toEqual(unignored);
  });

  it("rules and names that differ by case alone seed what git leaves unignored in a repository in the same place, by the folder's own file name rule", async () => {
    const twin = join(base, "twin");
    const files: Record<string, string> = {
      ".gitignore": "secret.txt\n!SECRET.TXT\nUpper/\n*.LOG\n!Kept.Log\n/Docs/Draft.md\n",
      "secret.txt": "", "sub/Secret.txt": "", "upper/in.txt": "", "Upper2/in.txt": "", "a.log": "", "B.LOG": "", "kept.log": "", "docs/draft.md": "", "notes.txt": "notes\n",
      "docs/guide.md": "guide\n", "src/a.ts": "a\n", "src/deep/b.ts": "b\n",
    };
    for (const [path, text] of Object.entries(files)) { write(project, path, text); write(twin, path, text); }
    execFileSync("git", ["init", "-q", "--template="], { cwd: twin, env });
    // What git found out about the place by writing into its own repository there, the host reads off the folder without writing.
    const folds = execFileSync("git", ["config", "--get", "core.ignorecase"], { cwd: twin, env, encoding: "utf8" }).trim() === "true";
    expect(projectFoldsCase(project)).toBe(folds);
    const status = execFileSync("git", ["-c", "core.excludesFile=", "status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd: twin, env, encoding: "utf8" });
    const unignored = status.split("\0").filter(Boolean).map(entry => entry.slice(3)).sort();
    expect(unignored).toEqual(expect.arrayContaining([".gitignore", "notes.txt", "Upper2/in.txt"]));
    const watched = watchedGit();
    const handle = await start(project, { git: watched.git });
    expect(tree(await stageRoot(handle, "s1", { inputFiles: [fromProject("**")] }))).toEqual(unignored);
    expect([...new Set(watched.matched)]).toEqual([`core.ignoreCase=${folds}`]);
  });

  it("the file name rule is read off an entry of the project root under its name in the other case, and is no rule where that cannot be told", () => {
    const reader = (names: string[], ids: Record<string, string>): NameReader => ({ list: () => names, id: path => ids[path.slice(path.lastIndexOf(sep) + 1)] });
    // Names fold: the other case names the same entry. They do not: it names nothing, or a second entry stands beside the first.
    expect(projectFoldsCase(project, reader(["한글", "src"], { src: "1:7", SRC: "1:7" }))).toBe(true);
    expect(projectFoldsCase(project, reader([".GitIgnore"], { ".GitIgnore": "1:7", ".gITiGNORE": "1:7" }))).toBe(true);
    expect(projectFoldsCase(project, reader(["src"], { src: "1:7" }))).toBe(false);
    expect(projectFoldsCase(project, reader(["src", "SRC"], { src: "1:7", SRC: "1:8" }))).toBe(false);
    // An entry that went since the listing is passed over.
    expect(projectFoldsCase(project, reader(["gone", "src"], { src: "1:7", SRC: "1:7" }))).toBe(true);
    // Another entry under the other case that the listing does not show: no answer at all.
    expect(() => projectFoldsCase(project, reader(["src"], { src: "1:7", SRC: "1:8" }))).toThrow();
    // No name with a letter to ask with, or no name: the root cannot tell.
    expect(projectFoldsCase(project, reader(["한글", "123"], { 한글: "1:7", 123: "1:8" }))).toBeUndefined();
    expect(projectFoldsCase(project, reader([], {}))).toBeUndefined();
    // A sign that only folds to a letter is no letter to ask with.
    expect(projectFoldsCase(project, reader(["\u212A", "\u017F"], { "\u212A": "1:7", "\u017F": "1:8" }))).toBeUndefined();
  });

  it("the ignore case rule comes from the project root, not the first nested ignore file", async () => {
    write(project, "child/.gitignore", "BUILD.LOG\n");
    write(project, "child/build.log", "built\n");
    const root = realpathSync.native(project);
    const real = diskId(join(root, "CHILD")) === diskId(join(root, "child"));
    // The root answers the opposite of what the disk does; every other folder answers as the disk does.
    const nameReader: NameReader = {
      list: directory => readdirSync(directory),
      id: (path) => {
        const listed = readdirSync(root);
        if (dirname(path) !== root || listed.includes(basename(path))) return diskId(path);
        const twin = listed.find(name => name.toLowerCase() === basename(path).toLowerCase());
        return real || twin === undefined ? undefined : diskId(join(root, twin));
      },
    };
    const watched = watchedGit();
    const handle = await start(project, { git: watched.git, nameReader });
    const seeded = tree(await stageRoot(handle, "s1", { inputFiles: [fromProject("**")] }));
    expect([...new Set(watched.matched)]).toEqual([`core.ignoreCase=${!real}`]);
    expect(seeded.includes("child/build.log")).toBe(real);
  });

  it.skipIf(process.platform !== "win32")("a nested folder with a case rule of its own does not change the project root's", async (context) => {
    mkdirSync(join(project, "child"));
    try { execFileSync("fsutil", ["file", "setCaseSensitiveInfo", join(project, "child"), "enable"], { stdio: "ignore" }); } catch { /* told by the folder below */ }
    write(project, "child/.gitignore", "BUILD.LOG\n");
    write(project, "child/build.log", "built\n");
    // Not every installation lets a folder be given a rule of its own.
    if (projectFoldsCase(join(project, "child")) !== false) context.skip();
    const handle = await start(project);
    expect(tree(await stageRoot(handle, "s1", { inputFiles: [fromProject("**")] }))).not.toContain("child/build.log");
  });

  it("an indeterminate project root case rule refuses the seed and changes nothing", async () => {
    write(project, ".gitignore", "*.log\n");
    write(project, "a.log", "log\n");
    const before = tree(project);
    // Every name is an entry of its own, the one in the other case too, though the listing shows no second one.
    const nameReader: NameReader = { list: directory => readdirSync(directory), id: path => `1:${path}` };
    const handle = await start(project, { nameReader });
    expect(await handle.provider.prepare(handle.run, stageOf("s1", { inputFiles: [fromProject("**")] }), 1)).toEqual({ ok: false, code: "seed-unreadable" });
    expect(tree(project)).toEqual(before);
    expect(readdirSync(handle.runRoot).sort()).toEqual([OUT_DIR, RUN_FILE]);
  });

  describe("a project root whose names have no letter to ask with", () => {
    beforeEach(() => {
      rmSync(project, { recursive: true });
      mkdirSync(project);
      write(project, "한글/.gitignore", "BUILD.LOG\n");
      write(project, "한글/build.log", "built\n");
      write(project, "한글/메모.txt", "memo\n");
    });

    it("takes its case rule from a folder made and removed in the run folder on the same volume", async () => {
      const folds = diskId(join(base, "PROJECT")) === diskId(project);
      const before = tree(project);
      const watched = watchedGit();
      const handle = await start(project, { git: watched.git });
      const seeded = tree(await stageRoot(handle, "s1", { inputFiles: [fromProject("**")] }));
      expect([...new Set(watched.matched)]).toEqual([`core.ignoreCase=${folds}`]);
      expect(seeded.includes("한글/build.log")).toBe(!folds);
      expect(seeded).toContain("한글/메모.txt");
      expect(tree(project)).toEqual(before);
      expect(readdirSync(handle.runRoot).filter(name => name.startsWith("_ignore"))).toEqual([]);
    });

    it("has no case rule when the run folder is on another volume, and the seed is refused", async () => {
      const root = realpathSync.native(project);
      const before = tree(project);
      const nameReader: NameReader = { list: directory => readdirSync(directory), id: path => path === root ? "elsewhere:1" : diskId(path) };
      const handle = await start(project, { nameReader });
      expect(await handle.provider.prepare(handle.run, stageOf("s1", { inputFiles: [fromProject("**")] }), 1)).toEqual({ ok: false, code: "seed-unreadable" });
      expect(tree(project)).toEqual(before);
      expect(readdirSync(handle.runRoot).sort()).toEqual([OUT_DIR, RUN_FILE]);
    });
  });

  it("a plain folder with no ignore file seeds every declared file and needs no git; with one and no git it refuses", async () => {
    write(project, "build/out.js", "built\n");
    write(project, "debug.log", "log\n");
    const unavailable = async (): Promise<never> => { throw new HostGitError("unavailable", "no git on this machine"); };
    const handle = await start(project, { git: { run: unavailable, drivers: unavailable } });
    expect(tree(await stageRoot(handle, "s1", { inputFiles: [fromProject("**")] }))).toEqual(["build/out.js", "debug.log", "docs/guide.md", "notes.txt", "src/a.ts", "src/deep/b.ts"]);
    expect(tree(await stageRoot(handle, "s2", { inputFiles: [fromProject("build/out.js", "debug.log")] }))).toEqual(["build/out.js", "debug.log"]);

    // Rules that cannot be read copy nothing: the stage is refused, not seeded as if there were none.
    write(project, "docs/.gitignore", "guide.md\n");
    expect(await handle.provider.prepare(handle.run, stageOf("s3", { inputFiles: [fromProject("docs/guide.md")] }), 1)).toEqual({ ok: false, code: "seed-unreadable" });
    expect(existsSync(join(handle.runRoot, "s3"))).toBe(false);
    expect(tree(await stageRoot(handle, "s4", { inputFiles: [fromProject("src/**")] }))).toEqual(["src/a.ts", "src/deep/b.ts"]);
  });

  it("refuses a seed above the bounds", async () => {
    const handle = await start(project, { seedLimits: { files: 2, bytes: 1024 } });
    expect(await handle.provider.prepare(handle.run, stageOf("s1", { inputFiles: [fromProject("**")] }), 1)).toEqual({ ok: false, code: "seed-too-large" });
    expect(existsSync(join(handle.runRoot, "s1"))).toBe(false);
    write(project, "big.bin", "x".repeat(2048));
    expect(await handle.provider.prepare(handle.run, stageOf("s2", { inputFiles: [fromProject("big.bin")] }), 1)).toEqual({ ok: false, code: "seed-too-large" });
    expect(tree(await stageRoot(handle, "s3", { inputFiles: [fromProject("notes.txt")] }))).toEqual(["notes.txt"]);
  });

  it("copies only into the folder it holds: no path leaves it, no link is written through, and a copy that is not the expected content does not stay", async () => {
    const handle = await start(project);
    const stage = holdDir(await stageRoot(handle, "s1"));
    const source = { path: project, id: nodeIdOf(project) as string };
    const outside = join(base, "outside-target");
    write(outside, "victim.txt", "outside\n");
    await expect(copySeedFiles(source, stage, ["../../../escape.txt"])).rejects.toThrow("not a relative path");
    // A link planted in the stage folder is not written through, as a folder or as the file's own name.
    symlinkSync(outside, join(stage.path, "src"), "junction");
    await expect(copySeedFiles(source, stage, ["src/deep/b.ts"])).rejects.toThrow();
    linkSync(join(outside, "victim.txt"), join(stage.path, "notes.txt"));
    expect(await copySeedFiles(source, stage, ["notes.txt"])).toMatchObject([{ path: "notes.txt", size: 6 }]);
    expect(read(stage.path, "notes.txt")).toBe("notes\n");
    expect(tree(outside)).toEqual(["victim.txt"]);
    expect(read(outside, "victim.txt")).toBe("outside\n");
    await expect(copySeedFiles(source, stage, ["docs/guide.md"], new Map([["docs/guide.md", "0".repeat(64)]]))).rejects.toThrow();
    expect(existsSync(join(stage.path, "docs", "guide.md"))).toBe(false);
    // A source folder that is no longer the one held is not read.
    await expect(copySeedFiles({ path: outside, id: source.id }, stage, ["victim.txt"])).rejects.toThrow();
    expect(isInside(handle.runRoot, stage.path)).toBe(true);
  });

  it("a stage folder whose subfolder became a link gets no copy through it", async () => {
    const outside = join(base, "outside");
    mkdirSync(outside);
    let stage = "";
    const handle = await start(project, { sensitive: () => {
      if (stage !== "" && !existsSync(join(stage, "src"))) symlinkSync(outside, join(stage, "src"), "junction");
      return false;
    } });
    stage = join(handle.runRoot, "s1");
    expect(await handle.provider.prepare(handle.run, stageOf("s1", { inputFiles: [fromProject("src/deep/b.ts")] }), 1)).toEqual({ ok: false, code: "seed-unreadable" });
    expect(readdirSync(outside)).toEqual([]);
    expect(existsSync(stage)).toBe(false);
  });

  it("an output folder junction gets no collected file through it", async () => {
    const handle = await start(project);
    const stage = await stageRoot(handle, "s1", { outputs: ["report/**"] });
    write(stage, "report/deep/r.md", "report\n");
    await handle.provider.seal(handle.run, "s1");
    const outside = join(base, "outside");
    mkdirSync(outside);
    symlinkSync(outside, join(handle.out, "report"), "junction");
    await expect(handle.provider.integrate(handle.run, "j1", ["s1"])).rejects.toThrow();
    expect(readdirSync(outside)).toEqual([]);
    rmSync(join(handle.out, "report"));
    expect(await handle.provider.integrate(handle.run, "j1", ["s1"])).toEqual({ ok: true });
    expect(read(handle.out, "report/deep/r.md")).toBe("report\n");
  });

  it("an output folder replaced by a junction, or a collected file by other content, seeds nothing from there", async () => {
    const handle = await start(project);
    const first = await stageRoot(handle, "s1", { outputs: ["plan.md"] });
    write(first, "plan.md", "the plan\n");
    await handle.provider.seal(handle.run, "s1");
    expect(await handle.provider.integrate(handle.run, "j1", ["s1"])).toEqual({ ok: true });
    const fromFirst = { inputFiles: [{ from: "stage" as const, stageId: "s1" }] };
    // The collected file is no longer what was collected.
    write(handle.out, "plan.md", "edited since\n");
    expect(await handle.provider.prepare(handle.run, stageOf("s2", fromFirst), 1)).toEqual({ ok: false, code: "seed-unreadable" });
    write(handle.out, "plan.md", "the plan\n");
    const away = join(base, "out-away");
    const outside = join(base, "outside");
    write(outside, "plan.md", "the plan\n");
    renameSync(handle.out, away);
    symlinkSync(outside, handle.out, "junction");
    try {
      expect(await handle.provider.prepare(handle.run, stageOf("s2", fromFirst), 1)).toEqual({ ok: false, code: "seed-unreadable" });
      expect(existsSync(join(handle.runRoot, "s2"))).toBe(false);
    } finally {
      rmSync(handle.out);
      renameSync(away, handle.out);
    }
    expect(tree(await stageRoot(handle, "s2", fromFirst))).toEqual(["plan.md"]);
  });

  it("two stages' outputs that differ by case alone are one path where the output folder's names fold case", async () => {
    const handle = await start(project);
    write(await stageRoot(handle, "s1"), "Report.md", "from s1\n");
    write(await stageRoot(handle, "s2"), "report.md", "from s2\n");
    expect(await handle.provider.seal(handle.run, "s1")).toEqual({ ok: true });
    expect(await handle.provider.seal(handle.run, "s2")).toEqual({ ok: true });
    const folds = diskId(join(dirname(handle.out), basename(handle.out).toUpperCase())) === diskId(handle.out);
    const joined = await handle.provider.integrate(handle.run, "j1", ["s1", "s2"]);
    if (!folds) {
      expect(joined).toEqual({ ok: true });
      expect(tree(handle.out)).toEqual(["Report.md", "report.md"]);
      return;
    }
    expect(joined).toMatchObject({ ok: false, conflict: { reason: "same-path", files: [{ path: "Report.md", stageIds: ["s1", "s2"] }] } });
    expect(tree(handle.out)).toEqual([]);
  });

  it("outputs spelled with the two small sigmas are one path where names fold case", async () => {
    // One capital letter stands for both: a fold to small letters would keep them apart.
    const nameReader: NameReader = { list: directory => readdirSync(directory), id: path => `1:${path.toLowerCase()}` };
    const handle = await start(project, { nameReader });
    write(await stageRoot(handle, "s1"), "σ.md", "from s1\n");
    write(await stageRoot(handle, "s2"), "ς.md", "from s2\n");
    expect(await handle.provider.seal(handle.run, "s1")).toEqual({ ok: true });
    expect(await handle.provider.seal(handle.run, "s2")).toEqual({ ok: true });
    expect(await handle.provider.integrate(handle.run, "j1", ["s1", "s2"])).toMatchObject({ ok: false, conflict: { reason: "same-path", files: [{ path: "σ.md", stageIds: ["s1", "s2"] }] } });
    expect(tree(handle.out)).toEqual([]);
  });

  it("collects outputs into _out and reports the same path from two stages as a conflict", async () => {
    const handle = await start(project);
    const first = await stageRoot(handle, "s1", { outputs: ["report/**"] });
    const second = await stageRoot(handle, "s2", { outputs: ["report/**"] });
    write(first, "report/summary.md", "from s1\n");
    write(first, "report/s1.md", "s1\n");
    write(first, "scratch.txt", "not an output\n");
    write(first, ".env", "TOKEN=fixture\n");
    write(second, "report/summary.md", "from s2\n");
    write(second, "report/s2.md", "s2\n");
    expect(await handle.provider.seal(handle.run, "s1")).toEqual({ ok: true });
    expect(await handle.provider.seal(handle.run, "s2")).toEqual({ ok: true });

    const result = await handle.provider.integrate(handle.run, "j1", ["s1", "s2"]);
    expect(result).toMatchObject({ ok: false, conflict: { reason: "same-path", files: [{ path: "report/summary.md", stageIds: ["s1", "s2"] }] } });
    if (result.ok) throw new Error("expected a conflict");
    expect(result.conflict.conflictHash).toMatch(/^[0-9a-f]{64}$/u);
    // Nothing was copied, not even the files that do not collide.
    expect(tree(handle.out)).toEqual([]);
    const again = await handle.provider.integrate(handle.run, "j1", ["s1", "s2"]);
    expect(again.ok === false && again.conflict.conflictHash).toBe(result.conflict.conflictHash);

    // The user settles it by putting their answer in the output folder; a retry keeps it.
    write(handle.out, "report/summary.md", "decided by the user\n");
    expect(await handle.provider.integrate(handle.run, "j1", ["s1", "s2"])).toEqual({ ok: true });
    expect(tree(handle.out)).toEqual(["report/s1.md", "report/s2.md", "report/summary.md"]);
    expect(read(handle.out, "report/summary.md")).toBe("decided by the user\n");

    // Stage folders go, the output folder stays.
    await handle.provider.release(handle.run, ["s1", "s2"]);
    expect(existsSync(first)).toBe(false);
    await handle.provider.release(handle.run, "all");
    expect(tree(handle.out)).toEqual(["report/s1.md", "report/s2.md", "report/summary.md"]);
  });

  it("two stages with the same content at one path are not a conflict", async () => {
    const handle = await start(project);
    const first = await stageRoot(handle, "s1");
    const second = await stageRoot(handle, "s2");
    write(first, "same.txt", "same\n");
    write(second, "same.txt", "same\n");
    await handle.provider.seal(handle.run, "s1");
    await handle.provider.seal(handle.run, "s2");
    expect(await handle.provider.integrate(handle.run, "j1", ["s1", "s2"])).toEqual({ ok: true });
    expect(read(handle.out, "same.txt")).toBe("same\n");
  });

  it("a later stage is seeded from _out", async () => {
    const handle = await start(project);
    const first = await stageRoot(handle, "s1", { outputs: ["plan.md"] });
    write(first, "plan.md", "the plan\n");
    write(first, "scratch.txt", "scratch\n");
    await handle.provider.seal(handle.run, "s1");
    expect(await handle.provider.integrate(handle.run, "j1", ["s1"])).toEqual({ ok: true });

    const later = await stageRoot(handle, "s2", { inputFiles: [{ from: "stage", stageId: "s1" }, fromProject("notes.txt")] });
    expect(tree(later)).toEqual(["notes.txt", "plan.md"]);
    // It may replace what it was seeded with; an edit by anyone else at that path would be a conflict.
    write(later, "plan.md", "the plan, revised\n");
    await handle.provider.seal(handle.run, "s2");
    expect(await handle.provider.integrate(handle.run, "j2", ["s2"])).toEqual({ ok: true });
    expect(read(handle.out, "plan.md")).toBe("the plan, revised\n");

    const stranger = await stageRoot(handle, "s3");
    write(stranger, "plan.md", "another plan\n");
    await handle.provider.seal(handle.run, "s3");
    expect(await handle.provider.integrate(handle.run, "j3", ["s3"])).toMatchObject({ ok: false, conflict: { reason: "same-path", files: [{ path: "plan.md", stageIds: ["s2", "s3"] }] } });
    expect(read(handle.out, "plan.md")).toBe("the plan, revised\n");
  });

  it("release keeps _out and the record; discard removes them and the emptied run folder, for removable runs only", async () => {
    const handle = await start(project);
    const first = await stageRoot(handle, "s1", { outputs: ["plan.md"] });
    write(first, "plan.md", "the plan\n");
    await handle.provider.seal(handle.run, "s1");
    expect(await handle.provider.integrate(handle.run, "j1", ["s1"])).toEqual({ ok: true });
    const other = await start(project);

    await handle.provider.release(handle.run, "all");
    expect(existsSync(first)).toBe(false);
    expect(read(handle.out, "plan.md")).toBe("the plan\n");
    expect(existsSync(join(handle.runRoot, RUN_FILE))).toBe(true);

    // As after a restart: a provider that never saw the run finds it by its id.
    // With nothing to say which runs are removable, and with an answer that could not be had, nothing goes.
    await createStageWorkspaceProvider({ git: createHostGit({ env }) }).discard();
    await createStageWorkspaceProvider({ git: createHostGit({ env }), removable: async () => undefined }).discard();
    expect(read(handle.out, "plan.md")).toBe("the plan\n");
    // What a stop during a seeding left, under the name of this build and under the one an earlier build used, goes with the run.
    write(handle.runRoot, "_ignore-Ab12Cd/.git/HEAD", "ref: refs/heads/main\n");
    write(handle.runRoot, "_ignore/.git/HEAD", "ref: refs/heads/main\n");
    // As after a restart: a provider that never saw the run finds it by its record.
    const asked: { runId: string; itemId: number }[] = [];
    const restarted = createStageWorkspaceProvider({ git: createHostGit({ env }), removable: async () => (run) => { asked.push(run); return run.runId === handle.run.runId; } });
    await restarted.discard();
    expect(existsSync(handle.runRoot)).toBe(false);
    expect(asked).toEqual(expect.arrayContaining([{ runId: handle.run.runId, itemId: handle.run.itemId }, { runId: other.run.runId, itemId: other.run.itemId }]));
    // Another run of the same project is untouched, and a second pass is a no-op.
    expect(existsSync(other.out)).toBe(true);
    await restarted.discard();
    expect(read(project, "notes.txt")).toBe("notes\n");
  });

  it("the boot sweep takes what a stop left of the ignore matcher out of a run that goes on, and nothing else of that run", async () => {
    const handle = await start(project);
    const stage = await stageRoot(handle, "s1", { inputFiles: [fromProject("notes.txt")] });
    write(handle.out, "result.md", "collected\n");
    // As a stop during a seeding leaves it: the matcher's repository, and beside it one whose name is a link out of the run.
    write(handle.runRoot, "_ignore-Ab12Cd/.git/HEAD", "ref: refs/heads/main\n");
    // An earlier build made it under one fixed name.
    write(handle.runRoot, "_ignore/.git/HEAD", "ref: refs/heads/main\n");
    const outside = join(base, "outside");
    write(outside, "keep.md", "not the run's\n");
    symlinkSync(outside, join(handle.runRoot, "_ignore-linked"), "junction");

    await createStageWorkspaceProvider({ git: createHostGit({ env }), removable: async () => () => true }).sweep([handle.run.runId]);
    expect(readdirSync(handle.runRoot).sort()).toEqual(["_out", "_run.json", "s1"]);
    expect(tree(stage)).toEqual(["notes.txt"]);
    expect(read(handle.out, "result.md")).toBe("collected\n");
    expect(read(outside, "keep.md")).toBe("not the run's\n");
    // The run is still the provider's to prepare in.
    expect(tree(await stageRoot(handle, "s2", { inputFiles: [fromProject("notes.txt")] }))).toEqual(["notes.txt"]);
  });

  it("an output folder goes only when the stores still allow it once its run's queue is held, whatever an earlier read said", async () => {
    const handle = await start(project);
    write(handle.out, "result.md", "collected\n");
    await handle.provider.release(handle.run, "all");
    // The first read is the stale one: it allows the removal, and every later read does not.
    let reads = 0;
    let fails = false;
    const restarted = createStageWorkspaceProvider({ git: createHostGit({ env }), removable: async () => {
      reads += 1;
      const first = reads === 1;
      if (!first && fails) throw new Error("the stores cannot be read");
      return run => run.runId === handle.run.runId && first;
    } });
    await restarted.discard();
    expect(reads).toBe(2);
    reads = 0;
    await restarted.sweep([]);
    expect(reads).toBe(2);
    // A second read that cannot be had removes nothing either.
    fails = true;
    reads = 0;
    await expect(restarted.discard()).rejects.toThrow("the stores cannot be read");
    reads = 0;
    await restarted.sweep([]);
    expect(readdirSync(handle.runRoot).sort()).toEqual(["_out", "_run.json"]);
    expect(read(handle.out, "result.md")).toBe("collected\n");
  });

  it("a run record that is a link, has a second name, lacks a field or is of an earlier version authorizes no cleanup", async () => {
    const handle = await start(project);
    await stageRoot(handle, "s1");
    write(handle.out, "result.md", "collected\n");
    const record = join(handle.runRoot, RUN_FILE);
    const written = readFileSync(record, "utf8");
    const elsewhere = join(base, "restored-record.json");
    const changed = (fields: Record<string, unknown>): void => writeFileSync(record, JSON.stringify({ ...JSON.parse(written) as object, ...fields }));
    const records: [string, () => void][] = [
      ["a second name", () => { writeFileSync(elsewhere, written); linkSync(elsewhere, record); }],
      ["a link", () => {
        writeFileSync(elsewhere, written);
        // Where the account may not make a file link, the second name above stands for it.
        try { symlinkSync(elsewhere, record, "file"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error; linkSync(elsewhere, record); }
      }],
      ["no stages", () => changed({ stages: undefined })],
      ["no kind", () => changed({ kind: undefined })],
      ["no self", () => changed({ self: undefined })],
      ["a stage that is no stage", () => changed({ stages: { "../_out": { ready: true, attempt: 1, dir: "1:1" } } })],
      ["a ready stage that names no folder", () => changed({ stages: { s1: { ready: true, attempt: 1 } } })],
      ["a folder run that names a branch", () => changed({ branch: "main" })],
      // The record an earlier build wrote for this very run: it names no directory, so it directs nothing.
      ["an earlier version", () => writeFileSync(record, JSON.stringify({
        v: 1, runId: handle.run.runId, itemId: handle.run.itemId, kind: "folder", projectRoot: realpathSync.native(project),
        stages: { s1: { ready: true, attempt: 1 } }, joins: {}, out: {},
      }))],
    ];
    for (const [name, plant] of records) {
      rmSync(record);
      rmSync(elsewhere, { force: true });
      plant();
      const restarted = createStageWorkspaceProvider({ git: createHostGit({ env }), removable: async () => () => true });
      await restarted.discard();
      await restarted.sweep([]);
      expect(readdirSync(handle.runRoot).sort(), name).toEqual(["_out", "_run.json", "s1"]);
      expect(read(handle.out, "result.md"), name).toBe("collected\n");
      expect(await restarted.prepare(handle.run, stageOf("s2"), 1), name).toEqual({ ok: false, code: "workspace-unavailable" });
    }
    rmSync(record);
    writeFileSync(record, written);
  });

  it("a run folder restored from a copy is no record", async () => {
    const handle = await start(project);
    write(handle.out, "result.md", "collected\n");
    await handle.provider.release(handle.run, "all");
    const away = join(base, "run-away");
    cpSync(handle.runRoot, away, { recursive: true });
    rmSync(handle.runRoot, { recursive: true });
    cpSync(away, handle.runRoot, { recursive: true });
    const restarted = createStageWorkspaceProvider({ git: createHostGit({ env }), removable: async () => () => true });
    await restarted.discard();
    await restarted.sweep([]);
    expect(readdirSync(handle.runRoot).sort()).toEqual(["_out", "_run.json"]);
    expect(read(handle.out, "result.md")).toBe("collected\n");
    expect(await restarted.prepare(handle.run, stageOf("s1"), 1)).toEqual({ ok: false, code: "workspace-unavailable" });
    rmSync(handle.runRoot, { recursive: true });
  });

  describe.each(["discard", "sweep"] as const)("what a %s may remove of a folder run", (operation) => {
    /** Item 7's run with a collected file, parked; item 8's run of the same project, collected too; as after a restart, with item 7
     * gone from the board and item 8 still on it. */
    async function scene(): Promise<{ target: Handle; stage: string; other: Handle; record: string; written: string; operate: () => Promise<void> }> {
      const collected = async (itemId: number): Promise<{ handle: Handle; stage: string }> => {
        const handle = await start(project, {}, itemId);
        const stage = await stageRoot(handle, "s1", { outputs: ["plan.md"] });
        write(stage, "plan.md", "the plan\n");
        await handle.provider.seal(handle.run, "s1");
        expect(await handle.provider.integrate(handle.run, "j1", ["s1"])).toEqual({ ok: true });
        return { handle, stage };
      };
      const { handle: target, stage } = await collected(7);
      const { handle: other } = await collected(8);
      const record = join(target.runRoot, RUN_FILE);
      const operate = async (): Promise<void> => {
        const provider = createStageWorkspaceProvider({ git: createHostGit({ env }), removable: async () => run => run.itemId !== 8 });
        await (operation === "discard" ? provider.discard() : provider.sweep([]));
      };
      return { target, stage, other, record, written: readFileSync(record, "utf8"), operate };
    }

    // The project's identity is about the project, not the run folder, and a folder run has nothing in a repository to leave alone.
    it.each<[string, (string | number)[], unknown]>([
      ["every field as it was written", [], undefined],
      ["a project.id that no longer matches", ["project", "id"], "1:1"],
    ])("with %s, the run folder and its output go and nothing else", async (_name, path, value) => {
      const at = await scene();
      if (path.length > 0) setPath(at.record, path, value);
      await at.operate();
      expect(existsSync(at.target.runRoot)).toBe(false);
      expect(read(at.other.out, "plan.md")).toBe("the plan\n");
      expect(tree(project)).toEqual(["docs/guide.md", "notes.txt", "src/a.ts", "src/deep/b.ts"]);
    });

    it.each<[string, (string | number)[], unknown]>([
      ["v", ["v"], 1],
      ["itemId", ["itemId"], 99],
      ["self", ["self"], "1:1"],
      ["outDir", ["outDir"], "1:1"],
      ["stages.s1.dir", ["stages", "s1", "dir"], "1:1"],
    ])("a record whose %s no longer matches stops it: nothing of the run goes", async (_field, path, value) => {
      const at = await scene();
      setPath(at.record, path, value);
      try {
        await at.operate();
        expect(read(at.stage, "plan.md")).toBe("the plan\n");
        expect(read(at.target.out, "plan.md")).toBe("the plan\n");
        expect(read(at.other.out, "plan.md")).toBe("the plan\n");
      } finally {
        writeFileSync(at.record, at.written);
      }
    });
  });

  it("a planted record tmp link does not write through", async () => {
    const handle = await start(project);
    const victim = join(base, "victim.txt");
    writeFileSync(victim, "outside\n");
    linkSync(victim, join(handle.runRoot, `${RUN_FILE}.tmp`));
    expect(tree(await stageRoot(handle, "s1", { inputFiles: [fromProject("notes.txt")] }))).toEqual(["notes.txt"]);
    expect(readFileSync(victim, "utf8")).toBe("outside\n");
    expect(readdirSync(handle.runRoot).sort()).toEqual(["_out", "_run.json", "s1"]);
  });

  it("a run or project folder replaced by a link after it was listed is not cleaned through", async () => {
    const settled = async (root: string): Promise<Handle> => {
      const handle = await start(root);
      await stageRoot(handle, "s1");
      write(handle.out, "result.md", "collected\n");
      return handle;
    };
    const second = join(base, "second");
    const third = join(base, "third");
    for (const root of [second, third]) write(root, "notes.txt", "notes\n");
    // Two runs of one project, then two of two projects: whichever is asked about first, the other's folder is swapped meanwhile.
    for (const [level, roots] of [["run", [project, project]], ["project", [second, third]]] as const) {
      const handles = [await settled(roots[0]), await settled(roots[1])];
      const restored = join(base, `restored-${level}`);
      let swapped: Handle | undefined;
      const restarted = createStageWorkspaceProvider({ git: createHostGit({ env }), removable: async () => (run) => {
        const mine = handles.find(handle => handle.run.runId === run.runId);
        if (mine !== undefined && swapped === undefined) {
          swapped = handles.find(handle => handle !== mine) as Handle;
          const replaced = level === "run" ? swapped.runRoot : dirname(swapped.runRoot);
          // As a restore of the home does: the folder is moved away and a link to the copy stands in its place.
          renameSync(replaced, restored);
          symlinkSync(restored, replaced, "junction");
        }
        return mine !== undefined;
      } });
      await restarted.discard();
      await restarted.sweep([]);
      if (swapped === undefined) throw new Error("no folder was swapped");
      const kept = level === "run" ? restored : join(restored, relative(dirname(swapped.runRoot), swapped.runRoot));
      expect(readdirSync(kept).sort(), level).toEqual(["_out", "_run.json", "s1"]);
      expect(read(join(kept, "_out"), "result.md"), level).toBe("collected\n");
      // The run that was not swapped went as usual.
      expect(handles.filter(handle => handle !== swapped).map(handle => existsSync(handle.runRoot)), level).toEqual([false]);
      rmSync(level === "run" ? swapped.runRoot : dirname(swapped.runRoot));
    }
  });

  it("a run folder swapped for a link before the ignore matcher is needed gets no repository made through the link", async () => {
    write(project, ".gitignore", "*.log\n");
    write(project, "a.log", "ignored\n");
    const restored = join(base, "restored");
    const watched = watchedGit();
    let runRoot = "";
    const provider = createStageWorkspaceProvider({ git: watched.git, sensitive: () => {
      if (runRoot !== "" && !existsSync(restored)) {
        renameSync(runRoot, restored);
        symlinkSync(restored, runRoot, "junction");
      }
      return false;
    } });
    runs += 1;
    const run: RunRef = { itemId: 7, runId: `run-folder-${process.pid}-${Date.now()}-${runs}`, runKey: "key" };
    const open = await provider.open(run, project);
    if (!open.ok) throw new Error(open.code);
    runRoot = open.workspace.runRoot;
    try {
      const prepared = await provider.prepare(run, stageOf("s1", { inputFiles: [fromProject("**")] }), 1).catch((error: unknown) => error);
      expect(existsSync(restored)).toBe(true);
      expect(watched.made).toEqual([]);
      expect(readdirSync(restored).filter(name => name.startsWith("_ignore"))).toEqual([]);
      expect(prepared).toEqual({ ok: false, code: "seed-unreadable" });
    } finally {
      if (existsSync(restored)) {
        rmSync(runRoot);
        renameSync(restored, runRoot);
      }
      await provider.release(run, "all");
    }
  });
});
