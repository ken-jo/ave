import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { isStageId } from "../template-graph.js";
import { type FolderId, isFolderId, type NodeId, realDirId } from "./owned-fs.js";
import { ADMIN_MARK, JOIN_DIR, RUN_MARK, runBranch, runRootOf, stageDirName } from "./workspace-layout.js";

export interface OutputFile { path: string; sha256: string; size: number }

/** One worktree registration the run made in the repository, as it was when the host read it from the folder's `.git` file. */
export interface Registration {
  admin: string;
  /** The admin folder, held by the anchor the host made in it. */
  id: FolderId;
  /** The admin folder's `gitdir` file, resolved: the `.git` file of the worktree it belongs to. */
  gitdir: string;
}

export interface StageEntry {
  /** False while the folder is being made; such a folder is made again. */
  ready: boolean;
  attempt: number;
  /** Which directory the stage folder is, written right after the host made it. */
  dir?: NodeId;
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

/**
 * The host's record of one run's workspaces, beside the stage folders. Every later call finds the run through it, and it names what the
 * run owns by identity: which directory the run folder is, which directories its own folders are, which directory the project is and,
 * for a git run, which repository, branch and registrations are the run's.
 */
export interface WorkspaceRecord {
  v: 2;
  runId: string;
  itemId: number;
  kind: "git" | "folder";
  /** The run folder, held by its anchor. */
  self: FolderId;
  /** The canonical project root. */
  project?: { root: string; id: NodeId };
  /** Git: the repository's common directory. */
  repo?: { gitDir: string; id: NodeId };
  /** Folder kind: the project lies in a git work tree, whose ignore rules apply to seeding. */
  ignoreRules?: boolean;
  branch?: string;
  baseCommit?: string;
  /** The refs this run created, each with the commit it was created at. */
  refs: { name: string; oid: string }[];
  /** By `_join` or stage id. */
  registrations: Record<string, Registration>;
  joinDir?: NodeId;
  outDir?: NodeId;
  stages: Record<string, StageEntry>;
  /** Git: the seal commit a host merge is in the middle of. */
  merging?: string;
  /** Folder: the joins already collected, and who put each file into the output folder. */
  joins: Record<string, true>;
  out: Record<string, { sha256: string; size: number; stageId: string }>;
}

const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
export const samePath = (left: string, right: string): boolean => {
  const fold = (value: string): string => process.platform === "win32" ? resolve(value).toLowerCase() : resolve(value);
  return fold(left) === fold(right);
};

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isNodeId = (value: unknown): value is NodeId => typeof value === "string" && /^\d+:[1-9]\d*$/u.test(value);
const absolute = (value: unknown): value is string => typeof value === "string" && isAbsolute(value);
const optional = (value: unknown, is: (value: unknown) => boolean): boolean => value === undefined || is(value);
const text = (value: unknown): boolean => typeof value === "string";
/** A commit as git names it in full: the only form of one that is ever handed to git. */
const commit = (value: unknown): boolean => typeof value === "string" && OBJECT_ID.test(value);
/** A file of a stage folder or of the output folder as a seal lists it: names joined by `/`, none of them empty, `.` or `..`, and none
 * holding `:`, `\` or NUL. So it is relative, stays below its folder and names no drive, share or stream. */
export const isRecordFilePath = (value: unknown): boolean => typeof value === "string" && value.split("/").every(name => name !== "" && name !== "." && name !== ".." && !/[:\\\0]/u.test(name));
const located = (value: unknown, path: string): boolean => isObject(value) && absolute(value[path]) && isNodeId(value.id);

/** The shape alone: every field a later call relies on, and no field the record's kind does not carry. */
export function isWorkspaceRecord(value: unknown): value is WorkspaceRecord {
  if (!isObject(value) || value.v !== 2 || typeof value.runId !== "string" || value.runId === "" || !Number.isInteger(value.itemId)) return false;
  if ((value.kind !== "git" && value.kind !== "folder") || !isFolderId(value.self, RUN_MARK)) return false;
  if (!optional(value.project, project => located(project, "root")) || !optional(value.repo, repo => located(repo, "gitDir"))) return false;
  if (![value.branch, value.baseCommit].every(field => optional(field, text)) || !optional(value.merging, commit) || !optional(value.ignoreRules, flag => typeof flag === "boolean")) return false;
  if (!optional(value.joinDir, isNodeId) || !optional(value.outDir, isNodeId)) return false;
  if (!Array.isArray(value.refs) || !isObject(value.registrations) || !isObject(value.stages) || !isObject(value.joins) || !isObject(value.out)) return false;
  const given = (...fields: unknown[]): boolean => fields.some(field => field !== undefined);
  if (value.kind === "git") {
    if ([value.project, value.repo, value.branch, value.baseCommit].includes(undefined) || given(value.outDir, value.ignoreRules) || value.refs.length > 1) return false;
  } else if (given(value.repo, value.branch, value.baseCommit, value.merging, value.joinDir) || value.refs.length > 0 || Object.keys(value.registrations).length > 0) return false;
  if (!Object.keys(value.out).every(isRecordFilePath)) return false;
  if (!value.refs.every(ref => isObject(ref) && text(ref.name) && text(ref.oid))) return false;
  if (!Object.entries(value.registrations).every(([key, entry]) => (key === JOIN_DIR || isStageId(key)) && isObject(entry) && absolute(entry.admin) && isFolderId(entry.id, ADMIN_MARK) && absolute(entry.gitdir))) return false;
  return Object.entries(value.stages).every(([id, entry]) => isStageId(id) && isObject(entry) && typeof entry.ready === "boolean" && Number.isInteger(entry.attempt)
    && optional(entry.dir, isNodeId) && (entry.ready !== true || entry.dir !== undefined) && optional(entry.base, commit) && optional(entry.sealCommit, commit)
    && optional(entry.manifest, manifest => Array.isArray(manifest) && manifest.every(item => isObject(item) && isRecordFilePath(item.path))));
}

const foldName = (name: string): string => process.platform === "win32" ? name.toLowerCase() : name;

/**
 * A path as plain text: separators one way, the long-path prefix of a drive or share path taken off, then resolved. A device path and
 * every other prefixed form have none. Nothing is asked of the path.
 */
function plainPath(path: string): string | undefined {
  if (process.platform !== "win32") return resolve(path);
  let text = path.replaceAll("/", "\\");
  const long = /^\\\\\?\\(?:UNC(\\)|(?=[A-Za-z]:\\))/iu.exec(text);
  if (long !== null) text = (long[1] === undefined ? "" : "\\\\") + text.slice(long[0].length);
  return /^\\\\[?.](?:\\|$)/u.test(text) ? undefined : resolve(text);
}

/**
 * The run's folder for `key`, when a registration's `gitdir` names that folder's `.git` file; undefined when it names anything else.
 * Git writes that path as it really is on disk, which need not be the text the host reached the run folder by (a link above the
 * home): both spellings of the run folder are the host's own, and the record's text is matched against them before anything is asked
 * of the disk. Only a spelling of the host's is then looked up, to see that it is still the run folder that is held.
 */
export function runFolderOf(run: { path: string; id: NodeId }, key: string, gitdir: string): string | undefined {
  let real: string;
  try { real = realpathSync.native(run.path); } catch { return undefined; }
  const folder = vetRecordPath("worktree", gitdir, { run: [run.path, real], name: key === JOIN_DIR ? JOIN_DIR : stageDirName(key) });
  return folder !== undefined && realDirId(dirname(folder)) === run.id ? folder : undefined;
}

/** What the host resolved just now from the project its caller has open: the root as it is on disk and, once git was asked there, the
 * repository's common directory. None of it is record text. */
export interface LiveRepo { root: string; gitDir?: string }
/** The run folder as the host itself spells it, by the path it holds it at and as it really is on disk, and the name of one folder in it. */
interface RunFolder { run: readonly string[]; name: string }
type RecordPathKind = "project" | "gitDir" | "admin" | "link";

/**
 * A path the record or a worktree link file gives, taken by its text alone before anything is asked of it: both may name any path, on
 * any share or device. It must be absolute with no `.` or `..` segment (git would follow a link under one that text cannot show), is
 * made plain text and must then be, under the name fold, exactly what the host's own anchor gives. Against the open project:
 * `project` its root, `gitDir` its repository's common directory, `admin` a direct child of that directory's `worktrees`, `link` the
 * content of a `.git` file naming such a child. Against the run folder: `worktree` the `.git` file of the named folder in it. The
 * answer is built from the anchor's own text; undefined for every other path, and for every project path while no project is open.
 * Known limit, on the closed side: a path that names the same place by another spelling (a link above it, another name of the
 * share's server) is refused; so is a relative link, which git writes under `worktree.useRelativePaths`.
 */
export function vetRecordPath(kind: "worktree", text: string, folder: RunFolder): string | undefined;
export function vetRecordPath(kind: RecordPathKind, text: string, live: LiveRepo | undefined): string | undefined;
export function vetRecordPath(kind: RecordPathKind | "worktree", text: string, anchor: LiveRepo | RunFolder | undefined): string | undefined {
  if (anchor === undefined) return undefined;
  const path = kind === "link" ? /^gitdir: (.+?)\r?\n?$/u.exec(text)?.[1] : text;
  const plain = path === undefined || !isAbsolute(path) || /(?:^|[\\/])\.\.?(?:[\\/]|$)/u.test(path) ? undefined : plainPath(path);
  if (plain === undefined) return undefined;
  const same = (other: string | undefined): other is string => other !== undefined && foldName(plain) === foldName(other);
  if ("run" in anchor) {
    const run = anchor.run.map(plainPath).find(run => run !== undefined && same(join(run, anchor.name, ".git")));
    return run === undefined ? undefined : join(run, anchor.name);
  }
  if (kind === "project") return same(plainPath(anchor.root)) ? anchor.root : undefined;
  const gitDir = anchor.gitDir === undefined ? undefined : plainPath(anchor.gitDir);
  if (gitDir === undefined) return undefined;
  if (kind === "gitDir") return same(gitDir) ? gitDir : undefined;
  const name = basename(plain);
  // A name the file system would read as another one (Windows drops a trailing dot or space) names nothing.
  if (name === "" || /[\\/:]|[. ]$/u.test(name)) return undefined;
  return foldName(dirname(plain)) === foldName(join(gitDir, "worktrees")) ? join(gitDir, "worktrees", name) : undefined;
}

/**
 * Whether a record of the right shape is the one `open` wrote into this very folder: the folder is the directory the record names as
 * itself, by its anchor too, at the one path its run, item and project give, and what it says of the repository is what `open` writes for that run. A
 * record copied or restored anywhere, or edited to name something else, is no record: it directs nothing.
 */
export function recordFits(home: string, run: { path: string; id: NodeId; self: FolderId }, file: WorkspaceRecord): boolean {
  if (file.self !== run.self) return false;
  const root = file.project?.root;
  if (!samePath(run.path, runRootOf(home, root === undefined ? undefined : process.platform === "win32" ? root.toLowerCase() : root, file.itemId, file.runId))) return false;
  if (file.kind === "git") {
    if (file.branch !== runBranch(file.runId) || !OBJECT_ID.test(file.baseCommit ?? "")) return false;
    if (!file.refs.every(ref => ref.name === `refs/heads/${file.branch}` && ref.oid === file.baseCommit)) return false;
  }
  return Object.entries(file.registrations).every(([key, entry]) => runFolderOf(run, key, entry.gitdir) !== undefined);
}

/** The fields that name the owner: a record that differs in one of them from the one seen earlier is another run's. */
export const ownerOf = (file: WorkspaceRecord): string =>
  JSON.stringify([file.v, file.runId, file.itemId, file.kind, file.self, file.project ?? null, file.repo ?? null, file.branch ?? null, file.baseCommit ?? null]);
