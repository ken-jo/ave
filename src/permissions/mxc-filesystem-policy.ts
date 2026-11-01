import { win32 as winPath } from "node:path";
import { isWindowsPathAtOrUnder, type MxcFilesystemGrants } from "./mxc-windows.js";

function normalizePath(value: string): string {
  const normalized = winPath.normalize(value);
  if (!/^[a-z]:\\/i.test(normalized) || value.includes("\0")) {
    throw new Error("Container filesystem policy requires absolute drive paths");
  }
  return normalized;
}

/** Query/list access resolves admitted entries without granting ancestor file contents.
 * Query grants may expose descendant names; callers must disclose that residual.
 * Inputs are canonical, admitted directory roots, never the shared account's grants.
 */
export function synthesizeMxcAncestorQueries(
  grants: MxcFilesystemGrants,
  entryDirectories: readonly string[] = [],
): readonly string[] {
  const roots = [...grants.readwrite, ...grants.readonly].map(normalizePath);
  const denies = grants.denied.map(normalizePath);
  if (roots.some((root) => root.toLowerCase() === winPath.parse(root).root.toLowerCase())) {
    throw new Error("Container filesystem policy refuses volume-root content grants");
  }
  const entries = entryDirectories.map(normalizePath);
  if (entries.some((entry) => !roots.some((root) => isWindowsPathAtOrUnder(entry, root)))) {
    throw new Error("Container entry directory must already be admitted");
  }
  if ([...roots, ...entries].some((entry) => denies.some((deny) => isWindowsPathAtOrUnder(entry, deny)))) {
    throw new Error("Container admitted root or entry conflicts with a denied path");
  }
  const queries = new Map<string, string>();

  for (const directory of [...roots, ...entries]) {
    let parent = winPath.dirname(directory);
    for (;;) {
      if (!roots.some((root) => isWindowsPathAtOrUnder(parent, root))) {
        if (denies.some((deny) => isWindowsPathAtOrUnder(parent, deny))) {
          throw new Error("Container ancestor query conflicts with a denied path");
        }
        queries.set(parent.toLowerCase(), parent);
      }
      const next = winPath.dirname(parent);
      if (next === parent) break;
      parent = next;
    }
  }
  return [...queries.values()];
}
