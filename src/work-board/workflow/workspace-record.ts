import { basename, dirname, isAbsolute, resolve } from "node:path";
import { isStageId } from "../template-graph.js";
import type { NodeId } from "./owned-fs.js";
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
  return Object.entries(file.registrations).every(([key, entry]) =>
    basename(entry.gitdir) === ".git" && basename(dirname(entry.gitdir)) === (key === JOIN_DIR ? JOIN_DIR : stageDirName(key)));
}

/** The fields that name the owner: a record that differs in one of them from the one seen earlier is another run's. */
export const ownerOf = (file: WorkspaceRecord): string =>
  JSON.stringify([file.v, file.runId, file.itemId, file.kind, file.self, file.project ?? null, file.repo ?? null, file.branch ?? null, file.baseCommit ?? null]);
