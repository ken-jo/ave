import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { isSensitivePath } from "../../permissions/sensitive-paths.js";
import { aveHome, getAveHomePrivacyFailure, isAveHomeBoundaryUnverifiedAtBoot } from "../../shared/ave-home.js";
import { canonicalWorkflowJson, resultHashOf } from "../../shared/workflow-template-output.js";
import type { RunWorkspace, TemplateStage } from "../../shared/workflow-template-types.js";
import { isStageId } from "../template-graph.js";
import { createHostGit, type HostGit, HostGitError } from "./host-git.js";
import type { JoinConflict } from "./shipped-shapes.js";
import type { RunRef, StageWorkspaceProvider, WORKSPACE_REFUSALS } from "./stage-workspace.js";
import { JOIN_DIR, OUT_DIR, RUN_FILE, runBranch, runRootOf, runSlug, stageDirName, WORKTREES_DIR } from "./workspace-layout.js";
import { copySeedFiles, hashSeedFile, isInside, listSeedFiles, MAX_SEED_BYTES, MAX_SEED_FILES, type SeedRules } from "./workspace-seed.js";

type Refusal = typeof WORKSPACE_REFUSALS[number];
type ConflictFile = JoinConflict["files"][number];
interface OutputFile { path: string; sha256: string; size: number }

interface StageEntry {
  /** False while the folder is being made; such a folder is made again. */
  ready: boolean;
  attempt: number;
  /** Git: the commit the worktree started from, and the worktree link file as the host wrote it. */
  base?: string;
  link?: string;
  sealCommit?: string;
  /** Folder: the output globs, what was seeded (path → sha256) and the sealed manifest. */
  outputs?: string[];
  seeded?: Record<string, string>;
  manifest?: OutputFile[];
  sealed?: boolean;
}
/** The host's record of one run's workspaces, beside the stage folders. Every later call finds the run through it. */
interface RunFileV1 {
  v: 1;
  runId: string;
  itemId: number;
  kind: "git" | "folder";
  projectRoot?: string;
  /** Folder kind: the project lies in a git work tree, whose ignore rules apply to seeding. */
  ignoreRules?: boolean;
  branch?: string;
  baseCommit?: string;
  stages: Record<string, StageEntry>;
  /** Git: the seal commit a host merge is in the middle of. */
  merging?: string;
  /** Folder: the joins already collected, and who put each file into the output folder. */
  joins: Record<string, true>;
  out: Record<string, { sha256: string; size: number; stageId: string }>;
}

export interface StageWorkspaceOptions {
  git?: HostGit;
  /** The secret-file test; the default is the permission layer's own. */
  sensitive?: (absolutePath: string) => boolean;
  seedLimits?: { files: number; bytes: number };
  /** Which runs may lose their output folder: those with no record whose item is gone, as the stores are now. With none, or an
   * answer of undefined, nothing is discarded. */
  removable?: () => Promise<((run: { runId: string; itemId: number }) => boolean) | undefined>;
}

const samePath = (left: string, right: string): boolean => {
  const fold = (value: string): string => process.platform === "win32" ? resolve(value).toLowerCase() : resolve(value);
  return fold(left) === fold(right);
};
const plainDirectory = (path: string): boolean => {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  return stat?.isDirectory() === true && !stat.isSymbolicLink();
};
const nul = (text: string): string[] => text.split("\0").filter(entry => entry !== "");
const chunked = <T>(items: readonly T[], size = 200): T[][] => Array.from({ length: Math.ceil(items.length / size) }, (_, index) => items.slice(index * size, (index + 1) * size));

/** Stage workspaces under `<aveHome>/worktrees`: a git worktree per stage for a git project, a seeded plain folder otherwise. */
export function createStageWorkspaceProvider(options: StageWorkspaceOptions = {}): StageWorkspaceProvider {
  const git = options.git ?? createHostGit();
  const sensitive = options.sensitive ?? ((path: string) => isSensitivePath(path, "read") !== null);
  const roots = new Map<string, string>();
  const chains = new Map<string, Promise<unknown>>();

  /** One call at a time per run: parallel stages share the run file and the repository's worktree list. */
  function serial<T>(runId: string, work: () => Promise<T>): Promise<T> {
    const next = (chains.get(runId) ?? Promise.resolve()).then(work, work);
    const tail = next.catch(() => undefined);
    chains.set(runId, tail);
    void tail.then(() => { if (chains.get(runId) === tail) chains.delete(runId); });
    return next;
  }

  const worktreesRoot = (): string => join(aveHome(), WORKTREES_DIR);

  function readRunFile(runRoot: string): RunFileV1 | null {
    try {
      const file = JSON.parse(readFileSync(join(runRoot, RUN_FILE), "utf8")) as RunFileV1;
      return file.v === 1 && typeof file.runId === "string" ? file : null;
    } catch {
      return null;
    }
  }

  function writeRunFile(runRoot: string, file: RunFileV1): void {
    const target = join(runRoot, RUN_FILE);
    writeFileSync(`${target}.tmp`, JSON.stringify(file), { mode: 0o600 });
    renameSync(`${target}.tmp`, target);
  }

  /** The run's folder and record, found again after a restart by the run's slug. */
  function locate(run: Pick<RunRef, "runId">): { runRoot: string; file: RunFileV1 } | null {
    const slug = runSlug(run.runId);
    const known = roots.get(run.runId);
    const candidates = known !== undefined ? [known]
      : plainDirectory(worktreesRoot()) ? readdirSync(worktreesRoot()).map(project => join(worktreesRoot(), project, slug)) : [];
    for (const runRoot of candidates) {
      if (!plainDirectory(dirname(runRoot)) || !plainDirectory(runRoot)) continue;
      const file = readRunFile(runRoot);
      if (file?.runId !== run.runId) continue;
      roots.set(run.runId, runRoot);
      return { runRoot, file };
    }
    return null;
  }

  /** Removes one folder the provider made. Anything outside the run root, or the run root itself, is refused. */
  function removeFolder(runRoot: string, target: string): void {
    if (!isInside(runRoot, target) || !isInside(worktreesRoot(), runRoot)) throw new Error("refusing to remove a path outside the run root");
    rmSync(target, { recursive: true, force: true, maxRetries: 3 });
  }

  async function gitOut(cwd: string, args: readonly string[], call?: { stdin?: string; drivers?: readonly string[] }): Promise<string> {
    const result = await git.run(cwd, args, call);
    if (result.code !== 0) throw new Error(`git ${args[0] ?? ""} failed (${result.code}): ${result.stderr.trim().slice(0, 300)}`);
    return result.stdout;
  }

  /** The HEAD commit when `root` is the top level of a git work tree that has one; null for every other folder. */
  async function gitProject(root: string): Promise<{ baseCommit: string } | { inWorkTree: boolean }> {
    let top: Awaited<ReturnType<HostGit["run"]>>;
    try {
      top = await git.run(root, ["rev-parse", "--show-toplevel"]);
    } catch (error) {
      // No git on this machine: every project is a plain folder.
      if (error instanceof HostGitError && error.reason === "unavailable") return { inWorkTree: false };
      throw error;
    }
    if (top.code !== 0) return { inWorkTree: false };
    let topLevel: string;
    try { topLevel = realpathSync.native(top.stdout.replace(/\r?\n$/u, "")); } catch { return { inWorkTree: false }; }
    if (!samePath(topLevel, root)) return { inWorkTree: true };
    const head = await git.run(root, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
    return head.code === 0 ? { baseCommit: head.stdout.trim() } : { inWorkTree: true };
  }

  async function usesFilter(root: string, filters: readonly string[]): Promise<boolean> {
    const tracked = await gitOut(root, ["ls-files", "-z"]);
    if (tracked === "") return false;
    const attributes = nul(await gitOut(root, ["check-attr", "-z", "--stdin", "filter"], { stdin: tracked }));
    for (let index = 2; index < attributes.length; index += 3) if (filters.includes(attributes[index] ?? "")) return true;
    return false;
  }

  async function identityOf(root: string): Promise<boolean> {
    for (const key of ["user.name", "user.email"]) {
      const value = await git.run(root, ["config", "--get", key]);
      if (value.code !== 0 || value.stdout.trim() === "") return false;
    }
    return true;
  }

  const trailers = (run: RunRef, stageId?: string): string => `Ave-Run: ${run.runId}\n${stageId !== undefined ? `Ave-Stage: ${stageId}\n` : ""}`;

  function ignoreRulesOf(file: RunFileV1): SeedRules["ignored"] {
    const root = file.projectRoot;
    if (root === undefined || file.ignoreRules !== true) return undefined;
    return async (paths) => {
      const checked = await git.run(root, ["check-ignore", "-z", "--stdin"], { stdin: paths.map(path => `${path}\0`).join("") });
      // Exit 1: none of them is ignored.
      if (checked.code !== 0 && checked.code !== 1) throw new Error("the project's ignore rules could not be read");
      return new Set(nul(checked.stdout));
    };
  }

  const seedRules = (file: RunFileV1, withIgnore: boolean): SeedRules => {
    const ignored = withIgnore ? ignoreRulesOf(file) : undefined;
    return { sensitive, ...(ignored ? { ignored } : {}), ...(options.seedLimits ? { limits: options.seedLimits } : {}) };
  };

  async function open(run: RunRef, projectRoot: string | undefined): Promise<{ ok: true; workspace: RunWorkspace } | { ok: false; code: Refusal }> {
    // A home whose privacy or read boundary could not be checked gets no workspace made in it.
    if (isAveHomeBoundaryUnverifiedAtBoot() || getAveHomePrivacyFailure() !== undefined) return { ok: false, code: "home-boundary-unverified" };
    let canonical: string | undefined;
    if (projectRoot !== undefined) {
      try { canonical = realpathSync.native(projectRoot); } catch { return { ok: false, code: "workspace-unavailable" }; }
      if (!plainDirectory(canonical)) return { ok: false, code: "workspace-unavailable" };
    }
    const home = aveHome();
    const runRoot = runRootOf(home, canonical === undefined ? undefined : process.platform === "win32" ? canonical.toLowerCase() : canonical, run.itemId, run.runId);
    // Each level is made on its own and must be a real directory: a link would put the run somewhere else.
    try {
      if (!plainDirectory(home)) return { ok: false, code: "home-boundary-unverified" };
      for (const level of [worktreesRoot(), dirname(runRoot)]) {
        mkdirSync(level, { recursive: false, mode: 0o700 });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") return { ok: false, code: "home-boundary-unverified" };
    }
    if (!existsSync(dirname(runRoot))) {
      try { mkdirSync(dirname(runRoot), { mode: 0o700 }); } catch { return { ok: false, code: "home-boundary-unverified" }; }
    }
    if (!plainDirectory(worktreesRoot()) || !plainDirectory(dirname(runRoot))) return { ok: false, code: "home-boundary-unverified" };
    try { mkdirSync(runRoot, { mode: 0o700 }); } catch { return { ok: false, code: "workspace-unavailable" }; }

    const file: RunFileV1 = { v: 1, runId: run.runId, itemId: run.itemId, kind: "folder", ...(canonical !== undefined ? { projectRoot: canonical } : {}), stages: {}, joins: {}, out: {} };
    try {
      const project = canonical === undefined ? { inWorkTree: false } : await gitProject(canonical);
      if (canonical !== undefined && "baseCommit" in project) {
        const drivers = await git.drivers(canonical);
        // A filter the repository requires for checkout is never run, so such a repository gets no git workspace.
        if (drivers.requiredFilters.length > 0 && await usesFilter(canonical, drivers.requiredFilters)) throw new HostGitError("unavailable", "a required filter driver");
        const branch = runBranch(run.runId);
        await gitOut(canonical, ["worktree", "add", "-b", branch, join(runRoot, JOIN_DIR), project.baseCommit], { drivers: drivers.config });
        Object.assign(file, { kind: "git", branch, baseCommit: project.baseCommit });
        writeRunFile(runRoot, file);
        roots.set(run.runId, runRoot);
        return { ok: true, workspace: { kind: "git", runRoot, branch, baseCommit: project.baseCommit } };
      }
      if ("inWorkTree" in project && project.inWorkTree) file.ignoreRules = true;
      mkdirSync(join(runRoot, OUT_DIR), { mode: 0o700 });
      writeRunFile(runRoot, file);
      roots.set(run.runId, runRoot);
      return { ok: true, workspace: { kind: "folder", runRoot, outputDir: join(runRoot, OUT_DIR) } };
    } catch {
      if (canonical !== undefined) {
        await git.run(canonical, ["worktree", "prune"]).catch(() => undefined);
        rmSync(runRoot, { recursive: true, force: true });
        await git.run(canonical, ["worktree", "prune"]).catch(() => undefined);
        await git.run(canonical, ["branch", "-D", runBranch(run.runId)]).catch(() => undefined);
      } else rmSync(runRoot, { recursive: true, force: true });
      return { ok: false, code: canonical !== undefined ? "git-unavailable" : "workspace-unavailable" };
    }
  }

  async function removeStage(runRoot: string, file: RunFileV1, stageId: string): Promise<void> {
    const dir = join(runRoot, stageDirName(stageId));
    if (file.kind === "git" && file.projectRoot !== undefined && existsSync(dir)) {
      await git.run(file.projectRoot, ["worktree", "remove", "--force", dir]).catch(() => undefined);
    }
    if (existsSync(dir)) removeFolder(runRoot, dir);
    delete file.stages[stageId];
    writeRunFile(runRoot, file);
  }

  async function prepareGit(runRoot: string, file: RunFileV1, stage: TemplateStage, dir: string): Promise<Refusal | null> {
    const root = file.projectRoot;
    if (root === undefined || file.branch === undefined) return "workspace-unavailable";
    try {
      const drivers = await git.drivers(root);
      const head = (await gitOut(root, ["rev-parse", "--verify", `refs/heads/${file.branch}^{commit}`])).trim();
      await gitOut(root, ["worktree", "add", "--detach", dir, head], { drivers: drivers.config });
      // A tracked secret file is not handed to a stage.
      for (const path of nul(await gitOut(dir, ["ls-files", "-z"]))) {
        const target = join(dir, path);
        if (isInside(dir, target) && sensitive(target)) rmSync(target, { force: true });
      }
      const entry = file.stages[stage.id];
      if (entry) Object.assign(entry, { ready: true, base: head, link: readFileSync(join(dir, ".git"), "utf8") });
      writeRunFile(runRoot, file);
      return null;
    } catch {
      await removeStage(runRoot, file, stage.id).catch(() => undefined);
      await git.run(root, ["worktree", "prune"]).catch(() => undefined);
      return "git-unavailable";
    }
  }

  async function prepareFolder(runRoot: string, file: RunFileV1, stage: TemplateStage, dir: string): Promise<Refusal | null> {
    const inputs = stage.inputFiles ?? [];
    if (file.projectRoot === undefined && inputs.some(input => input.from === "project")) return "inputs-need-project";
    mkdirSync(dir, { mode: 0o700 });
    const seeded: Record<string, string> = {};
    let files = 0;
    let bytes = 0;
    const limits = options.seedLimits ?? { files: MAX_SEED_FILES, bytes: MAX_SEED_BYTES };
    try {
      for (const input of inputs) {
        let source: string;
        let paths: string[];
        if (input.from === "project") {
          source = file.projectRoot as string;
          const listed = await listSeedFiles(source, input.paths, seedRules(file, true));
          if (!listed.ok) return listed.code;
          paths = listed.files.map(entry => entry.path);
          files += listed.files.length;
          bytes += listed.files.reduce((sum, entry) => sum + entry.size, 0);
        } else {
          // That stage's collected files, as they are in the output folder now.
          source = join(runRoot, OUT_DIR);
          paths = Object.entries(file.out).filter(([, owner]) => owner.stageId === input.stageId).map(([path]) => path);
          files += paths.length;
          bytes += paths.reduce((sum, path) => sum + (file.out[path]?.size ?? 0), 0);
        }
        if (files > limits.files || bytes > limits.bytes) return "seed-too-large";
        for (const copied of await copySeedFiles(source, dir, runRoot, paths)) seeded[copied.path] = copied.sha256;
      }
    } catch {
      return "seed-unreadable";
    }
    const entry = file.stages[stage.id];
    if (entry) Object.assign(entry, { ready: true, seeded, outputs: stage.outputs ?? ["**"] });
    writeRunFile(runRoot, file);
    return null;
  }

  function prepare(run: RunRef, stage: TemplateStage, attempt: number): ReturnType<StageWorkspaceProvider["prepare"]> {
    return serial(run.runId, async () => {
      const found = locate(run);
      if (!found) return { ok: false as const, code: "workspace-unavailable" as const };
      const { runRoot, file } = found;
      // `_join`, `_out` and the run record are the host's; nothing but a stage id names a stage folder.
      if (!isStageId(stage.id)) return { ok: false as const, code: "workspace-unavailable" as const };
      const dir = join(runRoot, stageDirName(stage.id));
      const existing = file.stages[stage.id];
      if (existing?.ready === true && plainDirectory(dir)) {
        // The same folder again: a repeated call, or a rerun after `Request changes`.
        if (existing.attempt !== attempt) {
          Object.assign(existing, { attempt, sealed: false, manifest: undefined });
          writeRunFile(runRoot, file);
        }
        return { ok: true as const, workspace: { root: dir, kind: file.kind, ...(existing.base !== undefined ? { baseCommit: existing.base } : {}) } };
      }
      // A folder nobody recorded is not the provider's to replace.
      if (existing === undefined && existsSync(dir)) return { ok: false as const, code: "workspace-unavailable" as const };
      if (existing !== undefined) await removeStage(runRoot, file, stage.id);
      file.stages[stage.id] = { ready: false, attempt };
      writeRunFile(runRoot, file);
      const refused = file.kind === "git" ? await prepareGit(runRoot, file, stage, dir) : await prepareFolder(runRoot, file, stage, dir);
      if (refused !== null) {
        if (file.stages[stage.id] !== undefined) await removeStage(runRoot, file, stage.id).catch(() => undefined);
        return { ok: false as const, code: refused };
      }
      const base = file.stages[stage.id]?.base;
      return { ok: true as const, workspace: { root: dir, kind: file.kind, ...(base !== undefined ? { baseCommit: base } : {}) } };
    });
  }

  async function sealGit(run: RunRef, file: RunFileV1, stageId: string, entry: StageEntry, dir: string): Promise<{ ok: true; sealCommit?: string } | { ok: false; code: Refusal }> {
    const root = file.projectRoot;
    // The worktree link decides which repository the host's git writes to; a changed one is not followed.
    if (root === undefined || entry.base === undefined || readFileSync(join(dir, ".git"), "utf8") !== entry.link) return { ok: false, code: "workspace-unavailable" };
    if (!(await identityOf(root))) return { ok: false, code: "identity-missing" };
    const drivers = (await git.drivers(root)).config;
    await gitOut(dir, ["add", "-A"], { drivers });
    // A secret path never enters the commit, as a deletion (the host removed it) or as a new file.
    const staged = nul(await gitOut(dir, ["diff", "--cached", "--name-only", "-z", "--no-ext-diff", "--no-textconv", "--no-renames", "HEAD"], { drivers }));
    for (const paths of chunked(staged.filter(path => sensitive(join(dir, path))))) await gitOut(dir, ["reset", "-q", "HEAD", "--", ...paths], { drivers });
    const dirty = await git.run(dir, ["diff", "--cached", "--quiet", "--no-ext-diff", "--no-textconv", "HEAD"], { drivers });
    if (dirty.code !== 0) await gitOut(dir, ["commit", "-q", "--no-verify", "--no-gpg-sign", "-m", `Stage ${stageId}\n\n${trailers(run, stageId)}`], { drivers });
    const head = (await gitOut(dir, ["rev-parse", "--verify", "HEAD^{commit}"])).trim();
    return head === entry.base ? { ok: true } : { ok: true, sealCommit: head };
  }

  async function sealFolder(file: RunFileV1, entry: StageEntry, dir: string): Promise<{ ok: true } | { ok: false; code: Refusal }> {
    const listed = await listSeedFiles(dir, entry.outputs ?? ["**"], seedRules(file, false));
    if (!listed.ok) return listed;
    const manifest: OutputFile[] = [];
    for (const item of listed.files) manifest.push({ path: item.path, ...(await hashSeedFile(join(dir, item.path))) });
    entry.manifest = manifest;
    return { ok: true };
  }

  function seal(run: RunRef, stageId: string): ReturnType<StageWorkspaceProvider["seal"]> {
    return serial(run.runId, async () => {
      const found = locate(run);
      const entry = found?.file.stages[stageId];
      const dir = found ? join(found.runRoot, stageDirName(stageId)) : "";
      if (!found || entry?.ready !== true || !plainDirectory(dir)) return { ok: false as const, code: "workspace-unavailable" as const };
      // One seal per attempt: a repeated call returns it without another snapshot.
      if (entry.sealed === true) return { ok: true as const, ...(entry.sealCommit !== undefined ? { sealCommit: entry.sealCommit } : {}) };
      try {
        const sealed: { ok: true; sealCommit?: string } | { ok: false; code: Refusal } = found.file.kind === "git" ? await sealGit(run, found.file, stageId, entry, dir) : await sealFolder(found.file, entry, dir);
        if (!sealed.ok) return sealed;
        entry.sealed = true;
        if (sealed.sealCommit !== undefined) entry.sealCommit = sealed.sealCommit;
        writeRunFile(found.runRoot, found.file);
        return sealed;
      } catch {
        return { ok: false as const, code: "workspace-unavailable" as const };
      }
    });
  }

  const conflictOf = (run: RunRef, joinId: string, reason: JoinConflict["reason"], files: ConflictFile[], bound: unknown, excerpt?: string): { ok: false; conflict: JoinConflict } => ({
    ok: false,
    conflict: { conflictHash: resultHashOf(canonicalWorkflowJson({ runId: run.runId, joinId, reason, files, bound })), reason, files, ...(excerpt ? { excerpt } : {}) },
  });

  async function integrateGit(run: RunRef, runRoot: string, file: RunFileV1, joinId: string, stageIds: readonly string[]): ReturnType<StageWorkspaceProvider["integrate"]> {
    const root = file.projectRoot;
    const joinDir = join(runRoot, JOIN_DIR);
    if (root === undefined || !plainDirectory(joinDir)) throw new Error("the run has no integration worktree");
    const seals = Object.fromEntries(stageIds.map(stageId => [stageId, file.stages[stageId]?.sealCommit ?? null]));
    if (stageIds.some(stageId => file.stages[stageId]?.sealed !== true)) throw new Error("a stage of the join is not sealed");
    if (!(await identityOf(root))) return conflictOf(run, joinId, "identity-missing", [], seals);
    const drivers = (await git.drivers(root)).config;
    const merging = async (): Promise<boolean> => (await git.run(joinDir, ["rev-parse", "--verify", "--quiet", "MERGE_HEAD"])).code === 0;
    const unmerged = async (): Promise<string[]> => nul(await gitOut(joinDir, ["diff", "--name-only", "-z", "--diff-filter=U", "--no-ext-diff", "--no-textconv"], { drivers }));
    if (await merging()) {
      if (file.merging === undefined) {
        // The user is in the middle of resolving here; their work is left exactly as it is.
        return conflictOf(run, joinId, "merge-conflict", (await unmerged()).map(path => ({ path, stageIds: [...stageIds] })), seals, "a merge is still in progress in the integration folder");
      }
      await git.run(joinDir, ["merge", "--abort"], { drivers });
    }
    if (file.merging !== undefined) { delete file.merging; writeRunFile(runRoot, file); }
    for (const stageId of stageIds) {
      const sealCommit = file.stages[stageId]?.sealCommit;
      if (sealCommit === undefined) continue;
      // Already on the run branch: an earlier call merged it, or the user did while resolving.
      if ((await git.run(joinDir, ["merge-base", "--is-ancestor", sealCommit, "HEAD"])).code === 0) continue;
      file.merging = sealCommit;
      writeRunFile(runRoot, file);
      const merged = await git.run(joinDir, ["merge", "--no-edit", "--no-stat", "--no-verify", "--no-gpg-sign", "-m", `Collect stage ${stageId}\n\n${trailers(run, stageId)}`, sealCommit], { drivers });
      if (merged.code !== 0) {
        const paths = await unmerged().catch(() => []);
        const files: ConflictFile[] = [];
        for (const path of paths) {
          const touched = [stageId];
          for (const other of stageIds) {
            const entry = file.stages[other];
            if (other === stageId || entry?.sealCommit === undefined || entry.base === undefined) continue;
            const changed = await git.run(joinDir, ["diff", "--quiet", "--no-ext-diff", "--no-textconv", entry.base, entry.sealCommit, "--", path], { drivers });
            if (changed.code === 1) touched.push(other);
          }
          files.push({ path, stageIds: stageIds.filter(id => touched.includes(id)) });
        }
        if (await merging()) await git.run(joinDir, ["merge", "--abort"], { drivers });
        delete file.merging;
        writeRunFile(runRoot, file);
        const said = (merged.stderr.trim() || merged.stdout.trim()).split(/\r?\n/u)[0]?.slice(0, 300);
        return conflictOf(run, joinId, "merge-conflict", files, seals, files.length === 0 ? said : undefined);
      }
      delete file.merging;
      writeRunFile(runRoot, file);
    }
    return { ok: true };
  }

  async function integrateFolder(run: RunRef, runRoot: string, file: RunFileV1, joinId: string, stageIds: readonly string[]): ReturnType<StageWorkspaceProvider["integrate"]> {
    if (file.joins[joinId] === true) return { ok: true };
    if (stageIds.some(stageId => file.stages[stageId]?.sealed !== true)) throw new Error("a stage of the join is not sealed");
    const outDir = join(runRoot, OUT_DIR);
    if (!plainDirectory(outDir)) throw new Error("the run has no output folder");
    const next = new Map(Object.entries(file.out));
    const contested = new Map<string, Set<string>>();
    const copies: { stageId: string; path: string; sha256: string; size: number }[] = [];
    for (const stageId of stageIds) {
      const entry = file.stages[stageId] as StageEntry;
      for (const item of entry.manifest ?? []) {
        const held = next.get(item.path);
        if (held === undefined || held.sha256 === item.sha256) {
          if (held === undefined) { next.set(item.path, { sha256: item.sha256, size: item.size, stageId }); copies.push({ stageId, ...item }); }
          continue;
        }
        // A stage may replace exactly the content it was seeded with; any other difference is two answers for one path.
        if (!stageIds.includes(held.stageId) && entry.seeded?.[item.path] === held.sha256) {
          next.set(item.path, { sha256: item.sha256, size: item.size, stageId });
          copies.push({ stageId, ...item });
          continue;
        }
        const stages = contested.get(item.path) ?? new Set([held.stageId]);
        stages.add(stageId);
        contested.set(item.path, stages);
      }
    }
    const files: ConflictFile[] = [];
    for (const [path, stages] of [...contested].sort(([a], [b]) => a < b ? -1 : 1)) {
      // A file the user put at the contested path is the resolution: it stays, and no stage's copy replaces it.
      const placed = join(outDir, path);
      const onDisk = lstatSync(placed, { throwIfNoEntry: false })?.isFile() === true ? await hashSeedFile(placed) : undefined;
      const recorded = file.out[path]?.sha256;
      if (onDisk !== undefined && onDisk.sha256 !== recorded) next.set(path, { ...onDisk, stageId: [...stages].at(-1) as string });
      else files.push({ path, stageIds: [...stages] });
    }
    if (files.length > 0) return conflictOf(run, joinId, "same-path", files, Object.fromEntries(stageIds.map(id => [id, file.stages[id]?.manifest ?? []])));
    const wanted: typeof copies = [];
    // Checked before anything is written: each sealed file is still what was sealed, and a file the host did not put in the output folder stays.
    for (const copy of copies) {
      if (contested.has(copy.path)) continue;
      if ((await hashSeedFile(join(runRoot, stageDirName(copy.stageId), copy.path))).sha256 !== copy.sha256) throw new Error("a sealed stage file changed before it was collected");
      const target = join(outDir, copy.path);
      const there = lstatSync(target, { throwIfNoEntry: false })?.isFile() === true ? await hashSeedFile(target) : undefined;
      if (there !== undefined && there.sha256 !== copy.sha256 && there.sha256 !== file.out[copy.path]?.sha256) next.set(copy.path, { ...there, stageId: copy.stageId });
      else wanted.push(copy);
    }
    for (const copy of wanted) await copySeedFiles(join(runRoot, stageDirName(copy.stageId)), outDir, runRoot, [copy.path]);
    file.out = Object.fromEntries(next);
    file.joins[joinId] = true;
    writeRunFile(runRoot, file);
    return { ok: true };
  }

  function integrate(run: RunRef, joinId: string, stageIds: readonly string[]): ReturnType<StageWorkspaceProvider["integrate"]> {
    return serial(run.runId, async () => {
      const found = locate(run);
      if (!found) throw new Error("the run has no workspace");
      return found.file.kind === "git" ? integrateGit(run, found.runRoot, found.file, joinId, stageIds) : integrateFolder(run, found.runRoot, found.file, joinId, stageIds);
    });
  }

  /** Stage folders, and for "all" the integration worktree and the record; the run branch stays, and so does the output folder with
   * its record unless `output` is "drop". */
  async function releaseIn(runRoot: string, file: RunFileV1, stageIds: readonly string[] | "all", output: "keep" | "drop" = "keep"): Promise<void> {
    for (const stageId of stageIds === "all" ? Object.keys(file.stages) : stageIds) {
      if (file.stages[stageId] !== undefined) await removeStage(runRoot, file, stageId);
    }
    if (stageIds !== "all") return;
    const root = file.projectRoot;
    if (file.kind === "git" && root !== undefined && file.branch !== undefined && file.baseCommit !== undefined) {
      const joinDir = join(runRoot, JOIN_DIR);
      if (existsSync(joinDir)) {
        await git.run(root, ["worktree", "remove", "--force", joinDir]).catch(() => undefined);
        if (existsSync(joinDir)) removeFolder(runRoot, joinDir);
      }
      await git.run(root, ["worktree", "prune"]).catch(() => undefined);
      // The branch is the run's result; it goes only when nothing was collected onto it.
      await git.run(root, ["update-ref", "-d", `refs/heads/${file.branch}`, file.baseCommit]).catch(() => undefined);
    }
    if (file.kind === "folder" && existsSync(join(runRoot, OUT_DIR))) {
      if (output === "keep") return;
      removeFolder(runRoot, join(runRoot, OUT_DIR));
    }
    rmSync(join(runRoot, RUN_FILE), { force: true });
    // Only empty folders go from here on.
    for (const folder of [runRoot, dirname(runRoot)]) {
      try { if (readdirSync(folder).length === 0) rmdirSync(folder); else break; } catch { break; }
    }
  }

  function release(run: RunRef, stageIds: readonly string[] | "all"): Promise<void> {
    return serial(run.runId, async () => {
      const found = locate(run);
      if (!found) return;
      await releaseIn(found.runRoot, found.file, stageIds);
      if (stageIds === "all") roots.delete(run.runId);
    });
  }

  /** Every run folder that holds its own record. A folder without one was not made by a run the host can name; it is left alone. */
  function recordedRuns(): { runRoot: string; file: RunFileV1 }[] {
    const base = worktreesRoot();
    if (!plainDirectory(base)) return [];
    const found: { runRoot: string; file: RunFileV1 }[] = [];
    for (const project of readdirSync(base)) {
      if (!plainDirectory(join(base, project))) continue;
      for (const slug of readdirSync(join(base, project))) {
        const runRoot = join(base, project, slug);
        if (!plainDirectory(runRoot)) continue;
        const file = readRunFile(runRoot);
        if (file !== null && runSlug(file.runId) === slug && Number.isInteger(file.itemId)) found.push({ runRoot, file });
      }
    }
    return found;
  }

  async function discard(): Promise<void> {
    const removable = await options.removable?.();
    if (removable === undefined) return;
    for (const { runRoot, file } of recordedRuns()) {
      if (!removable({ runId: file.runId, itemId: file.itemId })) continue;
      await serial(file.runId, async () => {
        const current = readRunFile(runRoot);
        if (current?.runId === file.runId) await releaseIn(runRoot, current, "all", "drop");
      });
      roots.delete(file.runId);
    }
  }

  async function sweep(activeRunIds: readonly string[]): Promise<void> {
    const active = new Set(activeRunIds.map(runSlug));
    // What a stop between a record's removal and the discard left behind goes here; an answer that could not be had keeps it.
    const removable = await options.removable?.().catch(() => undefined);
    for (const { runRoot, file } of recordedRuns()) {
      if (active.has(runSlug(file.runId))) continue;
      const output = removable?.({ runId: file.runId, itemId: file.itemId }) === true ? "drop" : "keep";
      await serial(file.runId, () => releaseIn(runRoot, file, "all", output)).catch(() => undefined);
      roots.delete(file.runId);
    }
  }

  return { open, prepare, seal, integrate, release, discard, sweep };
}
