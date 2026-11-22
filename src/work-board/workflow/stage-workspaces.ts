import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createLogger } from "../../lib/logger.js";
import { isSensitivePath } from "../../permissions/sensitive-paths.js";
import { aveHome, getAveHomePrivacyFailure, isAveHomeBoundaryUnverifiedAtBoot } from "../../shared/ave-home.js";
import { canonicalWorkflowJson, resultHashOf } from "../../shared/workflow-template-output.js";
import type { RunWorkspace, TemplateStage } from "../../shared/workflow-template-types.js";
import { isStageId } from "../template-graph.js";
import { plainFolderIgnore } from "./folder-ignore.js";
import { createHostGit, type HostGit, HostGitError } from "./host-git.js";
import type { JoinConflict } from "./shipped-shapes.js";
import type { RunRef, StageWorkspaceProvider, WORKSPACE_REFUSALS } from "./stage-workspace.js";
import { isIgnoreFolder, JOIN_DIR, OUT_DIR, RUN_FILE, runBranch, runRootOf, runSlug, stageDirName, WORKTREES_DIR } from "./workspace-layout.js";
import { copySeedFiles, hashSeedFile, isInside, listSeedFiles, MAX_SEED_BYTES, MAX_SEED_FILES, type SeedRules } from "./workspace-seed.js";

const log = createLogger("work-board-stage-workspace");

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

/** A run folder as one call holds it: its record, and which directories `<worktrees>/<project>/<run>` were when it was read. */
interface Held { runRoot: string; file: RunFileV1; identity: string }

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
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
/** Every field a later call relies on, so a partial or foreign file is no record. */
function isRunFile(value: unknown): value is RunFileV1 {
  if (!isObject(value) || value.v !== 1 || typeof value.runId !== "string" || value.runId === "" || !Number.isInteger(value.itemId)) return false;
  if (value.kind !== "git" && value.kind !== "folder") return false;
  const text = [value.projectRoot, value.branch, value.baseCommit, value.merging];
  if (text.some(field => field !== undefined && typeof field !== "string") || (value.ignoreRules !== undefined && typeof value.ignoreRules !== "boolean")) return false;
  if (value.kind === "git" && text.slice(0, 3).includes(undefined)) return false;
  if (!isObject(value.stages) || !isObject(value.joins) || !isObject(value.out)) return false;
  return Object.entries(value.stages).every(([id, entry]) => isStageId(id) && isObject(entry) && typeof entry.ready === "boolean" && Number.isInteger(entry.attempt));
}
const NUL = "\0";
const nul = (text: string): string[] => text.split(NUL).filter(entry => entry !== "");
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

  /** Device and file ids of nested folders, outermost first. Null when one is no real directory (a link or junction is none). */
  function directoryIds(levels: readonly string[]): string | null {
    const ids: string[] = [];
    for (const level of levels) {
      const stat = lstatSync(level, { bigint: true, throwIfNoEntry: false });
      if (stat === undefined || !stat.isDirectory() || stat.isSymbolicLink()) return null;
      ids.push(`${stat.dev}:${stat.ino}`);
    }
    return ids.join("/");
  }

  /** The home and the three levels of a run folder beneath it. Null too when the folder is not two levels below the home's `worktrees`. */
  function folderIdentity(runRoot: string): string | null {
    const project = dirname(runRoot);
    return samePath(dirname(project), worktreesRoot()) ? directoryIds([aveHome(), dirname(project), project, runRoot]) : null;
  }

  /**
   * Before each removal, creation or write, however long ago the folder was read: every level is still the directory it was. The check
   * and the operation are two system calls on a path, so another process of the same user could still swap a level between them. That is
   * outside what the host defends against (the owner's decision of 2026-11-21 on cleanup: a swap during the operation is out of scope,
   * since whoever can win it already acts as the same user), and git is never given such a path to delete through.
   */
  function assertHeld(at: Pick<Held, "runRoot" | "identity">): void {
    if (folderIdentity(at.runRoot) !== at.identity) throw new Error("the run folder is no longer the one that was read");
  }

  /** A record belongs to the one folder `open` makes for its run, item and project, and a git record names the run's own branch from a
   * commit. A record copied or restored anywhere else, or naming another branch, is no record: it directs no cleanup. */
  function ownsFolder(runRoot: string, file: RunFileV1): boolean {
    const root = file.projectRoot;
    if (root !== undefined && !isAbsolute(root)) return false;
    if (file.kind === "git" && (root === undefined || file.branch !== runBranch(file.runId) || !OBJECT_ID.test(file.baseCommit ?? ""))) return false;
    return samePath(runRoot, runRootOf(aveHome(), root === undefined ? undefined : process.platform === "win32" ? root.toLowerCase() : root, file.itemId, file.runId));
  }

  function readRunFile(runRoot: string): RunFileV1 | null {
    const path = join(runRoot, RUN_FILE);
    try {
      // A link, or a file that has a second name, is not the record the host wrote here.
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.nlink !== 1) return null;
      const file: unknown = JSON.parse(readFileSync(path, "utf8"));
      return isRunFile(file) && ownsFolder(runRoot, file) ? file : null;
    } catch {
      return null;
    }
  }

  function writeRunFile(at: Pick<Held, "runRoot" | "identity">, file: RunFileV1): void {
    assertHeld(at);
    const target = join(at.runRoot, RUN_FILE);
    writeFileSync(`${target}.tmp`, JSON.stringify(file), { mode: 0o600 });
    renameSync(`${target}.tmp`, target);
  }

  /** The run's folder and record, found again after a restart by the run's slug. */
  function locate(run: Pick<RunRef, "runId">): Held | null {
    const slug = runSlug(run.runId);
    const known = roots.get(run.runId);
    const candidates = known !== undefined ? [known]
      : plainDirectory(worktreesRoot()) ? readdirSync(worktreesRoot()).map(project => join(worktreesRoot(), project, slug)) : [];
    for (const runRoot of candidates) {
      const identity = folderIdentity(runRoot);
      const file = identity === null ? null : readRunFile(runRoot);
      if (identity === null || file?.runId !== run.runId) continue;
      roots.set(run.runId, runRoot);
      return { runRoot, file, identity };
    }
    return null;
  }

  /** Removes one folder the provider made, directly under a run root the call holds. Anything else is refused, and so is every removal
   * once a level above it is no longer the directory it was. */
  function removeFolder(at: Pick<Held, "runRoot" | "identity">, target: string): void {
    if (!isInside(at.runRoot, target) || !samePath(dirname(target), at.runRoot)) throw new Error("refusing to remove a path outside the run root");
    assertHeld(at);
    rmSync(target, { recursive: true, force: true, maxRetries: 3 });
  }

  /** What a stop while a stage folder was seeded left of the ignore matcher. */
  function clearIgnoreFolders(at: Held): void {
    assertHeld(at);
    for (const name of readdirSync(at.runRoot)) if (isIgnoreFolder(name)) removeFolder(at, join(at.runRoot, name));
  }

  /**
   * Lets the repository forget the worktrees of this run whose folders the host removed. Git removes no folder for the host: a path it
   * were given could be another folder by the time git opens it. Its prune drops every registration whose folder is missing, so it runs
   * only when each of those lies in this run's folder; with another one missing too, the run's registrations stay for a later prune.
   */
  async function forgetWorktrees(root: string, runRoot: string): Promise<void> {
    const listed = await git.run(root, ["worktree", "list", "--porcelain", "-z"]).catch(() => undefined);
    if (listed === undefined || listed.code !== 0) return;
    const missing = listed.stdout.split(NUL + NUL).map(entry => entry.split(NUL))
      .filter(lines => lines.some(line => line === "prunable" || line.startsWith("prunable ")))
      .map(lines => lines.find(line => line.startsWith("worktree "))?.slice("worktree ".length));
    if (missing.length === 0) return;
    if (missing.some(path => path === undefined || !isInside(runRoot, resolve(path)))) {
      log.warn("a run's worktree registrations stay: the repository has others whose folders are missing");
      return;
    }
    await git.run(root, ["worktree", "prune"]).catch(() => undefined);
  }

  async function gitOut(cwd: string, args: readonly string[], call?: Parameters<HostGit["run"]>[2]): Promise<string> {
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

  const seedRules = (ignored?: SeedRules["ignored"]): SeedRules => {
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
    const identity = folderIdentity(runRoot);
    if (identity === null) return { ok: false, code: "home-boundary-unverified" };
    const at = { runRoot, identity };
    let gitKind = false;
    /** The commit the run's branch was asked to start from, once this call is the one that makes it. */
    let branchFrom: string | undefined;

    const file: RunFileV1 = { v: 1, runId: run.runId, itemId: run.itemId, kind: "folder", ...(canonical !== undefined ? { projectRoot: canonical } : {}), stages: {}, joins: {}, out: {} };
    try {
      const project = canonical === undefined ? { inWorkTree: false } : await gitProject(canonical);
      if (canonical !== undefined && "baseCommit" in project) {
        gitKind = true;
        const drivers = await git.drivers(canonical);
        // A filter the repository requires for checkout is never run, so such a repository gets no git workspace.
        if (drivers.requiredFilters.length > 0 && await usesFilter(canonical, drivers.requiredFilters)) throw new HostGitError("unavailable", "a required filter driver");
        const branch = runBranch(run.runId);
        // A branch of that name that is already there is not this run's: it is neither used nor, below, removed.
        if ((await git.run(canonical, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])).code !== 1) throw new HostGitError("unavailable", "the run's branch is taken");
        assertHeld(at);
        branchFrom = project.baseCommit;
        await gitOut(canonical, ["worktree", "add", "-b", branch, join(runRoot, JOIN_DIR), project.baseCommit], { drivers: drivers.config });
        Object.assign(file, { kind: "git", branch, baseCommit: project.baseCommit });
        writeRunFile(at, file);
        roots.set(run.runId, runRoot);
        return { ok: true, workspace: { kind: "git", runRoot, branch, baseCommit: project.baseCommit } };
      }
      if ("inWorkTree" in project && project.inWorkTree) file.ignoreRules = true;
      assertHeld(at);
      mkdirSync(join(runRoot, OUT_DIR), { mode: 0o700 });
      writeRunFile(at, file);
      roots.set(run.runId, runRoot);
      return { ok: true, workspace: { kind: "folder", runRoot, outputDir: join(runRoot, OUT_DIR) } };
    } catch {
      // The folder this call made goes only while it is still that folder; a plain folder's project sees no git call here.
      const discardRoot = (): void => { if (folderIdentity(runRoot) === identity) rmSync(runRoot, { recursive: true, force: true }); };
      if (canonical !== undefined && gitKind) {
        discardRoot();
        await forgetWorktrees(canonical, runRoot);
        // Only the branch this call made, and only while it is still where it was made.
        if (branchFrom !== undefined) await git.run(canonical, ["update-ref", "-d", `refs/heads/${runBranch(run.runId)}`, branchFrom]).catch(() => undefined);
      } else discardRoot();
      return { ok: false, code: canonical !== undefined ? "git-unavailable" : "workspace-unavailable" };
    }
  }

  async function removeStage(at: Held, stageId: string): Promise<void> {
    const { runRoot, file } = at;
    const dir = join(runRoot, stageDirName(stageId));
    if (lstatSync(dir, { throwIfNoEntry: false }) !== undefined) {
      removeFolder(at, dir);
      if (file.kind === "git" && file.projectRoot !== undefined) await forgetWorktrees(file.projectRoot, runRoot);
    }
    delete file.stages[stageId];
    writeRunFile(at, file);
  }

  async function prepareGit(at: Held, stage: TemplateStage, dir: string): Promise<Refusal | null> {
    const { file } = at;
    const root = file.projectRoot;
    if (root === undefined || file.branch === undefined) return "workspace-unavailable";
    try {
      const drivers = await git.drivers(root);
      const head = (await gitOut(root, ["rev-parse", "--verify", `refs/heads/${file.branch}^{commit}`])).trim();
      assertHeld(at);
      await gitOut(root, ["worktree", "add", "--detach", dir, head], { drivers: drivers.config });
      assertHeld(at);
      // A tracked secret file is not handed to a stage.
      for (const path of nul(await gitOut(dir, ["ls-files", "-z"]))) {
        const target = join(dir, path);
        if (isInside(dir, target) && sensitive(target)) rmSync(target, { force: true });
      }
      const entry = file.stages[stage.id];
      if (entry) Object.assign(entry, { ready: true, base: head, link: readFileSync(join(dir, ".git"), "utf8") });
      writeRunFile(at, file);
      return null;
    } catch {
      await removeStage(at, stage.id).catch(() => undefined);
      await forgetWorktrees(root, at.runRoot);
      return "git-unavailable";
    }
  }

  async function prepareFolder(at: Held, stage: TemplateStage, dir: string): Promise<Refusal | null> {
    const { runRoot, file } = at;
    const inputs = stage.inputFiles ?? [];
    if (file.projectRoot === undefined && inputs.some(input => input.from === "project")) return "inputs-need-project";
    assertHeld(at);
    mkdirSync(dir, { mode: 0o700 });
    const seeded: Record<string, string> = {};
    let files = 0;
    let bytes = 0;
    const limits = options.seedLimits ?? { files: MAX_SEED_FILES, bytes: MAX_SEED_BYTES };
    const plain = file.projectRoot !== undefined && file.ignoreRules !== true ? plainFolderIgnore(git, runRoot, file.projectRoot, { check: () => assertHeld(at), remove: scratch => removeFolder(at, scratch) }) : undefined;
    try {
      for (const input of inputs) {
        let source: string;
        let paths: string[];
        if (input.from === "project") {
          source = file.projectRoot as string;
          const listed = await listSeedFiles(source, input.paths, seedRules(plain?.ignored ?? ignoreRulesOf(file)));
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
        assertHeld(at);
        for (const copied of await copySeedFiles(source, dir, runRoot, paths)) seeded[copied.path] = copied.sha256;
      }
    } catch {
      return "seed-unreadable";
    } finally {
      plain?.done();
    }
    const entry = file.stages[stage.id];
    if (entry) Object.assign(entry, { ready: true, seeded, outputs: stage.outputs ?? ["**"] });
    writeRunFile(at, file);
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
          writeRunFile(found, file);
        }
        return { ok: true as const, workspace: { root: dir, kind: file.kind, ...(existing.base !== undefined ? { baseCommit: existing.base } : {}) } };
      }
      // A folder nobody recorded is not the provider's to replace.
      if (existing === undefined && existsSync(dir)) return { ok: false as const, code: "workspace-unavailable" as const };
      if (existing !== undefined) await removeStage(found, stage.id);
      file.stages[stage.id] = { ready: false, attempt };
      writeRunFile(found, file);
      const refused = file.kind === "git" ? await prepareGit(found, stage, dir) : await prepareFolder(found, stage, dir);
      if (refused !== null) {
        if (file.stages[stage.id] !== undefined) await removeStage(found, stage.id).catch(() => undefined);
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

  async function sealFolder(entry: StageEntry, dir: string): Promise<{ ok: true } | { ok: false; code: Refusal }> {
    const listed = await listSeedFiles(dir, entry.outputs ?? ["**"], seedRules());
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
        const sealed: { ok: true; sealCommit?: string } | { ok: false; code: Refusal } = found.file.kind === "git" ? await sealGit(run, found.file, stageId, entry, dir) : await sealFolder(entry, dir);
        if (!sealed.ok) return sealed;
        entry.sealed = true;
        if (sealed.sealCommit !== undefined) entry.sealCommit = sealed.sealCommit;
        writeRunFile(found, found.file);
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

  async function integrateGit(run: RunRef, at: Held, joinId: string, stageIds: readonly string[]): ReturnType<StageWorkspaceProvider["integrate"]> {
    const { runRoot, file } = at;
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
    if (file.merging !== undefined) { delete file.merging; writeRunFile(at, file); }
    for (const stageId of stageIds) {
      const sealCommit = file.stages[stageId]?.sealCommit;
      if (sealCommit === undefined) continue;
      // Already on the run branch: an earlier call merged it, or the user did while resolving.
      if ((await git.run(joinDir, ["merge-base", "--is-ancestor", sealCommit, "HEAD"])).code === 0) continue;
      file.merging = sealCommit;
      writeRunFile(at, file);
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
        writeRunFile(at, file);
        const said = (merged.stderr.trim() || merged.stdout.trim()).split(/\r?\n/u)[0]?.slice(0, 300);
        return conflictOf(run, joinId, "merge-conflict", files, seals, files.length === 0 ? said : undefined);
      }
      delete file.merging;
      writeRunFile(at, file);
    }
    return { ok: true };
  }

  async function integrateFolder(run: RunRef, at: Held, joinId: string, stageIds: readonly string[]): ReturnType<StageWorkspaceProvider["integrate"]> {
    const { runRoot, file } = at;
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
    for (const copy of wanted) {
      assertHeld(at);
      await copySeedFiles(join(runRoot, stageDirName(copy.stageId)), outDir, runRoot, [copy.path]);
    }
    file.out = Object.fromEntries(next);
    file.joins[joinId] = true;
    writeRunFile(at, file);
    return { ok: true };
  }

  function integrate(run: RunRef, joinId: string, stageIds: readonly string[]): ReturnType<StageWorkspaceProvider["integrate"]> {
    return serial(run.runId, async () => {
      const found = locate(run);
      if (!found) throw new Error("the run has no workspace");
      return found.file.kind === "git" ? integrateGit(run, found, joinId, stageIds) : integrateFolder(run, found, joinId, stageIds);
    });
  }

  /** Stage folders, and for "all" the integration worktree and the record; the run branch stays, and so does the output folder with
   * its record unless `output` is "drop". */
  async function releaseIn(at: Held, stageIds: readonly string[] | "all", output: "keep" | "drop" = "keep"): Promise<void> {
    const { runRoot, file } = at;
    for (const stageId of stageIds === "all" ? Object.keys(file.stages) : stageIds) {
      if (file.stages[stageId] !== undefined) await removeStage(at, stageId);
    }
    if (stageIds !== "all") return;
    clearIgnoreFolders(at);
    const root = file.projectRoot;
    if (file.kind === "git" && root !== undefined && file.branch !== undefined && file.baseCommit !== undefined) {
      const joinDir = join(runRoot, JOIN_DIR);
      if (lstatSync(joinDir, { throwIfNoEntry: false }) !== undefined) removeFolder(at, joinDir);
      await forgetWorktrees(root, runRoot);
      // The branch is the run's result; it goes only when nothing was collected onto it.
      await git.run(root, ["update-ref", "-d", `refs/heads/${runBranch(file.runId)}`, file.baseCommit]).catch(() => undefined);
    }
    if (file.kind === "folder" && existsSync(join(runRoot, OUT_DIR))) {
      if (output === "keep") return;
      removeFolder(at, join(runRoot, OUT_DIR));
    }
    assertHeld(at);
    rmSync(join(runRoot, RUN_FILE), { force: true });
    // Only empty folders go from here on: the run folder, then the project folder while the levels above it are still the same.
    try {
      assertHeld(at);
      if (readdirSync(runRoot).length > 0) return;
      rmdirSync(runRoot);
      const project = dirname(runRoot);
      const above = at.identity.slice(0, at.identity.lastIndexOf("/"));
      if (directoryIds([aveHome(), dirname(project), project]) === above && readdirSync(project).length === 0) rmdirSync(project);
    } catch { /* what could not go stays */ }
  }

  function release(run: RunRef, stageIds: readonly string[] | "all"): Promise<void> {
    return serial(run.runId, async () => {
      const found = locate(run);
      if (!found) return;
      await releaseIn(found, stageIds);
      if (stageIds === "all") roots.delete(run.runId);
    });
  }

  /** Every run folder that holds its own record. A folder without one was not made by a run the host can name; it is left alone. */
  function recordedRuns(): Held[] {
    const base = worktreesRoot();
    if (!plainDirectory(base)) return [];
    const found: Held[] = [];
    for (const project of readdirSync(base)) {
      if (!plainDirectory(join(base, project))) continue;
      for (const slug of readdirSync(join(base, project))) {
        const runRoot = join(base, project, slug);
        const identity = folderIdentity(runRoot);
        const file = identity === null ? null : readRunFile(runRoot);
        if (identity !== null && file !== null && runSlug(file.runId) === slug) found.push({ runRoot, file, identity });
      }
    }
    return found;
  }

  /** Inside the run's queue, a run folder seen earlier: the same directories holding the same run's record, as it reads now. Null for any
   * other, which is then left as it is. */
  function heldStill(seen: Held): Held | null {
    if (folderIdentity(seen.runRoot) !== seen.identity) return null;
    const file = readRunFile(seen.runRoot);
    const same = file !== null && (["runId", "itemId", "kind", "projectRoot"] as const).every(field => file[field] === seen.file[field]);
    return same ? { ...seen, file } : null;
  }

  /** Whether the stores let the run's output go, read now. A start publishes its folder before it stores its record, so only a read
   * begun after the folder was listed, with the run's queue held, decides: by then the run's row is on the board. */
  async function removableNow(run: { runId: string; itemId: number }): Promise<boolean> {
    return (await options.removable?.())?.(run) === true;
  }

  async function discard(): Promise<void> {
    // A first selection only, so that the stores are read again for the few runs it names and not for every folder.
    const selected = await options.removable?.();
    if (selected === undefined) return;
    for (const seen of recordedRuns()) {
      const { runId, itemId } = seen.file;
      if (!selected({ runId, itemId })) continue;
      await serial(runId, async () => {
        if (!(await removableNow({ runId, itemId }))) return;
        const current = heldStill(seen);
        if (current !== null) await releaseIn(current, "all", "drop");
      });
      roots.delete(runId);
    }
  }

  async function sweep(activeRunIds: readonly string[]): Promise<void> {
    const active = new Set(activeRunIds.map(runSlug));
    // What a stop between a record's removal and the discard left behind goes here; an answer that could not be had keeps it.
    const selected = await options.removable?.().catch(() => undefined);
    for (const seen of recordedRuns()) {
      const { runId, itemId } = seen.file;
      if (active.has(runSlug(runId))) {
        // A run that goes on keeps its stages and its output; what a stop during a seeding left of the ignore matcher still goes.
        await serial(runId, async () => {
          const current = heldStill(seen);
          if (current !== null) clearIgnoreFolders(current);
        }).catch((error: unknown) => log.warn("an ignore matcher's folder was not removed: %s", (error as Error).message));
        continue;
      }
      await serial(runId, async () => {
        const output = selected?.({ runId, itemId }) === true && await removableNow({ runId, itemId }).catch(() => false) ? "drop" : "keep";
        const current = heldStill(seen);
        if (current !== null) await releaseIn(current, "all", output);
      }).catch(() => undefined);
      roots.delete(runId);
    }
  }

  return { open, prepare, seal, integrate, release, discard, sweep };
}
