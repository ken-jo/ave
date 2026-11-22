/** "Show in folder view" for a surface that knows a file's absolute path but not which project it belongs to (a chat diff
 * card). Main names the registered projects; the deepest one that contains the path is the folder view's project. */
import { requestFolderViewAt } from "../../utils/app-shell-requests.js";

const ABSOLUTE_PATH = /^(?:\/|[A-Za-z]:[\\/]|\\\\)/u;

/** A tool result can carry a path the model wrote as it liked; only an absolute one names a file the folder view can find. */
export function canShowInFolderView(path: string): boolean {
  return ABSOLUTE_PATH.test(path);
}

function contains(root: string, path: string): boolean {
  const base = root.replace(/[\\/]+$/u, "");
  if (!path.startsWith(base)) return false;
  const next = path.charAt(base.length);
  return next === "/" || next === "\\";
}

/** The registered project that holds `path`: the deepest one when projects nest. Null when none does. */
export function projectRootOf(path: string, roots: readonly string[]): string | null {
  let best: string | null = null;
  for (const root of roots) {
    if (contains(root, path) && (best === null || root.length > best.length)) best = root;
  }
  return best;
}

/** Open a folder view with `path` selected. Resolves to false when no project holds the path or no shell can show it. */
export async function showInFolderView(path: string): Promise<boolean> {
  const listed = await window.ave.workspace.listRoots();
  const projectRoot = listed.ok ? projectRootOf(path, (listed.roots ?? []).map((root) => root.path)) : null;
  return projectRoot !== null && requestFolderViewAt({ path, projectRoot });
}
