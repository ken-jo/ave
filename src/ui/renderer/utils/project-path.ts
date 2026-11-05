/**
 * Paths under a project root, as the renderer compares them. A root chosen in the folder dialog is stored in its NFC matching
 * form, while listDir builds entry paths from the folder's realpath, which keeps the bytes on disk: a Korean folder made in
 * Finder is NFD there. So a root and the paths under it may spell the root differently. Comparisons normalize both sides to
 * NFC, and components below the root are counted, never cut at the root's string length, so every path handed back is in the
 * path's own spelling (the one listDir and the saved layout use).
 */
import { projectRootKey } from "../../../shared/project-identity.js";

/** NFC, "/" separators, no trailing separator, and a Windows path's case folded (`projectRootKey`). */
function comparisonKey(path: string): string | undefined {
  return projectRootKey(path.normalize("NFC"));
}

/** The end offset of each component of `path`, in `path`'s own spelling. */
function componentEnds(path: string): number[] {
  return [...path.matchAll(/[^\\/]+/gu)].map((match) => match.index + match[0].length);
}

/** How many components `path` has below `root`, or null when it is not `root` or under it (a `..` segment never is). */
function depthUnder(root: string, path: string): number | null {
  const rootKey = comparisonKey(root);
  const pathKey = comparisonKey(path);
  if (rootKey === undefined || pathKey === undefined || pathKey.split("/").includes("..")) return null;
  if (pathKey === rootKey) return 0;
  const prefix = rootKey.endsWith("/") ? rootKey : `${rootKey}/`;
  if (!pathKey.startsWith(prefix)) return null;
  return pathKey.slice(prefix.length).split("/").filter(Boolean).length;
}

/** Whether `path` is `root` or below it. */
export function isInsideRoot(root: string, path: string): boolean {
  return depthUnder(root, path) !== null;
}

/** The components of `path` below `root`, in `path`'s spelling; null when `path` is not under `root`. */
export function componentsUnderRoot(root: string, path: string): string[] | null {
  const depth = depthUnder(root, path);
  if (depth === null) return null;
  const parts = path.split(/[\\/]+/u).filter(Boolean);
  return parts.slice(parts.length - depth);
}

/** The folders from just below `root` down to `path` itself, each a prefix of `path` in its own spelling; [] for `root`
 * itself, null when `path` is not under `root`. */
export function prefixesUnderRoot(root: string, path: string): string[] | null {
  const depth = depthUnder(root, path);
  if (depth === null) return null;
  const ends = componentEnds(path);
  return ends.slice(ends.length - depth).map((end) => path.slice(0, end));
}
