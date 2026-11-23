import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { isStageId } from "../template-graph.js";
import { type NodeId, realDirId } from "./owned-fs.js";
import { JOIN_DIR, runBranch, runRootOf, stageDirName } from "./workspace-layout.js";

export interface OutputFile { path: string; sha256: string; size: number }

/** One worktree registration the run made in the repository, as it was when the host read it from the folder's `.git` file. */
export interface Registration {
  admin: string;
  id: NodeId;
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
  self: NodeId;
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
const located = (value: unknown, path: string): boolean => isObject(value) && absolute(value[path]) && isNodeId(value.id);

/** The shape alone: every field a later call relies on, and no field the record's kind does not carry. */
export function isWorkspaceRecord(value: unknown): value is WorkspaceRecord {
  if (!isObject(value) || value.v !== 2 || typeof value.runId !== "string" || value.runId === "" || !Number.isInteger(value.itemId)) return false;
  if ((value.kind !== "git" && value.kind !== "folder") || !isNodeId(value.self)) return false;
  if (!optional(value.project, project => located(project, "root")) || !optional(value.repo, repo => located(repo, "gitDir"))) return false;
  if (![value.branch, value.baseCommit, value.merging].every(field => optional(field, text)) || !optional(value.ignoreRules, flag => typeof flag === "boolean")) return false;
  if (!optional(value.joinDir, isNodeId) || !optional(value.outDir, isNodeId)) return false;
  if (!Array.isArray(value.refs) || !isObject(value.registrations) || !isObject(value.stages) || !isObject(value.joins) || !isObject(value.out)) return false;
  const given = (...fields: unknown[]): boolean => fields.some(field => field !== undefined);
  if (value.kind === "git") {
    if ([value.project, value.repo, value.branch, value.baseCommit].includes(undefined) || given(value.outDir, value.ignoreRules) || value.refs.length > 1) return false;
  } else if (given(value.repo, value.branch, value.baseCommit, value.merging, value.joinDir) || value.refs.length > 0 || Object.keys(value.registrations).length > 0) return false;
  if (!value.refs.every(ref => isObject(ref) && text(ref.name) && text(ref.oid))) return false;
  if (!Object.entries(value.registrations).every(([key, entry]) => (key === JOIN_DIR || isStageId(key)) && located(entry, "admin") && isObject(entry) && absolute(entry.gitdir))) return false;
  return Object.entries(value.stages).every(([id, entry]) => isStageId(id) && isObject(entry) && typeof entry.ready === "boolean" && Number.isInteger(entry.attempt)
    && optional(entry.dir, isNodeId) && (entry.ready !== true || entry.dir !== undefined));
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
 * home). So the run folder is told by which directory it is, and only the folder's own name is compared; a path whose run folder
 * cannot be identified names nothing.
 *
 * A record is read from disk and may name any path, so a path on a network share is looked at only when its text puts it in the run
 * folder as that folder really is: a home on a share keeps its registrations, and no other share is ever asked anything. A device
 * path is refused the same way. Known limit, on the closed side: the same share under another spelling of its server (short name,
 * full name, address) is refused.
 */
export function runFolderOf(run: { path: string; id: NodeId }, key: string, gitdir: string): string | undefined {
  const plain = plainPath(gitdir);
  if (plain === undefined || basename(plain) !== ".git") return undefined;
  const folder = dirname(plain);
  if (foldName(basename(folder)) !== foldName(key === JOIN_DIR ? JOIN_DIR : stageDirName(key))) return undefined;
  if (process.platform === "win32" && plain.startsWith("\\\\")) {
    let real: string | undefined;
    try {
      real = plainPath(realpathSync.native(run.path));
    } catch {
      return undefined;
    }
    if (real === undefined || foldName(dirname(folder)) !== foldName(real)) return undefined;
  }
  return realDirId(dirname(folder)) === run.id ? folder : undefined;
}

/**
 * The name of a registration's admin folder, when its path puts it right inside the repository's `worktrees`; undefined for any other.
 * The path comes from a stage folder's `.git` file or from the record, and either may name anything. So it is made plain text first,
 * and its last part must be one plain name. A network path is then taken only when its text is `worktrees` of the directory the record
 * gives as the repository's, so this path asks nothing of any other share; a device path names nothing. The directory is asked which
 * one it is only after that. The record's own repository path is the caller's to check. Known limit, on the closed side: another
 * spelling of the share's server is refused, and so is a share path when the repository was reached by a drive letter.
 */
export function adminNameIn(gitDir: string, worktrees: NodeId, admin: string): string | undefined {
  const plain = plainPath(admin);
  if (plain === undefined) return undefined;
  const name = basename(plain);
  if (name === "" || name === "." || name === ".." || /[\\/:]/u.test(name)) return undefined;
  const parent = dirname(plain);
  if (process.platform === "win32" && plain.startsWith("\\\\")) {
    const own = plainPath(join(gitDir, "worktrees"));
    if (own === undefined || foldName(parent) !== foldName(own)) return undefined;
  }
  return realDirId(parent) === worktrees ? name : undefined;
}

/**
 * Whether a record of the right shape is the one `open` wrote into this very folder: the folder is the directory the record names as
 * itself, at the one path its run, item and project give, and what it says of the repository is what `open` writes for that run. A
 * record copied or restored anywhere, or edited to name something else, is no record: it directs nothing.
 */
export function recordFits(home: string, run: { path: string; id: NodeId }, file: WorkspaceRecord): boolean {
  if (file.self !== run.id) return false;
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
