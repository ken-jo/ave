import { createHash } from "node:crypto";
import { basename, join } from "node:path";
import { isStageId } from "../template-graph.js";

/** `<aveHome>/worktrees/<project>/<run>/<stage>`: one folder per stage. The `_` names are host-only and can never be stage ids. */
export const WORKTREES_DIR = "worktrees";
export const JOIN_DIR = "_join";
export const OUT_DIR = "_out";
export const RUN_FILE = "_run.json";

const sha256 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

/** `<name≤24, [a-z0-9-]>-<8 hex of sha256(canonical root)>`, or `board-<itemId>` with no project. */
export function projectSlug(canonicalRoot: string | undefined, itemId: number): string {
  if (canonicalRoot === undefined) return `board-${itemId}`;
  const root = canonicalRoot.replace(/\\/g, "/").replace(/\/+$/u, "");
  const name = basename(root).toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 24).replace(/-+$/u, "") || "project";
  return `${name}-${sha256(root).slice(0, 8)}`;
}

/** 12 characters of `[a-z0-9]`; the run id itself never enters a path or a branch name. */
export function runSlug(runId: string): string {
  return sha256(runId).slice(0, 12);
}

/** The stage id, which the template graph bounds to `^[a-z0-9][a-z0-9-]{0,31}$`. */
export function stageDirName(stageId: string): string {
  if (!isStageId(stageId)) throw new Error("stage id cannot name a workspace folder");
  return stageId;
}

export function runBranch(runId: string): string {
  return `ave/workflow/${runSlug(runId)}`;
}

export function runRootOf(aveHome: string, canonicalProjectRoot: string | undefined, itemId: number, runId: string): string {
  return join(aveHome, WORKTREES_DIR, projectSlug(canonicalProjectRoot, itemId), runSlug(runId));
}
