import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { createLogger } from "../../lib/logger.js";
import { isSensitivePath } from "../../permissions/sensitive-paths.js";
import { aveHome, getAveHomePrivacyFailure, isAveHomeBoundaryUnverifiedAtBoot } from "../../shared/ave-home.js";
import { canonicalWorkflowJson, resultHashOf } from "../../shared/workflow-template-output.js";
import type { TemplateStage } from "../../shared/workflow-template-types.js";
import { isStageId } from "../template-graph.js";
import { type NameReader, plainFolderIgnore, projectFoldsCase } from "./folder-ignore.js";
import { createHostGit, type HostGit, HostGitError } from "./host-git.js";
import { holdDir, isFileAt, type NodeId, nodeIdOf, type OwnedDir, OwnedFsError, realDirId, realWithin, type SourceRoot } from "./owned-fs.js";
import type { JoinConflict } from "./shipped-shapes.js";
import type { RemovedRunProject, RunRef, StageWorkspaceProvider, WORKSPACE_REFUSALS } from "./stage-workspace.js";
import { IGNORE_PREFIX, isIgnoreFolder, JOIN_DIR, OUT_DIR, RUN_FILE, runBranch, runRootOf, runSlug, stageDirName, WORKTREES_DIR } from "./workspace-layout.js";
import { isRecordFilePath, isWorkspaceRecord, type LiveRepo, type OutputFile, ownerOf, recordFits, type Registration, runFolderOf, type StageEntry, samePath, vetRecordPath, type WorkspaceRecord } from "./workspace-record.js";
import { copySeedFiles, hashSeedFile, listSeedFiles, MAX_SEED_BYTES, MAX_SEED_FILES, type SeedRules } from "./workspace-seed.js";

const log = createLogger("work-board-stage-workspace");

type Refusal = typeof WORKSPACE_REFUSALS[number];
type ConflictFile = JoinConflict["files"][number];
/** A run folder as one call holds it: its record, and the directories `<worktrees>/<project>/<run>` as they were when it was read.
 * `live` is the project the caller has open, there only while the record's path for its project is that one by text; its `gitDir` is
 * there once this call asked git in it and found the repository the record names. */
interface Held { runRoot: string; file: WorkspaceRecord; project: OwnedDir; run: OwnedDir; live?: LiveRepo }
/** A field of a record that no longer names what is there: of the run folder itself (`host`), or of the project and its repository
 * (`repo`); or a path of the record that is not the open project's by text, of which nothing was asked (`unverified`). */
interface Mismatch { field: string; side: "host" | "repo" | "unverified" }

export interface StageWorkspaceOptions {
  git?: HostGit;
  /** The secret-file test; the default is the permission layer's own. */
  sensitive?: (absolutePath: string) => boolean;
  seedLimits?: { files: number; bytes: number };
  /** Which runs may lose their output folder: those with no record whose item is gone, as the stores are now. With none, or an
   * answer of undefined, nothing is discarded. */
  removable?: () => Promise<((run: { runId: string; itemId: number }) => boolean) | undefined>;
  /** How a folder's names and their identities are read when a plain project's case rule is asked for; the default reads the disk. */
  nameReader?: NameReader;
}

/** The mismatches already reported in this process, by run folder. */
const warnedOnce = new Set<string>();
/** Git writes the two files that tie a worktree to its registration as absolute paths, whatever the repository is configured to. */
const ABSOLUTE_LINKS = ["-c", "worktree.useRelativePaths=false"];
/** Before every commit or ref in an argument vector: git reads what follows as one, never as an option. */
const END_OF_OPTIONS = "--end-of-options";
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

  /** The project and run levels of a run folder, held from the home down; null when one is no real directory, or the folder is not two
   * levels below the home's `worktrees`. */
  function chainOf(runRoot: string): Pick<Held, "project" | "run"> | null {
    const projectPath = dirname(runRoot);
    if (!samePath(dirname(projectPath), worktreesRoot())) return null;
    try {
      const project = holdDir(aveHome()).existing(WORKTREES_DIR)?.existing(basename(projectPath));
      const run = project?.existing(basename(runRoot));
      return project !== undefined && run !== undefined ? { project, run } : null;
    } catch {
      return null;
    }
  }

  /** The record `open` wrote into this folder, or null: a file of another shape or version, a link, a file that has a second name, or a
   * record that does not name this very folder as its own directs nothing. */
  function readRunFile(runRoot: string, run: OwnedDir): WorkspaceRecord | null {
    try {
      const text = run.readFile(RUN_FILE);
      if (text === undefined) return null;
      const file: unknown = JSON.parse(text.toString("utf8"));
      return isWorkspaceRecord(file) && recordFits(aveHome(), { path: runRoot, id: run.id }, file) ? file : null;
    } catch {
      return null;
    }
  }

  function writeRunFile(at: Pick<Held, "run">, file: WorkspaceRecord): void {
    at.run.writeFileAtomic(RUN_FILE, JSON.stringify(file));
  }

  /** The project the caller has open, as it really is on disk, when the record's path for its project is that one by text. Only the
   * caller's path is asked about, never the record's. */
  function liveOf(file: WorkspaceRecord, projectRoot: string | undefined): Pick<Held, "live"> {
    if (file.project === undefined || projectRoot === undefined) return {};
    try {
      const root = vetRecordPath("project", file.project.root, { root: realpathSync.native(projectRoot) });
      return root === undefined ? {} : { live: { root } };
    } catch {
      return {};
    }
  }

  /** The run's folder and record, found again after a restart by the slug of its item and run; a record of another item or run is none. */
  function locate(run: Pick<RunRef, "runId" | "itemId" | "projectRoot">): Held | null {
    const slug = runSlug(run.itemId, run.runId);
    const known = roots.get(slug);
    let candidates: string[];
    if (known !== undefined) candidates = [known];
    else {
      try {
        candidates = (holdDir(aveHome()).existing(WORKTREES_DIR)?.list() ?? []).map(project => join(worktreesRoot(), project, slug));
      } catch {
        return null;
      }
    }
    for (const runRoot of candidates) {
      const chain = chainOf(runRoot);
      const file = chain === null ? null : readRunFile(runRoot, chain.run);
      if (chain === null || file === null || file.runId !== run.runId || file.itemId !== run.itemId) continue;
      roots.set(slug, runRoot);
      return { runRoot, file, ...chain, ...liveOf(file, run.projectRoot) };
    }
    return null;
  }

  /** A folder of the run by the identity its record holds: undefined when it is gone, a throw when another thing has its name. */
  const outOf = (at: Held): OwnedDir | undefined => at.file.outDir === undefined ? undefined : at.run.child(OUT_DIR, at.file.outDir);
  /** What a stop while a stage folder was seeded left of the ignore matcher. */
  async function clearIgnoreFolders(at: Held): Promise<void> {
    for (const name of at.run.list()) if (isIgnoreFolder(name)) await at.run.remove(name);
  }

  /** The `worktrees` folder of the run's repository, held from the directory git gave for the open project in this call; a throw, with
   * nothing asked, while the record's repository was not found to be that one. */
  function repoWorktrees(at: Held): OwnedDir | undefined {
    const gitDir = at.live?.gitDir;
    if (gitDir === undefined || at.file.repo === undefined) throw new OwnedFsError("not-plain", "the record's repository is not the open project's");
    return holdDir(gitDir, at.file.repo.id).existing("worktrees");
  }

  /**
   * The registration git made for a folder of the run, read from the folder's `.git` file and taken only when the two name each other by
   * identity: the admin folder lies in this repository's `worktrees`, and its `gitdir` file points into this very folder of this very run
   * folder. Any other is not the run's.
   */
  function captureRegistration(at: Held, key: string, folder: OwnedDir): Registration | undefined {
    try {
      const admin = vetRecordPath("link", folder.readFile(".git")?.toString("utf8") ?? "", at.live);
      if (admin === undefined) return undefined;
      const held = repoWorktrees(at)?.existing(basename(admin));
      const text = held?.readFile("gitdir")?.toString("utf8");
      if (held === undefined || text === undefined) return undefined;
      const gitdir = resolve(admin, text.trimEnd());
      // A registration no later call would take is not recorded.
      const own = runFolderOf(at.run, key, gitdir);
      return own !== undefined && realDirId(own) === folder.id ? { admin, id: held.id, gitdir } : undefined;
    } catch {
      return undefined;
    }
  }

  /** Records the registration of a folder git was asked to fill, whatever git then answered; a stop between git's write and the host's is
   * made up for the same way before the folder is removed. */
  function recordRegistration(at: Held, key: string, folder: OwnedDir | undefined): Registration | undefined {
    const known = at.file.registrations[key];
    if (known !== undefined || folder === undefined) return known;
    const registration = captureRegistration(at, key, folder);
    if (registration !== undefined) {
      at.file.registrations[key] = registration;
      writeRunFile(at, at.file);
    }
    return registration;
  }

  /** Where a recorded registration is in the repository's `worktrees`, as long as it is still the admin folder that was recorded and
   * still points at the run's folder; undefined when it is gone, a throw when another thing is there. The run's folder is removed before
   * its registration: while something has its name, that is the directory the record names. */
  function ownRegistration(at: Held, key: string, registration: Registration): { worktrees: OwnedDir; name: string } | undefined {
    const admin = vetRecordPath("admin", registration.admin, at.live);
    if (admin === undefined) throw new OwnedFsError("not-plain", "the registration is not in the run's repository");
    const name = basename(admin);
    const worktrees = repoWorktrees(at);
    if (worktrees === undefined) return undefined;
    const own = runFolderOf(at.run, key, registration.gitdir);
    if (own === undefined) throw new OwnedFsError("changed", "the registration points outside the run's folder");
    const folder = nodeIdOf(own);
    if (folder !== undefined && folder !== (key === JOIN_DIR ? at.file.joinDir : at.file.stages[key]?.dir)) throw new OwnedFsError("changed", "the registration points at a folder the run did not make");
    if (worktrees.entryId(name) === undefined) return undefined;
    const text = worktrees.child(name, registration.id)?.readFile("gitdir")?.toString("utf8");
    if (text === undefined || !samePath(resolve(admin, text.trimEnd()), registration.gitdir)) throw new OwnedFsError("changed", "the registration no longer points at the run's folder");
    return { worktrees, name };
  }

  /** Takes the run's own registration out of the repository, host-side and by identity. Git's prune is never run: it would drop every
   * registration whose folder is missing, the user's too. */
  async function removeRegistration(at: Held, key: string): Promise<void> {
    const registration = at.file.registrations[key];
    if (registration === undefined) return;
    await assertRepository(at);
    const found = ownRegistration(at, key, registration);
    if (found !== undefined) await found.worktrees.remove(found.name, registration.id);
    delete at.file.registrations[key];
    writeRunFile(at, at.file);
  }

  const answered = (args: readonly string[], result: Awaited<ReturnType<HostGit["run"]>>): string => {
    if (result.code !== 0) throw new Error(`git ${args[0] ?? ""} failed (${result.code}): ${result.stderr.trim().slice(0, 300)}`);
    return result.stdout;
  };
  const gitOut = async (cwd: string, args: readonly string[], call?: Parameters<HostGit["run"]>[2]): Promise<string> => answered(args, await git.run(cwd, args, call));

  /**
   * Git in a folder of the run. Git writes where the folder's `.git` file points, and that file is text anyone could have put there:
   * before every call it must name, by its text, a registration in the repository found for the open project in this call, and that
   * name must still be held by the admin folder the record names. Git is then given that registration and the folder themselves, so
   * it never reads the `.git` file: one swapped after this check directs nothing.
   */
  function gitIn(at: Held, key: string, folder: OwnedDir): (args: readonly string[], call?: Parameters<HostGit["run"]>[2]) => ReturnType<HostGit["run"]> {
    return async (args, call) => git.run(folder.path, args, { ...call, worktree: ownWorktree(at, key, folder) });
  }

  function ownWorktree(at: Held, key: string, folder: OwnedDir): { gitDir: string; workTree: string } {
    folder.check();
    const admin = vetRecordPath("link", folder.readFile(".git")?.toString("utf8") ?? "", at.live);
    const registration = at.file.registrations[key];
    if (admin === undefined || registration === undefined || repoWorktrees(at)?.child(basename(admin), registration.id) === undefined) throw new Error(`the ${key === JOIN_DIR ? "integration" : "stage"} worktree is not the run's own`);
    return { gitDir: admin, workTree: folder.path };
  }

  /** The drivers to switch off for git in a folder of the run, read the way git reads its configuration there, under the same check. */
  async function driversIn(at: Held, key: string, folder: OwnedDir): ReturnType<HostGit["drivers"]> {
    return git.drivers(folder.path, ownWorktree(at, key, folder));
  }

  /**
   * Fills a folder git registered with nothing checked out. Git checks a worktree out as that worktree, where configuration the
   * project root never reads can name a driver, so its drivers are read there first; a filter required there alone (`required` are the
   * project root's) cannot be asked about the way `open` asks, and refuses the folder.
   */
  async function checkOut(at: Held, key: string, folder: OwnedDir, required: readonly string[]): Promise<void> {
    await assertRepository(at);
    const drivers = await driversIn(at, key, folder);
    if (drivers.requiredFilters.some(name => !required.includes(name))) throw new Error("a filter is required in the worktree alone");
    answered(["reset"], await gitIn(at, key, folder)(["reset", "--hard", "-q"], { drivers: drivers.config }));
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

  function ignoreRulesOf(at: Held): SeedRules["ignored"] {
    const root = at.live?.root;
    if (root === undefined || at.file.ignoreRules !== true) return undefined;
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

  /** The home is the project or lies inside it, or the project lies inside the home's `worktrees`: a run folder would be project content,
   * or the project a run folder. */
  function overlapsHome(root: string): boolean {
    const within = (outer: string, inner: string): boolean => { try { return realWithin(outer, inner); } catch { return false; } };
    return within(root, aveHome()) || within(worktreesRoot(), root);
  }

  /** The repository's common directory as it really is on disk, and which directory it is. */
  async function commonDirOf(cwd: string): Promise<NonNullable<WorkspaceRecord["repo"]>> {
    const gitDir = realpathSync.native((await gitOut(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).replace(/\r?\n$/u, ""));
    const id = realDirId(gitDir);
    if (id === undefined) throw new Error("the repository's common directory is no real directory");
    return { gitDir, id };
  }

  /**
   * Which field of the record the open project or its repository does not answer to, asked of git and the disk right now. A project
   * root can come to lie in another repository (its own `.git` removed inside a parent's work tree); git would then act on that one.
   * Everything is asked of the open project; of the record only text and identities are compared. With no open project that the
   * record names, nothing is asked at all.
   */
  async function repositoryMismatch(at: Held): Promise<Mismatch | undefined> {
    const { project, repo } = at.file;
    if (project === undefined || repo === undefined) return undefined;
    const live = at.live;
    if (live === undefined) return { field: "project.root", side: "unverified" };
    delete live.gitDir;
    // `live.root` is the caller's open project as `liveOf` (or `open`) read it from disk, not record text.
    if (realDirId(live.root) !== project.id) return { field: "project.id", side: "repo" };
    const now = await commonDirOf(live.root).catch(() => undefined);
    at.run.check();
    // Git gave no answer: that says nothing of the repository, and a run is not taken apart on it.
    if (now === undefined) return { field: "repo.gitDir", side: "unverified" };
    const gitDir = vetRecordPath("gitDir", repo.gitDir, { ...live, gitDir: now.gitDir });
    if (gitDir === undefined) return { field: "repo.gitDir", side: "unverified" };
    if (now.id !== repo.id) return { field: "repo.id", side: "repo" };
    live.gitDir = gitDir;
    return undefined;
  }

  /** Before each step that changes the repository. */
  async function assertRepository(at: Held): Promise<void> {
    const mismatch = await repositoryMismatch(at);
    if (mismatch !== undefined) throw new Error(`the repository is not the one the run was opened in (${mismatch.field})`);
  }

  function open(run: RunRef, projectRoot: string | undefined): ReturnType<StageWorkspaceProvider["open"]> {
    return serial(run.runId, () => openIn(run, projectRoot));
  }

  async function openIn(run: RunRef, projectRoot: string | undefined): ReturnType<StageWorkspaceProvider["open"]> {
    const refused = (code: Refusal): { ok: false; code: Refusal } => ({ ok: false, code });
    // A home whose privacy or read boundary could not be checked gets no workspace made in it.
    if (isAveHomeBoundaryUnverifiedAtBoot() || getAveHomePrivacyFailure() !== undefined) return refused("home-boundary-unverified");
    let project: WorkspaceRecord["project"];
    if (projectRoot !== undefined) {
      let root: string;
      try { root = realpathSync.native(projectRoot); } catch { return refused("workspace-unavailable"); }
      const id = realDirId(root);
      // A root that is no plain path gets no workspace: no later call would take the record's path for it.
      if (id === undefined || overlapsHome(root) || vetRecordPath("project", root, { root }) === undefined) return refused("workspace-unavailable");
      project = { root, id };
    }
    // Everything the record says of the project and its repository is read before anything is made.
    let gitRun: { baseCommit: string; branch: string; drivers: Awaited<ReturnType<HostGit["drivers"]>>; repo: NonNullable<WorkspaceRecord["repo"]> } | undefined;
    let ignoreRules = false;
    try {
      const found = project === undefined ? { inWorkTree: false } : await gitProject(project.root);
      if (project !== undefined && "baseCommit" in found) {
        const drivers = await git.drivers(project.root);
        // A filter the repository requires for checkout is never run, so such a repository gets no git workspace.
        if (drivers.requiredFilters.length > 0 && await usesFilter(project.root, drivers.requiredFilters)) return refused("git-unavailable");
        const repo = await commonDirOf(project.root);
        // A repository directory that is no plain path gets no git workspace: no later call would take the record's path for it.
        if (vetRecordPath("gitDir", repo.gitDir, { root: project.root, gitDir: repo.gitDir }) === undefined) return refused("git-unavailable");
        gitRun = { baseCommit: found.baseCommit, branch: runBranch(run.runId), drivers, repo };
      } else ignoreRules = "inWorkTree" in found && found.inWorkTree;
    } catch {
      return refused(project !== undefined ? "git-unavailable" : "workspace-unavailable");
    }
    if (project !== undefined && realDirId(project.root) !== project.id) return refused("workspace-unavailable");

    const root = project === undefined ? undefined : process.platform === "win32" ? project.root.toLowerCase() : project.root;
    const runRoot = runRootOf(aveHome(), root, run.itemId, run.runId);
    // Each level is made on its own in the level above it, which is still the directory it was: a link would put the run somewhere else.
    let chain: Pick<Held, "project" | "run">;
    try {
      const worktrees = holdDir(aveHome()).ensure(WORKTREES_DIR);
      const made = (): typeof chain | undefined => {
        const project = worktrees.ensure(basename(dirname(runRoot)));
        try { return { project, run: project.make(basename(runRoot)) }; } catch (error) {
          if (!(error instanceof OwnedFsError) || (error.reason !== "exists" && error.reason !== "moved")) throw error;
          // Only the project folder may have gone: a level above it that is no longer the one that was held ends the call.
          worktrees.check();
          return undefined;
        }
      };
      // The project folder is shared: another run's release, in this or another process, removes it once it is empty. It is then made
      // again in the same `worktrees` of the same home.
      const held = made() ?? made();
      if (held === undefined) return refused("workspace-unavailable");
      chain = held;
    } catch {
      return refused("home-boundary-unverified");
    }
    const file: WorkspaceRecord = {
      v: 2, runId: run.runId, itemId: run.itemId, kind: gitRun !== undefined ? "git" : "folder", self: chain.run.id,
      ...(project !== undefined ? { project } : {}),
      ...(gitRun !== undefined ? { repo: gitRun.repo, branch: gitRun.branch, baseCommit: gitRun.baseCommit } : ignoreRules ? { ignoreRules: true } : {}),
      refs: [], registrations: {}, stages: {}, joins: {}, out: {},
    };
    // The project is the one this call was given, as it is on disk.
    const at: Held = { runRoot, file, ...chain, ...(project !== undefined ? { live: { root: project.root } } : {}) };
    let recorded = false;
    try {
      writeRunFile(at, file);
      recorded = true;
      if (project === undefined || gitRun === undefined) {
        file.outDir = at.run.make(OUT_DIR).id;
        writeRunFile(at, file);
        roots.set(basename(runRoot), runRoot);
        return { ok: true, workspace: { kind: "folder", runRoot, outputDir: join(runRoot, OUT_DIR) } };
      }
      const { branch, baseCommit } = gitRun;
      const joined = at.run.make(JOIN_DIR);
      file.joinDir = joined.id;
      writeRunFile(at, file);
      // The branch is made only where no ref has its name: one that is already there is not this run's and stays as it is. A ref is
      // recorded once git answered that it made it, and only a recorded ref is ever deleted.
      const ref = `refs/heads/${branch}`;
      await assertRepository(at);
      if ((await git.run(project.root, ["update-ref", END_OF_OPTIONS, ref, baseCommit, ""])).code !== 0) throw new Error("the run's branch is taken");
      file.refs = [{ name: ref, oid: baseCommit }];
      writeRunFile(at, file);
      await assertRepository(at);
      joined.check();
      const added = await git.run(project.root, ["worktree", "add", "--no-checkout", END_OF_OPTIONS, joined.path, branch], { drivers: [...gitRun.drivers.config, ...ABSOLUTE_LINKS] }).catch(() => undefined);
      if (recordRegistration(at, JOIN_DIR, at.run.child(JOIN_DIR, joined.id)) === undefined || added?.code !== 0) throw new Error("the integration worktree was not made");
      joined.check();
      await checkOut(at, JOIN_DIR, joined, gitRun.drivers.requiredFilters);
      joined.check();
      if (answered(["symbolic-ref"], await gitIn(at, JOIN_DIR, joined)(["symbolic-ref", "-q", "HEAD"])).trim() !== ref) throw new Error("the integration worktree is not on the run's branch");
      roots.set(basename(runRoot), runRoot);
      return { ok: true, workspace: { kind: "git", runRoot, branch, baseCommit } };
    } catch {
      // What this call made goes the way a release takes it, by the record as far as it was written; a folder that got no record is
      // still the directory this call made.
      if (recorded) await releaseIn(at, "all", "drop").catch(() => undefined);
      else await at.project.remove(basename(runRoot), at.run.id).catch(() => undefined);
      roots.delete(basename(runRoot));
      return refused(project !== undefined ? "git-unavailable" : "workspace-unavailable");
    }
  }

  /** The stage's folder and its entry. The folder goes only as the directory the record names; of a stage that got no further than its
   * entry, whatever holds its name is unlinked, never followed. Its registration follows it, and is checked before the folder goes: a
   * stage is not left half released. With `repo` false the repository is left as it is. */
  async function removeStage(at: Held, stageId: string, repo = true): Promise<void> {
    const { file } = at;
    const name = stageDirName(stageId);
    const dir = file.stages[stageId]?.dir;
    if (repo && file.kind === "git") {
      await assertRepository(at);
      if (dir !== undefined) recordRegistration(at, stageId, at.run.child(name, dir));
      const registration = file.registrations[stageId];
      if (registration !== undefined) ownRegistration(at, stageId, registration);
    }
    await at.run.remove(name, dir);
    if (repo) await removeRegistration(at, stageId);
    delete file.stages[stageId];
    writeRunFile(at, file);
  }

  async function prepareGit(at: Held, stage: TemplateStage, held: OwnedDir): Promise<Refusal | null> {
    const { file } = at;
    const root = at.live?.root;
    if (root === undefined || file.branch === undefined) return "workspace-unavailable";
    try {
      const drivers = await git.drivers(root);
      const head = (await gitOut(root, ["rev-parse", "--verify", END_OF_OPTIONS, `refs/heads/${file.branch}^{commit}`])).trim();
      // The stage folder is the host's own before git fills it, and still that folder each time something is removed from it.
      await assertRepository(at);
      held.check();
      const added = await git.run(root, ["worktree", "add", "--detach", "--no-checkout", END_OF_OPTIONS, held.path, head], { drivers: [...drivers.config, ...ABSOLUTE_LINKS] }).catch(() => undefined);
      if (recordRegistration(at, stage.id, at.run.child(stageDirName(stage.id), held.id)) === undefined || added?.code !== 0) throw new Error("the stage worktree was not made");
      held.check();
      await checkOut(at, stage.id, held, drivers.requiredFilters);
      held.check();
      // A tracked secret file is not handed to a stage.
      const tracked = nul(answered(["ls-files"], await gitIn(at, stage.id, held)(["ls-files", "-z"])));
      held.check();
      for (const path of tracked) {
        if (!sensitive(join(held.path, path))) continue;
        const segments = path.split("/");
        await held.walk(segments.slice(0, -1))?.remove(segments.at(-1) as string);
      }
      const link = held.readFile(".git")?.toString("utf8");
      if (link === undefined) throw new Error("the stage folder has no worktree link");
      const entry = file.stages[stage.id];
      if (entry) Object.assign(entry, { ready: true, base: head, link });
      writeRunFile(at, file);
      return null;
    } catch {
      await removeStage(at, stage.id).catch(() => undefined);
      return "git-unavailable";
    }
  }

  async function prepareFolder(at: Held, stage: TemplateStage, target: OwnedDir): Promise<Refusal | null> {
    const { runRoot, file } = at;
    const inputs = stage.inputFiles ?? [];
    if (file.project === undefined && inputs.some(input => input.from === "project")) return "inputs-need-project";
    const seeded: Record<string, string> = {};
    let files = 0;
    let bytes = 0;
    const limits = options.seedLimits ?? { files: MAX_SEED_FILES, bytes: MAX_SEED_BYTES };
    const root = at.live?.root;
    const plain = root !== undefined && file.ignoreRules !== true ? plainFolderIgnore(git, runRoot, root, { check: () => at.run.check(), makeTemp: () => at.run.makeTemp(IGNORE_PREFIX), remove: scratch => at.run.remove(basename(scratch.path), scratch.id) }, options.nameReader) : undefined;
    try {
      for (const input of inputs) {
        let source: SourceRoot;
        let paths: string[];
        let expect: Map<string, string> | undefined;
        if (input.from === "project") {
          // The folder that is listed is the one the files are then read from: the caller's open project, not the record's path.
          const project = file.project as NonNullable<WorkspaceRecord["project"]>;
          if (root === undefined || realDirId(root) !== project.id) return "seed-unreadable";
          source = { path: root, id: project.id };
          const listed = await listSeedFiles(root, input.paths, seedRules(plain?.ignored ?? ignoreRulesOf(at)));
          if (!listed.ok) return listed.code;
          paths = listed.files.map(entry => entry.path);
          files += listed.files.length;
          bytes += listed.files.reduce((sum, entry) => sum + entry.size, 0);
        } else {
          // That stage's collected files, as they are in the output folder now.
          const out = outOf(at);
          if (out === undefined) return "seed-unreadable";
          source = out;
          paths = Object.entries(file.out).filter(([, owner]) => owner.stageId === input.stageId).map(([path]) => path);
          expect = new Map(paths.map(path => [path, file.out[path]?.sha256 ?? ""]));
          files += paths.length;
          bytes += paths.reduce((sum, path) => sum + (file.out[path]?.size ?? 0), 0);
        }
        if (files > limits.files || bytes > limits.bytes) return "seed-too-large";
        for (const copied of await copySeedFiles(source, target, paths, expect)) seeded[copied.path] = copied.sha256;
      }
    } catch {
      return "seed-unreadable";
    } finally {
      await plain?.done();
    }
    const entry = file.stages[stage.id];
    if (entry) Object.assign(entry, { ready: true, seeded, outputs: stage.outputs ?? ["**"] });
    writeRunFile(at, file);
    return null;
  }

  function prepare(run: RunRef, stage: TemplateStage, attempt: number): ReturnType<StageWorkspaceProvider["prepare"]> {
    return serial(run.runId, async () => {
      const unavailable = { ok: false as const, code: "workspace-unavailable" as const };
      const found = locate(run);
      // `_join`, `_out` and the run record are the host's; nothing but a stage id names a stage folder.
      if (!found || !isStageId(stage.id)) return unavailable;
      const { file } = found;
      const name = stageDirName(stage.id);
      const existing = file.stages[stage.id];
      const ready = (dir: OwnedDir, base: string | undefined) => ({ ok: true as const, workspace: { root: dir.path, kind: file.kind, ...(base !== undefined ? { baseCommit: base } : {}) } });
      let there: OwnedDir | undefined;
      if (existing?.ready === true && existing.dir !== undefined) {
        try { there = found.run.child(name, existing.dir); } catch { /* not the folder the record names: handled as a stale entry below */ }
      }
      if (existing !== undefined && there !== undefined) {
        // The same folder again: a repeated call, or a rerun after `Request changes`.
        if (existing.attempt !== attempt) {
          Object.assign(existing, { attempt, sealed: false, manifest: undefined });
          writeRunFile(found, file);
        }
        return ready(there, existing.base);
      }
      // A git run with no open project that its record names gets nothing made: no step in its repository could be taken.
      if (file.kind === "git" && found.live === undefined) return unavailable;
      // A folder nobody recorded is not the provider's to replace.
      if (existing === undefined && found.run.entryId(name) !== undefined) return unavailable;
      let entry: StageEntry | undefined;
      let held: OwnedDir;
      try {
        if (existing !== undefined) await removeStage(found, stage.id);
        entry = { ready: false, attempt };
        file.stages[stage.id] = entry;
        writeRunFile(found, file);
        held = found.run.make(name);
        entry.dir = held.id;
        writeRunFile(found, file);
      } catch {
        // An entry that got no folder names nothing: what may hold its name is not the run's.
        if (entry !== undefined && entry.dir === undefined) {
          delete file.stages[stage.id];
          try { writeRunFile(found, file); } catch { /* the next call reads what is on disk */ }
        }
        return unavailable;
      }
      const refused = file.kind === "git" ? await prepareGit(found, stage, held) : await prepareFolder(found, stage, held);
      if (refused !== null) {
        if (file.stages[stage.id] !== undefined) await removeStage(found, stage.id).catch(() => undefined);
        return { ok: false as const, code: refused };
      }
      return ready(held, file.stages[stage.id]?.base);
    });
  }

  async function sealGit(run: RunRef, at: Held, stageId: string, entry: StageEntry, stage: OwnedDir): Promise<{ ok: true; sealCommit?: string } | { ok: false; code: Refusal }> {
    const root = at.live?.root;
    const dir = stage.path;
    // The worktree link decides which repository the host's git writes to; a changed one is not followed.
    if (root === undefined || entry.base === undefined || stage.readFile(".git")?.toString("utf8") !== entry.link) return { ok: false, code: "workspace-unavailable" };
    if (!(await identityOf(root))) return { ok: false, code: "identity-missing" };
    await assertRepository(at);
    const drivers = (await driversIn(at, stageId, stage)).config;
    const inStage = gitIn(at, stageId, stage);
    const out = async (args: readonly string[], call?: Parameters<HostGit["run"]>[2]): Promise<string> => answered(args, await inStage(args, call));
    await out(["add", "-A"], { drivers });
    // A secret path never enters the commit, as a deletion (the host removed it) or as a new file.
    const staged = nul(await out(["diff", "--cached", "--name-only", "-z", "--no-ext-diff", "--no-textconv", "--no-renames", "HEAD"], { drivers }));
    for (const paths of chunked(staged.filter(path => sensitive(join(dir, path))))) {
      await assertRepository(at);
      await out(["reset", "-q", "HEAD", "--", ...paths], { drivers });
    }
    const dirty = await inStage(["diff", "--cached", "--quiet", "--no-ext-diff", "--no-textconv", "HEAD"], { drivers });
    if (dirty.code !== 0) {
      await assertRepository(at);
      await out(["commit", "-q", "--no-verify", "--no-gpg-sign", "-m", `Stage ${stageId}\n\n${trailers(run, stageId)}`], { drivers });
    }
    const head = (await out(["rev-parse", "--verify", "HEAD^{commit}"])).trim();
    return head === entry.base ? { ok: true } : { ok: true, sealCommit: head };
  }

  async function sealFolder(entry: StageEntry, stage: OwnedDir): Promise<{ ok: true } | { ok: false; code: Refusal }> {
    const listed = await listSeedFiles(stage.path, entry.outputs ?? ["**"], seedRules());
    if (!listed.ok) return listed;
    // A name the record cannot hold as a file's path would be hashed under another spelling and then make the whole record unreadable.
    if (!listed.files.every(item => isRecordFilePath(item.path))) return { ok: false, code: "seed-unreadable" };
    const manifest: OutputFile[] = [];
    for (const item of listed.files) manifest.push({ path: item.path, ...(await hashSeedFile(stage, item.path)) });
    entry.manifest = manifest;
    return { ok: true };
  }

  function seal(run: RunRef, stageId: string): ReturnType<StageWorkspaceProvider["seal"]> {
    return serial(run.runId, async () => {
      const found = locate(run);
      const entry = found?.file.stages[stageId];
      if (!found || entry?.ready !== true || entry.dir === undefined) return { ok: false as const, code: "workspace-unavailable" as const };
      let stage: OwnedDir | undefined;
      try { stage = found.run.child(stageDirName(stageId), entry.dir); } catch { /* not the folder the record names */ }
      if (stage === undefined) return { ok: false as const, code: "workspace-unavailable" as const };
      const held = stage;
      // One seal per attempt: a repeated call returns it without another snapshot.
      if (entry.sealed === true) return { ok: true as const, ...(entry.sealCommit !== undefined ? { sealCommit: entry.sealCommit } : {}) };
      try {
        const sealed: { ok: true; sealCommit?: string } | { ok: false; code: Refusal } = found.file.kind === "git" ? await sealGit(run, found, stageId, entry, held) : await sealFolder(entry, held);
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
    const { file } = at;
    const root = at.live?.root;
    const joined = file.joinDir === undefined ? undefined : at.run.child(JOIN_DIR, file.joinDir);
    if (root === undefined || joined === undefined) throw new Error("the run has no integration worktree");
    const seals = Object.fromEntries(stageIds.map(stageId => [stageId, file.stages[stageId]?.sealCommit ?? null]));
    if (stageIds.some(stageId => file.stages[stageId]?.sealed !== true)) throw new Error("a stage of the join is not sealed");
    if (!(await identityOf(root))) return conflictOf(run, joinId, "identity-missing", [], seals);
    // Every git call in the folder goes through `gitIn`; before each merge and abort the repository is asked again as well.
    await assertRepository(at);
    const drivers = (await driversIn(at, JOIN_DIR, joined)).config;
    const inJoin = gitIn(at, JOIN_DIR, joined);
    const merging = async (): Promise<boolean> => (await inJoin(["rev-parse", "--verify", "--quiet", "MERGE_HEAD"])).code === 0;
    const unmerged = async (): Promise<string[]> => nul(answered(["diff"], await inJoin(["diff", "--name-only", "-z", "--diff-filter=U", "--no-ext-diff", "--no-textconv"], { drivers })));
    if (await merging()) {
      if (file.merging === undefined) {
        // The user is in the middle of resolving here; their work is left exactly as it is.
        return conflictOf(run, joinId, "merge-conflict", (await unmerged()).map(path => ({ path, stageIds: [...stageIds] })), seals, "a merge is still in progress in the integration folder");
      }
      await assertRepository(at);
      await inJoin(["merge", "--abort"], { drivers });
    }
    if (file.merging !== undefined) { delete file.merging; writeRunFile(at, file); }
    for (const stageId of stageIds) {
      const sealCommit = file.stages[stageId]?.sealCommit;
      if (sealCommit === undefined) continue;
      // Already on the run branch: an earlier call merged it, or the user did while resolving.
      if ((await inJoin(["merge-base", "--is-ancestor", END_OF_OPTIONS, sealCommit, "HEAD"])).code === 0) continue;
      file.merging = sealCommit;
      writeRunFile(at, file);
      await assertRepository(at);
      const merged = await inJoin(["merge", "--no-edit", "--no-stat", "--no-verify", "--no-gpg-sign", "-m", `Collect stage ${stageId}\n\n${trailers(run, stageId)}`, END_OF_OPTIONS, sealCommit], { drivers });
      if (merged.code !== 0) {
        const paths = await unmerged().catch(() => []);
        const files: ConflictFile[] = [];
        for (const path of paths) {
          const touched = [stageId];
          for (const other of stageIds) {
            const entry = file.stages[other];
            if (other === stageId || entry?.sealCommit === undefined || entry.base === undefined) continue;
            const changed = await inJoin(["diff", "--quiet", "--no-ext-diff", "--no-textconv", END_OF_OPTIONS, entry.base, entry.sealCommit, "--", path], { drivers });
            if (changed.code === 1) touched.push(other);
          }
          files.push({ path, stageIds: stageIds.filter(id => touched.includes(id)) });
        }
        if (await merging()) {
          await assertRepository(at);
          await inJoin(["merge", "--abort"], { drivers });
        }
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
    const { file } = at;
    if (file.joins[joinId] === true) return { ok: true };
    if (stageIds.some(stageId => file.stages[stageId]?.sealed !== true)) throw new Error("a stage of the join is not sealed");
    const out = outOf(at);
    if (out === undefined) throw new Error("the run has no output folder");
    const outDir = out.path;
    const stageDir = (stageId: string): OwnedDir => {
      const id = file.stages[stageId]?.dir;
      const dir = id === undefined ? undefined : at.run.child(stageDirName(stageId), id);
      if (dir === undefined) throw new Error("a stage of the join has no folder");
      return dir;
    };
    const next = new Map(Object.entries(file.out));
    // Where the output folder's names fold case, two paths that differ by case alone are one file: the run folder's own entries tell.
    // Paths are composed and then folded to capitals, which joins what such file systems join: letters that differ by case, a letter
    // and its compatibility sign, a composed letter and its decomposed spelling. It is not the volume's own table, and it errs to the
    // safe side: a pair it joins that the volume keeps apart is contested for nothing, except a composed and a decomposed spelling
    // that one stage holds side by side.
    const folds = projectFoldsCase(at.run.path, options.nameReader) === true;
    const fold = (path: string): string => folds ? path.normalize("NFC").toUpperCase() : path;
    const spelled = new Map([...next.keys()].map(path => [fold(path), path]));
    const contested = new Map<string, Set<string>>();
    const copies: { stageId: string; path: string; sha256: string; size: number }[] = [];
    for (const stageId of stageIds) {
      const entry = file.stages[stageId] as StageEntry;
      const own = new Set((entry.manifest ?? []).map(item => item.path));
      for (const item of entry.manifest ?? []) {
        const folded = fold(item.path);
        const known = next.has(item.path) ? item.path : spelled.get(folded) ?? item.path;
        const held = next.get(known);
        if (held === undefined || (known === item.path && held.sha256 === item.sha256)) {
          if (held === undefined) { next.set(item.path, { sha256: item.sha256, size: item.size, stageId }); spelled.set(folded, item.path); copies.push({ stageId, ...item }); }
          continue;
        }
        if (known !== item.path) {
          // A composed and a decomposed spelling one stage holds side by side are two files: its volume keeps them apart. A pair that
          // differs by case stays contested: the output folder may fold what a folder of the stage does not.
          if (held.stageId === stageId && own.has(known) && item.path.normalize("NFC") === known.normalize("NFC")) {
            next.set(item.path, { sha256: item.sha256, size: item.size, stageId });
            copies.push({ stageId, ...item });
            continue;
          }
          // The same file under another spelling: two answers for one name, whatever each holds.
          contested.set(known, (contested.get(known) ?? new Set([held.stageId])).add(stageId));
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
      const onDisk = lstatSync(placed, { throwIfNoEntry: false })?.isFile() === true ? await hashSeedFile(out, path) : undefined;
      const recorded = file.out[path]?.sha256;
      if (onDisk !== undefined && onDisk.sha256 !== recorded) next.set(path, { ...onDisk, stageId: [...stages].at(-1) as string });
      else files.push({ path, stageIds: [...stages] });
    }
    if (files.length > 0) return conflictOf(run, joinId, "same-path", files, Object.fromEntries(stageIds.map(id => [id, file.stages[id]?.manifest ?? []])));
    const wanted: typeof copies = [];
    // Checked before anything is written: each sealed file is still what was sealed, and a file the host did not put in the output folder stays.
    for (const copy of copies) {
      if (contested.has(copy.path)) continue;
      if ((await hashSeedFile(stageDir(copy.stageId), copy.path)).sha256 !== copy.sha256) throw new Error("a sealed stage file changed before it was collected");
      const target = join(outDir, copy.path);
      const there = lstatSync(target, { throwIfNoEntry: false })?.isFile() === true ? await hashSeedFile(out, copy.path) : undefined;
      if (there !== undefined && there.sha256 !== copy.sha256 && there.sha256 !== file.out[copy.path]?.sha256) next.set(copy.path, { ...there, stageId: copy.stageId });
      else wanted.push(copy);
    }
    // Each copy is the sealed content, or it does not stay.
    for (const copy of wanted) await copySeedFiles(stageDir(copy.stageId), out, [copy.path], new Map([[copy.path, copy.sha256]]));
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

  /** The refs the run made go only while each is still at the commit it was made at: a branch a stage was collected onto is the run's
   * result and stays, and so does one git gave no answer for. */
  async function deleteRunRefs(at: Held): Promise<void> {
    const { file } = at;
    const root = at.live?.root;
    if (root === undefined) return;
    for (const ref of [...file.refs]) {
      await assertRepository(at);
      const deleted = await git.run(root, ["update-ref", "-d", END_OF_OPTIONS, ref.name, ref.oid]).catch(() => undefined);
      if (deleted?.code !== 0) continue;
      file.refs = file.refs.filter(entry => entry !== ref);
      writeRunFile(at, file);
    }
  }

  /** What of the run is no longer what its record names, read before a removal starts. */
  async function preflight(at: Held): Promise<Mismatch[]> {
    const { file } = at;
    try { at.run.check(); } catch { return [{ field: "self", side: "host" }]; }
    if (readRunFile(at.runRoot, at.run) === null) return [{ field: "record", side: "host" }];
    const found: Mismatch[] = [];
    const node = (field: string, name: string, id: NodeId | undefined): void => {
      if (id === undefined) return;
      try { at.run.child(name, id); } catch { found.push({ field, side: "host" }); }
    };
    for (const [stageId, entry] of Object.entries(file.stages)) node(`stages.${stageId}.dir`, stageDirName(stageId), entry.dir);
    node("joinDir", JOIN_DIR, file.joinDir);
    node("outDir", OUT_DIR, file.outDir);
    if (found.length > 0) return found;
    // With the repository not the one the record names, or not checked, nothing is asked about its registrations.
    let mismatch: Mismatch | undefined;
    try { mismatch = await repositoryMismatch(at); } catch { return [{ field: "self", side: "host" }]; }
    if (mismatch !== undefined) return [mismatch];
    for (const [key, registration] of Object.entries(file.registrations)) {
      try { ownRegistration(at, key, registration); } catch (error) {
        found.push({ field: `registrations.${key}`, side: error instanceof OwnedFsError && error.reason === "not-plain" ? "unverified" : "repo" });
      }
    }
    return found;
  }

  /**
   * Stage folders, and for "all" the integration worktree and the record; the run branch stays, and so does the output folder with its
   * record unless `output` is "drop". "all" starts only when every folder of the run is still the directory its record names; else the
   * whole run stays as it is. It stays as well, record and registrations included, when a path of the record could not be checked
   * against an open project: nothing is asked of such a path, and what the run left in the repository is not lost with its record.
   * When it is the open project or its repository that is no longer what the record names, the run folder still goes, and nothing in
   * the repository is touched: its branch and worktree list stay as they are.
   */
  async function releaseIn(at: Held, stageIds: readonly string[] | "all", output: "keep" | "drop" = "keep"): Promise<void> {
    const { file } = at;
    if (stageIds !== "all") {
      for (const stageId of stageIds) if (file.stages[stageId] !== undefined) await removeStage(at, stageId);
      return;
    }
    const mismatches = await preflight(at);
    const fields = (side: Mismatch["side"]): string => mismatches.filter(entry => entry.side === side).map(entry => entry.field).join(", ");
    // Said once for a run folder: a folder that stays is found again at every boot.
    const first = (side: Mismatch["side"]): boolean => {
      const key = `${side}
${at.runRoot}
${fields(side)}`;
      return !warnedOnce.has(key) && warnedOnce.add(key).has(key);
    };
    for (const side of ["host", "unverified"] as const) {
      if (fields(side) === "") continue;
      if (first(side)) log.warn(side === "host" ? "a run's workspace stays as it is: %s is not what its record names (run=%s)" : "a run's cleanup is unverified and everything of it is left: %s is not the open project's (run=%s)", fields(side), file.runId);
      return;
    }
    const repo = fields("repo") === "";
    if (!repo && first("repo")) log.warn("a run's repository is left as it is: %s is not what its record names (run=%s)", fields("repo"), file.runId);
    for (const stageId of Object.keys(file.stages)) await removeStage(at, stageId, repo);
    await clearIgnoreFolders(at);
    if (file.kind === "git") {
      if (repo && file.joinDir !== undefined) recordRegistration(at, JOIN_DIR, at.run.child(JOIN_DIR, file.joinDir));
      await at.run.remove(JOIN_DIR, file.joinDir);
      if (repo) {
        await removeRegistration(at, JOIN_DIR);
        await deleteRunRefs(at);
      }
    }
    if (file.kind === "folder" && at.run.entryId(OUT_DIR) !== undefined) {
      if (output === "keep") return;
      await at.run.remove(OUT_DIR, file.outDir);
    }
    await at.run.remove(`${RUN_FILE}.tmp`);
    await at.run.remove(RUN_FILE);
    // Only empty folders go from here on: the run folder, then the project folder while the levels above it are still the same.
    try {
      if (at.run.removeSelfIfEmpty()) at.project.removeSelfIfEmpty();
    } catch { /* what could not go stays */ }
  }

  function release(run: RunRef, stageIds: readonly string[] | "all"): Promise<void> {
    return serial(run.runId, async () => {
      const found = locate(run);
      if (!found) return;
      await releaseIn(found, stageIds);
      if (stageIds === "all") roots.delete(runSlug(run.itemId, run.runId));
    });
  }

  const unreadable = new Set<string>();

  /** Every run folder that holds its own record. A folder without one was not made by a run the host can name; it is left alone.
   * `whole`: every level under `worktrees` was listed, but for the files found where a folder would be: a file holds no run. `unread`: the names of the run folders that hold no record the host reads, in
   * lower case as a run's own name is, since a volume that folds case finds a run's folder under any spelling of it; a run that is
   * not among `runs` has no folder when its name is not among these either. */
  function recordedRuns(): { runs: Held[]; whole: boolean; unread: Set<string> } {
    const found: Held[] = [];
    const unread = new Set<string>();
    let whole = true;
    try {
      const base = holdDir(aveHome()).existing(WORKTREES_DIR);
      if (base === undefined) return { runs: found, whole, unread };
      for (const name of base.list()) {
        try {
          const project = base.existing(name);
          // Gone since it was listed: what it held is not known.
          if (project === undefined) { whole = false; continue; }
          for (const slug of project.list()) {
            let run: OwnedDir | undefined;
            try { run = project.existing(slug); } catch { /* No real directory: told apart below. */ }
            if (run === undefined) {
              if (!isFileAt(join(project.path, slug))) unread.add(slug.toLowerCase());
              continue;
            }
            const runRoot = join(worktreesRoot(), name, slug);
            const file = readRunFile(runRoot, run);
            if (file !== null) { found.push({ runRoot, file, project, run }); continue; }
            unread.add(slug.toLowerCase());
            if (!unreadable.has(runRoot)) {
              unreadable.add(runRoot);
              log.warn("a folder under worktrees holds no record of its own and is left as it is: %s/%s", name, slug);
            }
          }
        } catch {
          // A file where a project's folder would be holds no run. Any other entry that could not be read may hold any run's, and
          // the projects after it are read all the same.
          if (!isFileAt(join(base.path, name))) whole = false;
        }
      }
    } catch {
      // A `worktrees` that is no real directory, or cannot be listed, may hold any run's folder.
      whole = false;
    }
    return { runs: found, whole, unread };
  }

  /** Inside the run's queue, a run folder seen earlier: the same directories holding the same owner's record, as it reads now. Null for
   * any other, which is then left as it is. */
  function heldStill(seen: Held): Held | null {
    try { seen.run.check(); } catch { return null; }
    const file = readRunFile(seen.runRoot, seen.run);
    return file !== null && ownerOf(file) === ownerOf(seen.file) ? { ...seen, file } : null;
  }

  /** Whether the stores let the run's output go, read now. A start publishes its folder before it stores its record, so only a read
   * begun after the folder was listed, with the run's queue held, decides: by then the run's row is on the board. */
  async function removableNow(run: { runId: string; itemId: number }): Promise<boolean> {
    return (await options.removable?.())?.(run) === true;
  }

  async function discard(projects: ReadonlyMap<string, RemovedRunProject>, waits?: (runId: string) => boolean): Promise<readonly string[]> {
    const taken: string[] = [];
    // A first selection only, so that the stores are read again for the few runs it names and not for every folder.
    const selected = await options.removable?.();
    if (selected === undefined) return taken;
    const listed = recordedRuns();
    for (const seen of listed.runs) {
      const { runId, itemId } = seen.file;
      if (!selected({ runId, itemId })) continue;
      let waiting = false;
      await serial(runId, async () => {
        if (!(await removableNow({ runId, itemId }))) return;
        // Asked after the last wait: what `projects` holds was read before the stores were, and the run's root may have come since.
        waiting = waits?.(runId) === true;
        if (waiting) return;
        const current = heldStill(seen);
        if (current === null) return;
        taken.push(runId);
        await releaseIn({ ...current, ...liveOf(current.file, projects.get(runId)?.projectRoot) }, "all", "drop");
      });
      if (!waiting) roots.delete(runSlug(itemId, runId));
    }
    // A run with no folder left has nothing a root could be used for. A folder that could not be read may be the run's whose name
    // it carries, under whichever project; a level that could not be listed may hold any run's.
    if (listed.whole) {
      const recorded = new Set(listed.runs.map(seen => seen.file.runId));
      for (const [runId, { itemId }] of projects) if (!recorded.has(runId) && !listed.unread.has(runSlug(itemId, runId))) taken.push(runId);
    }
    return taken;
  }

  async function sweep(activeRunIds: readonly string[], projects?: ReadonlyMap<string, string>): Promise<void> {
    const active = new Set(activeRunIds);
    // What a stop between a record's removal and the discard left behind goes here; an answer that could not be had keeps it.
    const selected = await options.removable?.().catch(() => undefined);
    for (const seen of recordedRuns().runs) {
      const { runId, itemId } = seen.file;
      if (active.has(runId)) {
        // A run that goes on keeps its stages and its output; what a stop during a seeding left of the ignore matcher still goes.
        await serial(runId, async () => {
          const current = heldStill(seen);
          if (current !== null) await clearIgnoreFolders(current);
        }).catch((error: unknown) => log.warn("an ignore matcher's folder was not removed: %s", (error as Error).message));
        continue;
      }
      await serial(runId, async () => {
        const output = selected?.({ runId, itemId }) === true && await removableNow({ runId, itemId }).catch(() => false) ? "drop" : "keep";
        const current = heldStill(seen);
        if (current !== null) await releaseIn({ ...current, ...liveOf(current.file, projects?.get(runId)) }, "all", output);
      }).catch(() => undefined);
      roots.delete(runSlug(itemId, runId));
    }
  }

  return { open, prepare, seal, integrate, release, discard, sweep };
}
