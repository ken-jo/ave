import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { createLogger } from "../../lib/logger.js";
import { isSensitivePath } from "../../permissions/sensitive-paths.js";
import { aveHome, getAveHomePrivacyFailure } from "../../shared/ave-home.js";
import { TOOL_TIMEOUT_POLICY } from "../../shared/tool-timeout-policy.js";
import { canonicalWorkflowJson, resultHashOf } from "../../shared/workflow-template-output.js";
import type { TemplateStage } from "../../shared/workflow-template-types.js";
import { isStageId } from "../template-graph.js";
import { type NameReader, plainFolderIgnore, projectFoldsCase } from "./folder-ignore.js";
import { createHostGit, type HostGit, HostGitError } from "./host-git.js";
import { type FolderId, holdDir, type NodeId, type OwnedDir, OwnedFsError, type Pin, realDirId, realWithin, type SourceRoot } from "./owned-fs.js";
import type { JoinConflict } from "./shipped-shapes.js";
import type { RemovedRunProject, RunRef, StageWorkspaceProvider, WORKSPACE_REFUSALS } from "./stage-workspace.js";
import { ADMIN_MARK, adminPinOf, IGNORE_PREFIX, isIgnoreFolder, JOIN_DIR, OUT_DIR, PIN_DIR, RUN_FILE, RUN_MARK, runBranch, runPinOf, runRootOf, runSlug, stageDirName, WORKTREES_DIR } from "./workspace-layout.js";
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
  /** The highest folder a plain-folder check looks at, itself included; with none it looks up to the volume root. */
  plainCeiling?: string;
}

/** A file's bytes as the text they are: none replaced, no leading mark dropped. Text that names a registration or a record is compared
 * with what the run holds, and bytes that are no text would compare as other text; they throw instead. */
const EXACT_TEXT = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const exactText = (bytes: Buffer | undefined): string | undefined => bytes === undefined ? undefined : EXACT_TEXT.decode(bytes);
/** The path a `gitdir` file holds: git ends it with one line break, and nothing else is taken off. */
const gitdirOf = (text: string): string => text.endsWith("\n") ? text.slice(0, -1) : text;

/** The mismatches already reported in this process, by record. */
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
  const plainCeiling = options.plainCeiling === undefined ? undefined : realpathSync.native(options.plainCeiling);
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

  const runPin = (at: Pick<Held, "runRoot" | "project">): Pin => ({ dir: at.project, name: runPinOf(basename(at.runRoot)) });
  /** Unlinks a pin whose anchor is gone, as it then holds nothing; with "any", one whose anchor is still there too. */
  async function dropPin(dir: OwnedDir, name: string, any?: "any"): Promise<void> {
    const id = any === "any" ? (dir.isFile(name) ? dir.entryId(name) : undefined) : dir.entryId(name, "single-link-file");
    if (id !== undefined) await dir.remove(name, id);
  }

  /** The record `open` wrote into this folder, or null: a file of another shape or version, a link, a file that has a second name, or a
   * record that does not name this very folder, by its pinned anchor, as its own directs nothing. */
  function readRunFile(at: Pick<Held, "runRoot" | "project" | "run">): WorkspaceRecord | null {
    try {
      const text = at.run.readFile(RUN_FILE);
      if (text === undefined) return null;
      const file: unknown = JSON.parse(EXACT_TEXT.decode(text));
      return isWorkspaceRecord(file) && recordFits(aveHome(), { path: at.runRoot, id: at.run.id, self: at.run.mark(RUN_MARK, runPin(at)) }, file) ? file : null;
    } catch {
      return null;
    }
  }

  const noLink = (error: unknown): boolean => error instanceof OwnedFsError && error.reason === "no-link";
  const devOf = (id: NodeId): string => id.slice(0, id.indexOf(":"));

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
      const file = chain === null ? null : readRunFile({ runRoot, ...chain });
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
  /** Where a registration's pin is. A pin is on its anchor's volume: beside the run folder for a repository on the home's device, and
   * else in the repository's own `ave-pins`, which a stage cannot write either. With "make", that folder is made when it is not there. */
  function adminPin(at: Held, key: string, make?: "make"): Pin {
    const name = adminPinOf(basename(at.runRoot), key);
    const repo = at.file.repo;
    if (repo === undefined || devOf(repo.id) === devOf(at.project.id)) return { dir: at.project, name };
    const gitDir = at.live?.gitDir;
    if (gitDir === undefined) throw new OwnedFsError("not-plain", "the record's repository is not the open project's");
    const common = holdDir(gitDir, repo.id);
    const dir = make === "make" ? common.ensure(PIN_DIR) : common.existing(PIN_DIR);
    if (dir === undefined) throw new OwnedFsError("changed", "the anchor's pin is gone");
    return { dir, name };
  }

  /**
   * The registration git made for a folder of the run, read from the folder's `.git` file and taken only when the two name each other by
   * identity: the admin folder lies in this repository's `worktrees`, and its `gitdir` file points into this very folder of this very run
   * folder. Any other is not the run's.
   */
  function captureRegistration(at: Held, key: string, folder: OwnedDir): { worktrees: OwnedDir; held: OwnedDir; admin: string; gitdir: string } | undefined {
    try {
      const admin = vetRecordPath("link", exactText(folder.readFile(".git")) ?? "", at.live);
      if (admin === undefined) return undefined;
      const worktrees = repoWorktrees(at);
      const held = worktrees?.existing(basename(admin));
      const text = exactText(held?.readFile("gitdir"));
      if (worktrees === undefined || held === undefined || text === undefined) return undefined;
      const gitdir = resolve(admin, gitdirOf(text));
      // A registration no later call would take is not recorded.
      const own = runFolderOf(at.run, key, gitdir);
      return own !== undefined && realDirId(own) === folder.id ? { worktrees, held, admin, gitdir } : undefined;
    } catch {
      return undefined;
    }
  }

  /** Records the registration of a folder git was asked to fill, whatever git then answered, held by an anchor the host makes in its
   * admin folder; a stop between git's write and the host's is made up for the same way before the folder is removed. One that cannot
   * be held goes at once, by the identity it was just read with, and the throw is passed on. */
  async function recordRegistration(at: Held, key: string, folder: OwnedDir | undefined): Promise<Registration | undefined> {
    const known = at.file.registrations[key];
    if (known !== undefined || folder === undefined) return known;
    const found = captureRegistration(at, key, folder);
    if (found === undefined) return undefined;
    let id: FolderId;
    try { id = await found.held.anchor(ADMIN_MARK, adminPin(at, key, "make")); } catch (error) {
      await found.worktrees.remove(basename(found.admin), found.held.id).catch(() => undefined);
      await dropAdminPin(at, key).catch(() => undefined);
      throw error;
    }
    const registration: Registration = { admin: found.admin, id, gitdir: found.gitdir };
    at.file.registrations[key] = registration;
    writeRunFile(at, at.file);
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
    // Asked of the held run folder: one that took its place would show the folder gone while it is still there.
    const folder = at.run.entryId(basename(own));
    if (folder !== undefined && folder !== (key === JOIN_DIR ? at.file.joinDir : at.file.stages[key]?.dir)) throw new OwnedFsError("changed", "the registration points at a folder the run did not make");
    if (worktrees.entryId(name) === undefined) return undefined;
    const held = worktrees.child(name, registration.id);
    held?.mark(ADMIN_MARK, adminPin(at, key));
    const text = exactText(held?.readFile("gitdir"));
    if (text === undefined || !samePath(resolve(admin, gitdirOf(text)), registration.gitdir)) throw new OwnedFsError("changed", "the registration no longer points at the run's folder");
    return { worktrees, name };
  }

  /** Unlinks a registration's pin whose anchor is gone; a repository's `ave-pins` goes with its last pin. */
  async function dropAdminPin(at: Held, key: string): Promise<void> {
    let pin: Pin;
    try { pin = adminPin(at, key); } catch (error) {
      if (error instanceof OwnedFsError && error.reason === "changed") return;
      throw error;
    }
    await dropPin(pin.dir, pin.name);
    if (pin.dir !== at.project) pin.dir.removeSelfIfEmpty();
  }

  /** The run's own pins in a repository on another device than the home, those of registrations left there too; the repository is held
   * by the identity its record names, and only names of this run are asked about. */
  async function dropRepositoryPins(at: Held): Promise<void> {
    const repo = at.file.repo;
    if (repo === undefined || devOf(repo.id) === devOf(at.project.id)) return;
    let pins: OwnedDir | undefined;
    // A repository that is no longer the one recorded keeps its pins.
    try { pins = holdDir(repo.gitDir, repo.id).existing(PIN_DIR); } catch { return; }
    if (pins === undefined) return;
    const own = `${basename(at.runRoot)}.`;
    for (const name of pins.list()) if (name.startsWith(own) && name.endsWith(".pin")) await dropPin(pins, name, "any");
    pins.removeSelfIfEmpty();
  }

  /** Takes the run's own registration out of the repository, host-side and by identity. Git's prune is never run: it would drop every
   * registration whose folder is missing, the user's too. */
  async function removeRegistration(at: Held, key: string): Promise<void> {
    const registration = at.file.registrations[key];
    if (registration === undefined) return;
    await assertRepository(at);
    const found = ownRegistration(at, key, registration);
    if (found !== undefined) await found.worktrees.remove(found.name, registration.id);
    await dropAdminPin(at, key);
    delete at.file.registrations[key];
    writeRunFile(at, at.file);
  }

  const answered = (args: readonly string[], result: Awaited<ReturnType<HostGit["run"]>>): string => {
    if (result.code !== 0) throw new Error(`git ${args[0] ?? ""} failed (${result.code}): ${result.stderr.trim().slice(0, 300)}`);
    return result.stdout;
  };
  const gitOut = async (cwd: string, args: readonly string[], call?: Parameters<HostGit["run"]>[2]): Promise<string> => answered(args, await git.run(cwd, args, { ...call, requiresFloor: true }));

  /**
   * Git in a folder of the run. Git writes where the folder's `.git` file points, and that file is text anyone could have put there:
   * before every call it must name, by its text, a registration in the repository found for the open project in this call, and that
   * name must still be held by the admin folder the record names. Git is then given that registration and the folder themselves, so
   * it never reads the `.git` file: one swapped after this check directs nothing.
   */
  function gitIn(at: Held, key: string, folder: OwnedDir): (args: readonly string[], call?: Parameters<HostGit["run"]>[2]) => ReturnType<HostGit["run"]> {
    return async (args, call) => git.run(folder.path, args, { ...call, worktree: ownWorktree(at, key, folder), requiresFloor: true });
  }

  function ownWorktree(at: Held, key: string, folder: OwnedDir): { gitDir: string; workTree: string } {
    folder.check();
    const admin = vetRecordPath("link", exactText(folder.readFile(".git")) ?? "", at.live);
    const registration = at.file.registrations[key];
    if (admin === undefined || registration === undefined || repoWorktrees(at)?.child(basename(admin), registration.id) === undefined) throw new Error(`the ${key === JOIN_DIR ? "integration" : "stage"} worktree is not the run's own`);
    return { gitDir: admin, workTree: folder.path };
  }

  /** The drivers to switch off for git in a folder of the run, read the way git reads its configuration there, under the same check. */
  async function driversIn(at: Held, key: string, folder: OwnedDir): ReturnType<HostGit["drivers"]> {
    return git.drivers(folder.path, ownWorktree(at, key, folder), { requiresFloor: true });
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

  /** A folder is plain only when no folder from it up holds a `.git`: git failing to set a repository up, or having none to run, says
   * nothing of the ignore rules and index one there holds. */
  function plainOnly(root: string): { inWorkTree: false } {
    for (let dir = root; ; dir = dirname(dir)) {
      let found: boolean;
      try { found = lstatSync(join(dir, ".git"), { throwIfNoEntry: false }) !== undefined; } catch { found = true; }
      if (found) throw new Error("the folder lies in a repository git did not set up");
      if (dirname(dir) === dir || (plainCeiling !== undefined && samePath(dir, plainCeiling))) return { inWorkTree: false };
    }
  }

  /** The HEAD commit when `root` is the top level of a git work tree that has one; null for every other folder. */
  async function gitProject(root: string): Promise<{ baseCommit: string } | { inWorkTree: boolean }> {
    let top: Awaited<ReturnType<HostGit["run"]>>;
    try {
      top = await git.run(root, ["rev-parse", "--show-toplevel"], { exact: true });
    } catch (error) {
      if (error instanceof HostGitError && error.reason === "unavailable") return plainOnly(root);
      throw error;
    }
    if (top.code !== 0) return plainOnly(root);
    // A top level that cannot be found says nothing of the folder: it is not thereby a plain one, whose ignore rules nobody asks.
    if (!samePath(realpathSync.native(top.stdout.replace(/\r?\n$/u, "")), root)) return { inWorkTree: true };
    const head = await git.run(root, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
    if (head.code === 0) return { baseCommit: head.stdout.trim() };
    // No commit yet only when HEAD names a branch git shows does not exist (exit 2, which always comes with its own message); any other
    // answer, a HEAD whose object is missing or no commit among them, is none.
    if (head.code === 1 && head.stdout === "" && head.stderr === "") {
      const branch = await git.run(root, ["symbolic-ref", "-q", "HEAD"], { exact: true });
      const ref = branch.stdout.slice(0, -1);
      if (branch.code === 0 && branch.stderr === "" && branch.stdout.endsWith("\n") && /^refs\/heads\/[^\n]+$/u.test(ref)) {
        const shown = await git.run(root, ["show-ref", "--exists", ref]);
        if (shown.code === 2 && shown.stdout === "") return { inWorkTree: true };
      }
    }
    throw new Error("git gave no answer for the project's HEAD");
  }

  async function usesFilter(root: string, filters: readonly string[]): Promise<boolean> {
    // The names go back to git as they came: a name that is no text would be asked about under another.
    const tracked = await gitOut(root, ["ls-files", "-z"], { exact: true });
    if (tracked === "") return false;
    const attributes = nul(await gitOut(root, ["check-attr", "-z", "--stdin", "filter"], { stdin: tracked, exact: true }));
    for (let index = 2; index < attributes.length; index += 3) if (filters.includes(attributes[index] ?? "")) return true;
    return false;
  }

  async function identityOf(root: string): Promise<boolean> {
    for (const key of ["user.name", "user.email"]) {
      const value = await git.run(root, ["config", "--get", key], { requiresFloor: true });
      if (value.code !== 0 || value.stdout.trim() === "") return false;
    }
    return true;
  }

  const trailers = (run: RunRef, stageId?: string): string => `Ave-Run: ${run.runId}\n${stageId !== undefined ? `Ave-Stage: ${stageId}\n` : ""}`;

  function ignoreRulesOf(at: Held): SeedRules["ignored"] {
    const root = at.live?.root;
    if (root === undefined || at.file.ignoreRules !== true) return undefined;
    return async (paths) => {
      const checked = await git.run(root, ["check-ignore", "-z", "--stdin"], { exact: true, stdin: paths.map(path => `${path}\0`).join("") });
      // Exit 1 with nothing written: none of them is ignored. Anything git writes to stderr, or any other exit, is no answer.
      if (checked.stderr !== "" || (checked.code === 1 ? checked.stdout !== "" : checked.code !== 0)) throw new Error("the project's ignore rules could not be read");
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

  /** A successful listing of the common-directory config proves which ref store it names. */
  async function refStoreOf(root: string, repo: NonNullable<WorkspaceRecord["repo"]>): Promise<"files" | "reftable" | "elsewhere" | undefined> {
    const deadline = performance.now() + TOOL_TIMEOUT_POLICY.stageWorkspaceGitMs;
    const common = holdDir(repo.gitDir, repo.id);
    const id = common.entryId("config", "single-link-file");
    if (id === undefined) return undefined;
    const read = await git.run(root, ["config", "--file", join(common.path, "config"), "--list", "-z"], { isolated: true, exact: true, requiresFloor: true, deadline });
    if (common.entryId("config", "single-link-file") !== id || performance.now() >= deadline) return undefined;
    if (read.code !== 0 || read.stderr !== "") return undefined;
    if (read.stdout === "") return "files";
    if (!read.stdout.endsWith("\0")) return undefined;
    let store: "files" | "reftable" | "elsewhere" = "files";
    for (const entry of read.stdout.slice(0, -1).split("\0")) {
      const newline = entry.indexOf("\n");
      const key = newline < 0 ? entry : entry.slice(0, newline);
      if (!/^[A-Za-z0-9-]+\.(?:[^\0\n]*\.)?[A-Za-z][A-Za-z0-9-]*$/u.test(key)) return undefined;
      if (key.toLowerCase() !== "extensions.refstorage") continue;
      if (newline < 0) return undefined;
      const value = entry.slice(newline + 1);
      if (value !== "files" && value !== "reftable") store = "elsewhere";
      else if (store !== "elsewhere") store = value;
    }
    return store;
  }

  /** The repository's common directory as it really is on disk, and which directory it is. */
  async function commonDirOf(cwd: string): Promise<NonNullable<WorkspaceRecord["repo"]>> {
    const gitDir = realpathSync.native((await gitOut(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"], { exact: true })).replace(/\r?\n$/u, ""));
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
    // A git whose hooks the floor is not proven to keep off is not run on the repository; the run waits for one that is.
    if (!(await git.floorHolds())) return { field: "git.hooks", side: "unverified" };
    // `live.root` is the caller's open project as `liveOf` (or `open`) read it from disk, not record text.
    // `project.id` and `repo.id` are plain ids, with no pin: a folder made anew may carry a reused one. That never widens what goes, as
    // the repository loses only a registration held by its pinned anchor and a ref the run recorded; an id that does not match only
    // leaves the repository as it is.
    let rootId: NodeId | undefined;
    // A root that cannot be read may still be the recorded one: nothing of the run is taken apart on that.
    try { rootId = realDirId(live.root, "known"); } catch { return { field: "project.id", side: "unverified" }; }
    if (rootId !== project.id) return { field: "project.id", side: "repo" };
    const now = await commonDirOf(live.root).catch(() => undefined);
    at.run.check();
    // Git gave no answer: that says nothing of the repository, and a run is not taken apart on it.
    if (now === undefined) return { field: "repo.gitDir", side: "unverified" };
    const gitDir = vetRecordPath("gitDir", repo.gitDir, { ...live, gitDir: now.gitDir });
    if (gitDir === undefined) return { field: "repo.gitDir", side: "unverified" };
    if (now.id !== repo.id) return { field: "repo.id", side: "repo" };
    const store = await refStoreOf(live.root, now).catch(() => undefined);
    at.run.check();
    if (store === undefined) return { field: "repo.refStorage", side: "unverified" };
    if (store === "elsewhere") return { field: "repo.refStorage", side: "repo" };
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
    if (getAveHomePrivacyFailure() !== undefined) return refused("home-boundary-unverified");
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
        if (!(await git.floorHolds())) return refused("git-unavailable");
        const drivers = await git.drivers(project.root, undefined, { requiresFloor: true });
        // A filter the repository requires for checkout is never run, so such a repository gets no git workspace.
        if (drivers.requiredFilters.length > 0 && await usesFilter(project.root, drivers.requiredFilters)) return refused("git-unavailable");
        const repo = await commonDirOf(project.root);
        // Refs a format keeps in a folder of its own choosing, a worktree's among them, are out of reach of the run's cleanup.
        const store = await refStoreOf(project.root, repo);
        if (store !== "files" && store !== "reftable") return refused("git-unavailable");
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
    let self: FolderId;
    // The pin is made before the record: no record is written for a folder nothing pins.
    try { self = await chain.run.anchor(RUN_MARK, runPin({ runRoot, ...chain })); } catch (error) {
      await chain.project.remove(basename(runRoot), chain.run.id).catch(() => undefined);
      await dropPin(chain.project, runPin({ runRoot, ...chain }).name).catch(() => undefined);
      return refused(noLink(error) ? "volume-unsupported" : "workspace-unavailable");
    }
    const file: WorkspaceRecord = {
      v: 2, runId: run.runId, itemId: run.itemId, kind: gitRun !== undefined ? "git" : "folder", self,
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
      if ((await git.run(project.root, ["update-ref", END_OF_OPTIONS, ref, baseCommit, ""], { requiresFloor: true })).code !== 0) throw new Error("the run's branch is taken");
      file.refs = [{ name: ref, oid: baseCommit }];
      writeRunFile(at, file);
      await assertRepository(at);
      joined.check();
      const added = await git.run(project.root, ["worktree", "add", "--no-checkout", END_OF_OPTIONS, joined.path, branch], { drivers: [...gitRun.drivers.config, ...ABSOLUTE_LINKS], requiresFloor: true }).catch(() => undefined);
      if (await recordRegistration(at, JOIN_DIR, at.run.child(JOIN_DIR, joined.id)) === undefined || added?.code !== 0) throw new Error("the integration worktree was not made");
      joined.check();
      await checkOut(at, JOIN_DIR, joined, gitRun.drivers.requiredFilters);
      joined.check();
      if (answered(["symbolic-ref"], await gitIn(at, JOIN_DIR, joined)(["symbolic-ref", "-q", "HEAD"])).trim() !== ref) throw new Error("the integration worktree is not on the run's branch");
      roots.set(basename(runRoot), runRoot);
      return { ok: true, workspace: { kind: "git", runRoot, branch, baseCommit } };
    } catch (error) {
      // What this call made goes the way a release takes it, by the record as far as it was written; a folder that got no record is
      // still the directory this call made.
      if (recorded) await releaseIn(at, "all", "drop").catch(() => undefined);
      else await at.project.remove(basename(runRoot), at.run.id).catch(() => undefined);
      roots.delete(basename(runRoot));
      return refused(noLink(error) ? "volume-unsupported" : project !== undefined ? "git-unavailable" : "workspace-unavailable");
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
      if (dir !== undefined) await recordRegistration(at, stageId, at.run.child(name, dir));
      const registration = file.registrations[stageId];
      if (registration !== undefined) ownRegistration(at, stageId, registration);
    }
    await at.run.remove(name, dir);
    // Written before the registration goes: a folder made at the name after a stop is then none the run made, whatever id it got.
    const entry = file.stages[stageId];
    if (entry?.dir !== undefined) {
      entry.ready = false;
      delete entry.dir;
      writeRunFile(at, file);
    }
    if (repo) await removeRegistration(at, stageId);
    delete file.stages[stageId];
    writeRunFile(at, file);
  }

  async function prepareGit(at: Held, stage: TemplateStage, held: OwnedDir): Promise<Refusal | null> {
    const { file } = at;
    const root = at.live?.root;
    if (root === undefined || file.branch === undefined) return "workspace-unavailable";
    try {
      const drivers = await git.drivers(root, undefined, { requiresFloor: true });
      const head = (await gitOut(root, ["rev-parse", "--verify", END_OF_OPTIONS, `refs/heads/${file.branch}^{commit}`])).trim();
      // The stage folder is the host's own before git fills it, and still that folder each time something is removed from it.
      await assertRepository(at);
      held.check();
      const added = await git.run(root, ["worktree", "add", "--detach", "--no-checkout", END_OF_OPTIONS, held.path, head], { drivers: [...drivers.config, ...ABSOLUTE_LINKS], requiresFloor: true }).catch(() => undefined);
      if (await recordRegistration(at, stage.id, at.run.child(stageDirName(stage.id), held.id)) === undefined || added?.code !== 0) throw new Error("the stage worktree was not made");
      held.check();
      await checkOut(at, stage.id, held, drivers.requiredFilters);
      held.check();
      // A tracked secret file is not handed to a stage. It is found, and then removed, by its name: one that is no text is neither.
      const tracked = nul(answered(["ls-files"], await gitIn(at, stage.id, held)(["ls-files", "-z"], { exact: true })));
      held.check();
      for (const path of tracked) {
        if (!sensitive(join(held.path, path))) continue;
        const segments = path.split("/");
        await held.walk(segments.slice(0, -1))?.remove(segments.at(-1) as string);
      }
      const link = exactText(held.readFile(".git"));
      if (link === undefined) throw new Error("the stage folder has no worktree link");
      const entry = file.stages[stage.id];
      if (entry) Object.assign(entry, { ready: true, base: head, link });
      writeRunFile(at, file);
      return null;
    } catch (error) {
      await removeStage(at, stage.id).catch(() => undefined);
      return noLink(error) ? "volume-unsupported" : "git-unavailable";
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
      // A folder nobody recorded is not the provider's to replace; neither is one that cannot be asked about.
      try {
        if (existing === undefined && found.run.entryId(name) !== undefined) return unavailable;
      } catch {
        return unavailable;
      }
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
    if (root === undefined || entry.base === undefined || exactText(stage.readFile(".git")) !== entry.link) return { ok: false, code: "workspace-unavailable" };
    if (!(await identityOf(root))) return { ok: false, code: "identity-missing" };
    await assertRepository(at);
    const drivers = (await driversIn(at, stageId, stage)).config;
    const inStage = gitIn(at, stageId, stage);
    const out = async (args: readonly string[], call?: Parameters<HostGit["run"]>[2]): Promise<string> => answered(args, await inStage(args, call));
    await out(["add", "-A"], { drivers });
    // A secret path never enters the commit, as a deletion (the host removed it) or as a new file.
    const staged = nul(await out(["diff", "--cached", "--name-only", "-z", "--no-ext-diff", "--no-textconv", "--no-renames", "HEAD"], { drivers, exact: true }));
    for (const paths of chunked(staged.filter(path => sensitive(join(dir, path))))) {
      await assertRepository(at);
      // Each is the one file that was checked: read as a pattern, a name would take other files out of the commit, or none.
      await out(["reset", "-q", "HEAD"], { drivers, paths });
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
    // A merge is in progress while MERGE_HEAD exists, and none only once git shows it does not (exit 2, with its own message); any other
    // answer is none, and nothing is taken from it.
    const merging = async (): Promise<boolean> => {
      const head = await inJoin(["show-ref", "--exists", "MERGE_HEAD"]);
      if (head.code === 0 && head.stdout === "" && head.stderr === "") return true;
      if (head.code === 2 && head.stdout === "") return false;
      throw new Error("git gave no answer whether a merge is in progress");
    };
    const unmerged = async (): Promise<string[]> => nul(answered(["diff"], await inJoin(["diff", "--name-only", "-z", "--diff-filter=U", "--no-ext-diff", "--no-textconv"], { drivers, exact: true })));
    /** The retry marker goes only once git aborted the merge, or has none. */
    const abort = async (): Promise<void> => {
      if (await merging()) {
        await assertRepository(at);
        answered(["merge"], await inJoin(["merge", "--abort"], { drivers }));
      }
      delete file.merging;
      writeRunFile(at, file);
    };
    if (await merging()) {
      if (file.merging === undefined) {
        // The user is in the middle of resolving here; their work is left exactly as it is.
        return conflictOf(run, joinId, "merge-conflict", (await unmerged()).map(path => ({ path, stageIds: [...stageIds] })), seals, "a merge is still in progress in the integration folder");
      }
    }
    if (file.merging !== undefined) await abort();
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
        // The files are read before the abort takes the merge state away; one that could not be read refuses the join.
        const paths = await unmerged().catch((error: unknown) => error as Error);
        const files: ConflictFile[] = [];
        let failed = paths instanceof Error ? paths : undefined;
        for (const path of paths instanceof Error ? [] : paths) {
          const touched = [stageId];
          for (const other of stageIds) {
            const entry = file.stages[other];
            if (other === stageId || entry?.sealCommit === undefined || entry.base === undefined) continue;
            const changed = await inJoin(["diff", "--quiet", "--no-ext-diff", "--no-textconv", END_OF_OPTIONS, entry.base, entry.sealCommit], { drivers, paths: [path] });
            if (changed.code === 1 && changed.stderr === "") touched.push(other);
            else if (changed.code !== 0 || changed.stderr !== "") failed ??= new Error("git could not tell which stages changed a conflicting file");
          }
          files.push({ path, stageIds: stageIds.filter(id => touched.includes(id)) });
        }
        await abort();
        if (failed !== undefined) throw failed;
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
    // Whether a file is at a path of the output folder, asked of the held folder level by level: a level that is no real folder holds
    // none, and an output folder that is no longer the one the run made is not asked at all.
    const fileInOut = (path: string): boolean => {
      const segments = path.split("/");
      try {
        return out.walk(segments.slice(0, -1))?.isFile(segments.at(-1) as string) === true;
      } catch (error) {
        if (error instanceof OwnedFsError && error.reason === "not-plain") return false;
        throw error;
      }
    };
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
      const onDisk = fileInOut(path) ? await hashSeedFile(out, path) : undefined;
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
      const there = fileInOut(copy.path) ? await hashSeedFile(out, copy.path) : undefined;
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

  function openJoinFolder(run: RunRef, open: (path: string) => Promise<boolean>): Promise<boolean> {
    return serial(run.runId, async () => {
      try {
        const at = locate(run);
        if (!at?.live || at.file.kind !== "git" || at.file.joinDir === undefined) return false;
        const folder = at.run.child(JOIN_DIR, at.file.joinDir);
        if (!folder) return false;
        folder.check();
        return await open(folder.path);
      } catch {
        return false;
      }
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
      const deleted = await git.run(root, ["update-ref", "-d", END_OF_OPTIONS, ref.name, ref.oid], { requiresFloor: true }).catch(() => undefined);
      if (deleted?.code !== 0) continue;
      file.refs = file.refs.filter(entry => entry !== ref);
      writeRunFile(at, file);
    }
  }

  /** What of the run folder itself is no longer what its record names; nothing of the project or its repository is asked. */
  function hostMismatches(at: Held): Mismatch[] {
    const { file } = at;
    try { at.run.check(); } catch { return [{ field: "self", side: "host" }]; }
    if (readRunFile(at) === null) return [{ field: "record", side: "host" }];
    const found: Mismatch[] = [];
    const node = (field: string, name: string, id: NodeId | undefined): void => {
      if (id === undefined) return;
      try { at.run.child(name, id); } catch { found.push({ field, side: "host" }); }
    };
    for (const [stageId, entry] of Object.entries(file.stages)) node(`stages.${stageId}.dir`, stageDirName(stageId), entry.dir);
    node("joinDir", JOIN_DIR, file.joinDir);
    node("outDir", OUT_DIR, file.outDir);
    return found;
  }

  /** What of the run is no longer what its record names, read before a removal starts. */
  async function preflight(at: Held): Promise<Mismatch[]> {
    const { file } = at;
    const found = hostMismatches(at);
    if (found.length > 0) return found;
    // With the repository not the one the record names, or not checked, nothing is asked about its registrations.
    let mismatch: Mismatch | undefined;
    try { mismatch = await repositoryMismatch(at); } catch { return [{ field: "self", side: "host" }]; }
    if (mismatch !== undefined) return [mismatch];
    for (const [key, registration] of Object.entries(file.registrations)) {
      // Only an identity found to differ proves the registration another's; evidence that could not be read may still be the run's own.
      try { ownRegistration(at, key, registration); } catch (error) {
        found.push({ field: `registrations.${key}`, side: error instanceof OwnedFsError && error.reason === "changed" ? "repo" : "unverified" });
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
   * the repository is touched: its branch and worktree list stay as they are. What left the whole run as it is, or undefined.
   */
  async function releaseIn(at: Held, stageIds: readonly string[] | "all", output: "keep" | "drop" = "keep"): Promise<Mismatch[] | undefined> {
    const { file } = at;
    if (stageIds !== "all") {
      for (const stageId of stageIds) if (file.stages[stageId] !== undefined) await removeStage(at, stageId);
      return undefined;
    }
    const mismatches = await preflight(at);
    if (reportLeft(at, mismatches)) return mismatches;
    const repo = fields(mismatches, "repo") === "";
    if (!repo && firstReport(at, "repo", fields(mismatches, "repo"))) log.warn("a run's repository is left as it is: %s is not what its record names (run=%s)", fields(mismatches, "repo"), file.runId);
    for (const stageId of Object.keys(file.stages)) await removeStage(at, stageId, repo);
    await clearIgnoreFolders(at);
    if (file.kind === "git") {
      if (repo && file.joinDir !== undefined) await recordRegistration(at, JOIN_DIR, at.run.child(JOIN_DIR, file.joinDir));
      await at.run.remove(JOIN_DIR, file.joinDir);
      if (file.joinDir !== undefined) {
        delete file.joinDir;
        writeRunFile(at, file);
      }
      if (repo) {
        await removeRegistration(at, JOIN_DIR);
        await deleteRunRefs(at);
      }
    }
    if (file.kind === "folder" && at.run.entryId(OUT_DIR) !== undefined) {
      if (output === "keep") return undefined;
      await at.run.remove(OUT_DIR, file.outDir);
    }
    await at.run.remove(`${RUN_FILE}.tmp`);
    await at.run.remove(RUN_FILE);
    await at.run.remove(RUN_MARK);
    // The run's pins go with its record, those of registrations left in a repository too, and so does any pin a stop left that holds
    // nothing. A pin whose anchor is still there stays: a stop before a record was written leaves it with the unrecorded run folder it
    // pins, as that folder stays too. Only empty folders go from here on: the run folder, then the project folder while the levels above
    // it are still the same.
    try {
      const own = `${basename(at.runRoot)}.`;
      for (const name of at.project.list()) if (name.endsWith(".pin")) await dropPin(at.project, name, name.startsWith(own) ? "any" : undefined);
      await dropRepositoryPins(at);
      if (at.run.removeSelfIfEmpty()) at.project.removeSelfIfEmpty();
    } catch { /* what could not go stays */ }
    return undefined;
  }

  const fields = (mismatches: readonly Mismatch[], side: Mismatch["side"]): string => mismatches.filter(entry => entry.side === side).map(entry => entry.field).join(", ");
  /** Said once for a record: a folder that stays is found again at every boot, and a record that takes its place is another. */
  function firstReport(at: Held, side: Mismatch["side"], said: string): boolean {
    const key = `${side}\n${ownerOf(at.file)}\n${said}`;
    return !warnedOnce.has(key) && warnedOnce.add(key).has(key);
  }

  /** Tells what leaves the whole run as it is; true when something does. */
  function reportLeft(at: Held, mismatches: readonly Mismatch[]): boolean {
    for (const side of ["host", "unverified"] as const) {
      const said = fields(mismatches, side);
      if (said === "") continue;
      if (firstReport(at, side, said)) log.warn(side === "host" ? "a run's workspace stays as it is: %s is not what its record names (run=%s)" : "a run's cleanup is unverified and everything of it is left: %s is not the open project's (run=%s)", said, at.file.runId);
      return true;
    }
    return false;
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
          // A file where a project's folder would be holds no run.
          if (base.isFile(name)) continue;
          const project = base.existing(name);
          // Gone since it was listed: what it held is not known.
          if (project === undefined) { whole = false; continue; }
          for (const slug of project.list()) {
            let run: OwnedDir | undefined;
            try {
              // So does a file where a run's folder would be.
              if (project.isFile(slug)) continue;
              run = project.existing(slug);
            } catch (error) {
              // The project's folder is no longer the one that was listed: what that one holds is not known. Any other entry that
              // is no real directory, or cannot be read, may be the run's whose name it carries.
              if (error instanceof OwnedFsError && error.reason === "moved") whole = false;
            }
            if (run === undefined) { unread.add(slug.toLowerCase()); continue; }
            const runRoot = join(worktreesRoot(), name, slug);
            const file = readRunFile({ runRoot, project, run });
            if (file !== null) { found.push({ runRoot, file, project, run }); continue; }
            unread.add(slug.toLowerCase());
            if (!unreadable.has(runRoot)) {
              unreadable.add(runRoot);
              log.warn("a folder under worktrees holds no record of its own and is left as it is: %s/%s", name, slug);
            }
          }
        } catch {
          // An entry that could not be read, or one read under a `worktrees` that is no longer the one listed, may hold any run's;
          // the projects after it are read all the same.
          whole = false;
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
    const file = readRunFile(seen);
    return file !== null && ownerOf(file) === ownerOf(seen.file) ? { ...seen, file } : null;
  }

  /** Whether the stores let the run's output go, read now. A start publishes its folder before it stores its record, so only a read
   * begun after the folder was listed, with the run's queue held, decides: by then the run's row is on the board. */
  /** The run folders a discard left whole on the root it was given for them, only for what the project or its repository answered, each
   * with the owner of the record it held and that root. While the same record is held, a discard given no root anew does not judge the
   * project again: with none it would report as a second fault what is the first one still. The run folder itself is still checked. */
  const leftWhole = new Map<string, { owner: string; root: RemovedRunProject | undefined }>();
  /** Takes the whole run apart, and remembers the one that was left whole. */
  async function dropWhole(current: Held, root: RemovedRunProject | undefined, live: string | undefined, output: "keep" | "drop"): Promise<void> {
    leftWhole.delete(current.runRoot);
    const left = await releaseIn({ ...current, ...liveOf(current.file, live) }, "all", output);
    if (root !== undefined && left?.every(entry => entry.side === "unverified") === true) leftWhole.set(current.runRoot, { owner: ownerOf(current.file), root });
  }

  async function removableNow(run: { runId: string; itemId: number }): Promise<boolean> {
    return (await options.removable?.())?.(run) === true;
  }

  async function discard(projects: ReadonlyMap<string, RemovedRunProject>, waits?: (runId: string) => boolean): Promise<readonly string[]> {
    const taken: string[] = [];
    // A first selection only, so that the stores are read again for the few runs it names and not for every folder.
    const selected = await options.removable?.();
    if (selected === undefined) return taken;
    const listed = recordedRuns();
    // A run folder no longer listed holds no record the memo could still be of.
    if (listed.whole) for (const runRoot of leftWhole.keys()) if (!listed.runs.some(seen => seen.runRoot === runRoot)) leftWhole.delete(runRoot);
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
        if (current === null) { leftWhole.delete(seen.runRoot); return; }
        const root = projects.get(runId);
        const left = leftWhole.get(seen.runRoot);
        if (left !== undefined && left.owner === ownerOf(current.file) && (root === undefined || root === left.root)) {
          // Given the very root it was judged on, that root is used up all the same.
          if (root !== undefined) taken.push(runId);
          reportLeft(current, hostMismatches(current));
          return;
        }
        taken.push(runId);
        await dropWhole(current, root, root?.projectRoot, "drop");
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
        if (current !== null) await dropWhole(current, undefined, projects?.get(runId), output);
      }).catch(() => undefined);
      roots.delete(runSlug(itemId, runId));
    }
  }

  return { open, prepare, seal, integrate, openJoinFolder, release, discard, sweep };
}
