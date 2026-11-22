import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { _resetAveHomePrivacyForTest, aveHome, setAveHomePrivacyAtBoot } from "../../../shared/ave-home.js";
import type { StageInputDecl } from "../../../shared/workflow-template-types.js";
import { createHostGit } from "../host-git.js";
import type { RunRef } from "../stage-workspace.js";
import { createStageWorkspaceProvider, type StageWorkspaceOptions } from "../stage-workspaces.js";
import { OUT_DIR } from "../workspace-layout.js";
import { copySeedFiles, listSeedFiles } from "../workspace-seed.js";
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
});
