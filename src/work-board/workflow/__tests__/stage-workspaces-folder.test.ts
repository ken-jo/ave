import { execFileSync } from "node:child_process";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { _resetAveHomePrivacyForTest, aveHome, setAveHomePrivacyAtBoot } from "../../../shared/ave-home.js";
import type { StageInputDecl } from "../../../shared/workflow-template-types.js";
import { plainFolderIgnore } from "../folder-ignore.js";
import { createHostGit, type HostGit, HostGitError } from "../host-git.js";
import type { RunRef } from "../stage-workspace.js";
import { createStageWorkspaceProvider, type StageWorkspaceOptions } from "../stage-workspaces.js";
import { OUT_DIR, RUN_FILE } from "../workspace-layout.js";
import { copySeedFiles, isInside, listSeedFiles } from "../workspace-seed.js";
import { stageOf, writeUnder as write } from "./stage-fixtures.js";

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
const fromProject = (...paths: string[]): StageInputDecl => ({ from: "project", paths });

async function start(root: string | undefined, options: StageWorkspaceOptions = {}): Promise<Handle> {
  runs += 1;
  const run: RunRef = { itemId: 7, runId: `run-folder-${process.pid}-${Date.now()}-${runs}`, runKey: "key" };
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

/** The real host git, noting where each ignore matcher's repository is made; `broken` makes a call fail after it ran, or throw instead. */
function watchedGit(broken?: (args: readonly string[]) => "fails" | HostGitError | undefined): { git: HostGit; made: string[] } {
  const real = createHostGit({ env });
  const made: string[] = [];
  const run: HostGit["run"] = async (cwd, args, call) => {
    if (args[0] === "init") made.push(args.at(-1) ?? "");
    const how = broken?.(args);
    if (how instanceof HostGitError) throw how;
    const result = await real.run(cwd, args, call);
    return how === "fails" ? { ...result, code: 128 } : result;
  };
  return { made, git: { run, drivers: real.drivers } };
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
});

describe("folder stage workspaces", () => {
  it("the layout carries no raw path, run id or title, and no stage is named like a host folder", async () => {
    const home = realpathSync.native(aveHome());
    const withProject = await start(project);
    expect(relative(home, withProject.runRoot).split(sep)).toEqual(["worktrees", expect.stringMatching(/^project-[0-9a-f]{8}$/u), expect.stringMatching(/^[0-9a-f]{12}$/u)]);
    expect(withProject.runRoot).not.toContain(withProject.run.runId);
    expect(relative(home, await stageRoot(withProject, "s1")).split(sep)).toHaveLength(4);
    const without = await start(undefined);
    expect(relative(home, without.runRoot).split(sep).slice(0, 2)).toEqual(["worktrees", "board-7"]);
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

  it("a home relocated beneath the project gets no matcher repository: the stage is refused and nothing is made in the project", async () => {
    write(project, "debug.log", "log\n");
    write(project, ".gitignore", "*.log\n");
    const home = process.env.AVE_HOME;
    mkdirSync(join(project, "profile"));
    process.env.AVE_HOME = join(project, "profile");
    try {
      const watched = watchedGit();
      const handle = await start(project, { git: watched.git });
      expect(isInside(realpathSync.native(project), realpathSync.native(handle.runRoot))).toBe(true);
      expect(await handle.provider.prepare(handle.run, stageOf("s1", { inputFiles: [fromProject("src/**")] }), 1)).toEqual({ ok: false, code: "seed-unreadable" });
      expect(watched.made).toEqual([]);
      expect(readdirSync(handle.runRoot).sort()).toEqual(["_out", "_run.json"]);
      // A stage with no project input needs no rules and is prepared as before.
      expect(tree(await stageRoot(handle, "s2"))).toEqual([]);
      await handle.provider.release(handle.run, "all");
      opened.splice(opened.indexOf(handle), 1);
    } finally {
      if (home === undefined) delete process.env.AVE_HOME; else process.env.AVE_HOME = home;
    }
  });

  it("the matcher takes each path whole: a name with a line break in it is one path", async () => {
    write(project, ".gitignore", "*.log\n");
    const runRoot = join(base, "run");
    mkdirSync(runRoot);
    const removed: string[] = [];
    const rules = plainFolderIgnore(createHostGit({ env }), runRoot, project, (scratch) => { removed.push(scratch); rmSync(scratch, { recursive: true }); });
    expect([...await rules.ignored(["line\nbreak.log", "line\nbreak.txt", "plain.log", "notes.txt", "src/"])].sort()).toEqual(["line\nbreak.log", "plain.log"]);
    rules.done();
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
    const unignored = execFileSync("git", ["-c", "core.excludesFile=", "ls-files", "-z", "--others", "--exclude-standard"], { cwd: twin, env, encoding: "utf8" }).split("\0").filter(Boolean).sort();
    // The fixture does exercise both: a negation that takes effect, one under an excluded folder that cannot, and rules that prune folders.
    expect(unignored).toEqual(expect.arrayContaining(["keep.log", "docs/important.log", "docs/draft-keep.md", "src/top.txt", "docs/x/guide.md"]));
    for (const path of ["a.log", "top.txt", "build/out.js", "src/build/out.js", "deep/a/cache/kept.txt", "deep/a/b/cache/x.bin", "docs/sub/readme.md", "docs/x/y/draft-2.md", "docs/guide.md"]) expect(unignored, path).not.toContain(path);

    const handle = await start(project);
    expect(tree(await stageRoot(handle, "s1", { inputFiles: [fromProject("**")] }))).toEqual(unignored);
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

  it("refuses a destination outside the run root", async () => {
    const handle = await start(project);
    const stage = await stageRoot(handle, "s1");
    await expect(copySeedFiles(project, join(base, "elsewhere"), handle.runRoot, ["notes.txt"])).rejects.toThrow("outside the run root");
    await expect(copySeedFiles(project, stage, handle.runRoot, ["../../../escape.txt"])).rejects.toThrow("not a relative path");
    // A link planted in the stage folder is not written through.
    symlinkSync(join(base, "outside-target"), join(stage, "src"), "junction");
    await expect(copySeedFiles(project, stage, handle.runRoot, ["src/a.ts"])).rejects.toThrow();
    expect(existsSync(join(base, "elsewhere"))).toBe(false);
    expect(existsSync(join(base, "outside-target"))).toBe(false);
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

  it("a run record that is a link, has a second name or lacks a field authorizes no cleanup", async () => {
    const handle = await start(project);
    await stageRoot(handle, "s1");
    write(handle.out, "result.md", "collected\n");
    const record = join(handle.runRoot, RUN_FILE);
    const written = readFileSync(record, "utf8");
    const elsewhere = join(base, "restored-record.json");
    const records: [string, () => void][] = [
      ["a second name", () => { writeFileSync(elsewhere, written); linkSync(elsewhere, record); }],
      ["a link", () => {
        writeFileSync(elsewhere, written);
        // Where the account may not make a file link, the second name above stands for it.
        try { symlinkSync(elsewhere, record, "file"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error; linkSync(elsewhere, record); }
      }],
      ["no stages", () => writeFileSync(record, JSON.stringify({ v: 1, runId: handle.run.runId, itemId: handle.run.itemId }))],
      ["no kind", () => writeFileSync(record, JSON.stringify({ ...JSON.parse(written) as object, kind: undefined }))],
      ["a stage that is no stage", () => writeFileSync(record, JSON.stringify({ ...JSON.parse(written) as object, stages: { "../_out": { ready: true, attempt: 1 } } }))],
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
});
