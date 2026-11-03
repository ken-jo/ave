/** Folder view state (Finder column view) as a pure reducer plus the small layout rules the view measures against. */
import type { WorkspaceDirEntry, WorkspaceListDirResult } from "../../../../ipc/domains/workspace.js";
import { resolveFilePreviewRoute } from "../../preview/preview-renderers.js";
import { resolveGrammar } from "../../hooks/use-highlighted-code.js";
import { isComposerImageExtension } from "../../../../shared/composer-image-input.js";

export type FolderEntry = WorkspaceDirEntry;
type FolderListError = NonNullable<WorkspaceListDirResult["error"]>;

export interface FolderColumn {
  dir: string;
  status: "loading" | "ok" | "error";
  entries: readonly FolderEntry[];
  truncated: boolean;
  /** Entries the sensitive-path floor left out; the empty copy says "no hidden files" only when this is 0. */
  hidden: number;
  error?: FolderListError;
}

export interface FolderState {
  root: string;
  columns: readonly FolderColumn[];
  /** `selected[i]` is the entry chosen in column i; a column right of a selection is that folder's listing. */
  selected: readonly FolderEntry[];
  /** Folders whose listing was refused, shown with a lock in their parent column. */
  locked: ReadonlySet<string>;
}

export type FolderAction =
  | { type: "loaded"; dir: string; result: WorkspaceListDirResult }
  | { type: "select"; column: number; entry: FolderEntry }
  | { type: "retry"; dir: string }
  | { type: "truncate"; column: number };

function loadingColumn(dir: string): FolderColumn {
  return { dir, status: "loading", entries: [], truncated: false, hidden: 0 };
}

export function initialFolderState(root: string): FolderState {
  return { root, columns: [loadingColumn(root)], selected: [], locked: new Set() };
}

export function folderReducer(state: FolderState, action: FolderAction): FolderState {
  switch (action.type) {
    case "loaded": {
      const index = state.columns.findIndex((column) => column.dir === action.dir);
      // A listing for a column the user has since closed is dropped.
      if (index < 0) return state;
      const { result } = action;
      const column: FolderColumn = result.ok
        ? { dir: action.dir, status: "ok", entries: result.entries ?? [], truncated: result.truncated === true, hidden: result.hidden ?? 0 }
        : { dir: action.dir, status: "error", entries: [], truncated: false, hidden: 0, error: result.error ?? "read-failed" };
      const locked = new Set(state.locked);
      if (!result.ok && result.error === "permission-denied") locked.add(action.dir);
      else locked.delete(action.dir);
      return { ...state, columns: state.columns.map((each, at) => (at === index ? column : each)), locked };
    }
    case "select": {
      if (action.column < 0 || action.column >= state.columns.length) return state;
      // Choosing anything in an earlier column closes every column after it.
      const kept = state.columns.slice(0, action.column + 1);
      const selected = [...state.selected.slice(0, action.column), action.entry];
      const columns = action.entry.type === "directory" ? [...kept, loadingColumn(action.entry.path)] : kept;
      return { ...state, columns, selected };
    }
    case "retry":
      return { ...state, columns: state.columns.map((column) => (column.dir === action.dir ? loadingColumn(action.dir) : column)) };
    case "truncate": {
      // Back to column `column` as the deepest one: its own selection stays, later columns close.
      if (action.column < 0 || action.column >= state.columns.length) return state;
      return { ...state, columns: state.columns.slice(0, action.column + 1), selected: state.selected.slice(0, action.column) };
    }
  }
}

/** The file (or link) the viewer shows: the deepest selection when it is not a folder. */
export function viewerEntry(state: FolderState): FolderEntry | null {
  const last = state.selected[state.selected.length - 1];
  return last && last.type !== "directory" ? last : null;
}

/** The folder the status line and "find in this folder" talk about: the deepest open column. */
export function currentFolder(state: FolderState): string {
  return state.columns[state.columns.length - 1]?.dir ?? state.root;
}

/** Column width the threshold below is computed from; the view lays columns out at exactly this width. */
export const FOLDER_COLUMN_WIDTH = 220;
/** The narrowest file viewer worth showing beside columns. */
export const FOLDER_VIEWER_MIN_WIDTH = 380;

/** Below the viewer's minimum plus two columns, an open file replaces the columns (case 37). */
export function viewerReplacesColumns(width: number): boolean {
  return width < FOLDER_VIEWER_MIN_WIDTH + 2 * FOLDER_COLUMN_WIDTH;
}

/** What a key does in a column row. Arrow keys and Enter only; anything else is left to the browser. */
export type FolderKeyIntent = "up" | "down" | "open" | "back" | "preview" | null;

export function folderKeyIntent(key: string): FolderKeyIntent {
  switch (key) {
    case "ArrowUp": return "up";
    case "ArrowDown": return "down";
    case "ArrowRight":
    case "Enter": return "open";
    case "ArrowLeft": return "back";
    case " ": return "preview";
    default: return null;
  }
}

/** Path segments under the project root, root name first. */
export function pathSegments(root: string, path: string): string[] {
  const rootName = root.split(/[\\/]/).filter(Boolean).pop() ?? root;
  if (path === root) return [rootName];
  const rest = path.startsWith(root) ? path.slice(root.length) : path;
  return [rootName, ...rest.split(/[\\/]/).filter(Boolean)];
}

/** Keep the first segment and the last `tail`; the hidden middle is returned for the "…" menu (case 24). */
export function collapseMiddle<T>(items: readonly T[], tail = 3): { head: T[]; hidden: T[]; tail: T[] } {
  if (items.length <= tail + 2) return { head: [...items], hidden: [], tail: [] };
  return { head: items.slice(0, 1), hidden: items.slice(1, items.length - tail), tail: items.slice(items.length - tail) };
}

/** Columns fully scrolled out on the left, for "N more columns on the left". */
export function columnsHiddenLeft(columnRightEdges: readonly number[], scrollLeft: number): number {
  return columnRightEdges.filter((right) => right <= scrollLeft + 1).length;
}

/** The project-relative path the info card and status line show. */
export function relativeToRoot(root: string, path: string): string {
  return pathSegments(root, path).slice(1).join("/");
}

export type FolderFileKind = "code" | "markdown" | "image" | "pdf" | "page" | "table" | "database" | "design" | "log" | "text" | "unknown";

const DATABASE_EXTENSIONS = new Set(["sqlite", "sqlite3", "db"]);
const DESIGN_EXTENSIONS = new Set(["psd", "sketch", "fig", "ai", "xd"]);
const TEXT_EXTENSIONS = new Set(["txt", "csv", "tsv", "env"]);

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/** Icon and label kind from the extension alone, using the preview route and highlighter tables; main never sniffs contents
 * for a listing (plan D6). */
export function folderFileKind(name: string): FolderFileKind {
  const ext = extensionOf(name);
  if (ext === "md" || ext === "markdown") return "markdown";
  if (ext === "log") return "log";
  if (isComposerImageExtension(ext)) return "image";
  const route = resolveFilePreviewRoute(name);
  if (route.kind === "table") return "table";
  if (route.kind === "page") return route.format === "pdf" ? "pdf" : "page";
  if (DATABASE_EXTENSIONS.has(ext)) return "database";
  if (DESIGN_EXTENSIONS.has(ext)) return "design";
  if (resolveGrammar(ext) !== null) return "code";
  if (TEXT_EXTENSIONS.has(ext)) return "text";
  return "unknown";
}

/** The info card's and viewer's kind label, one literal key per kind so the catalog check sees every key. */
export const FOLDER_KIND_LABEL_KEYS: Record<FolderFileKind, string> = {
  code: "folderView.kindCode",
  markdown: "folderView.kindMarkdown",
  image: "folderView.kindImage",
  pdf: "folderView.kindPdf",
  page: "folderView.kindPage",
  table: "folderView.kindTable",
  database: "folderView.kindDatabase",
  design: "folderView.kindDesign",
  log: "folderView.kindLog",
  text: "folderView.kindText",
  unknown: "folderView.kindUnknown",
};
