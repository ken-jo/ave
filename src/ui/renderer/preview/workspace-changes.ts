import { countFileChangeLines } from "../../../shared/file-change-counts.js";
import type { TurnChangeReview, TurnReviewFile } from "../../../shared/turn-change-review.js";
import { isFileChangeOperation, type ChatPreviewTarget, type WorkspaceFileItem } from "./preview-targets.js";

export type WorkspaceFileFilter = "all" | "changed" | "session";
export interface WorkspaceChangeFile {
  path: string;
  displayPath: string;
  operation: WorkspaceFileItem["operation"];
  added: number;
  removed: number;
  countsKnown: boolean;
  latest: boolean;
  file?: WorkspaceFileItem;
  review?: TurnReviewFile;
  turnId?: string;
}
export interface WorkspaceChanges {
  onRefresh?: () => void;
  workspaceRoot?: string;
  latestFiles: WorkspaceChangeFile[];
  changedFiles: WorkspaceChangeFile[];
  sessionFiles: readonly WorkspaceFileItem[];
  added: number;
  removed: number;
  countsKnown: boolean;
  review: TurnChangeReview | null;
}
export interface FileWorkspaceReveal { token: number; path: string }

/** Normalize path identity for display joins only; main independently authorizes every read. */
export function workspaceFilePath(path: string, workspaceRoot?: string): string {
  let source = path.replace(/\\/g, "/");
  const root = workspaceRoot?.replace(/\\/g, "/");
  if (!/^(?:\/|[a-zA-Z]:\/)/.test(source) && root) source = `${root}/${source}`;
  const prefix = source.startsWith("/") ? "/" : /^[a-zA-Z]:\//.test(source) ? source.slice(0, 3) : "";
  const segments: string[] = [];
  for (const part of source.slice(prefix.length).split("/")) {
    if (!part || part === ".") continue;
    if (part === ".." && segments.length > 0 && segments.at(-1) !== "..") segments.pop();
    else if (part !== ".." || !prefix) segments.push(part);
  }
  return prefix + segments.join("/");
}
function displayPath(path: string, workspaceRoot?: string): string {
  const root = workspaceRoot ? workspaceFilePath(workspaceRoot).replace(/\/$/, "") : undefined;
  if (root && path.startsWith(`${root}/`)) return path.slice(root.length + 1);
  return /^(?:\/|[a-zA-Z]:\/)/.test(path) ? `…/${path.slice(path.lastIndexOf("/") + 1)}` : path;
}
/** One derived view joins session artifacts and their existing diff targets with the host's latest-turn capture. */
export function deriveWorkspaceChanges({ files, targets, workspaceRoot, review }: {
  files: readonly WorkspaceFileItem[];
  targets: readonly ChatPreviewTarget[];
  workspaceRoot?: string;
  review: TurnChangeReview | null;
}): WorkspaceChanges {
  workspaceRoot = review?.workspaceRoot ?? workspaceRoot;
  const byPath = new Map<string, WorkspaceChangeFile>();
  const sessionByPath = new Map(files.map((file) => [workspaceFilePath(file.path, workspaceRoot), file]));
  const diffs = new Map<string, Extract<ChatPreviewTarget, { kind: "diff" }>>();
  for (const target of targets) if (target.kind === "diff") diffs.set(workspaceFilePath(target.path, workspaceRoot), target);
  for (const file of files) {
    if (!isFileChangeOperation(file.operation)) continue;
    const path = workspaceFilePath(file.path, workspaceRoot);
    const diff = diffs.get(path)?.diff;
    const counts = diff?.hunks.map((hunk) => countFileChangeLines(hunk.oldText, hunk.newText));
    byPath.set(path, { path, displayPath: displayPath(path, workspaceRoot), operation: file.operation,
      added: counts?.reduce((total, count) => total + count.added, 0) ?? 0,
      removed: counts?.reduce((total, count) => total + count.removed, 0) ?? 0,
      countsKnown: diff !== undefined && !diff.truncated && counts!.every((count) => count.exact), latest: false, file });
  }
  const latestFiles = (review?.files ?? []).map((captured): WorkspaceChangeFile => {
    const path = workspaceFilePath(captured.path, workspaceRoot);
    const file = sessionByPath.get(path);
    const changed: WorkspaceChangeFile = { path, displayPath: captured.path,
      operation: file?.operation === "move" ? "move" : captured.operation,
      added: captured.added, removed: captured.removed, countsKnown: captured.countsKnown,
      latest: true, ...(file ? { file } : {}), review: captured, turnId: review!.turnId };
    byPath.set(path, changed);
    return changed;
  });
  const sessionFiles = [...new Map(files.filter((file) => !isFileChangeOperation(file.operation))
    .map((file) => [workspaceFilePath(file.path, workspaceRoot), file])).values()];
  return { workspaceRoot, latestFiles, changedFiles: [...byPath.values()], sessionFiles, review,
    added: latestFiles.reduce((total, file) => total + file.added, 0),
    removed: latestFiles.reduce((total, file) => total + file.removed, 0),
    countsKnown: latestFiles.every((file) => file.countsKnown) };
}
