import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, parse, sep } from "node:path";

/** Preserve operand components until the filesystem has followed existing links.
 * path.resolve before realpath changes `link/..` into a different target.
 * A new suffix inherits the last observed existing parent's identity, matching
 * the existing file guards' admission-time filesystem snapshot contract.
 */
export function resolveShellFilesystemPath(path: string, cwd: string): string {
  let absolute = isAbsolute(path) ? path : `${cwd}${sep}${path}`;
  if (process.platform === "win32") {
    // Native resolution collapses parents before following directory links.
    // Resolve each preceding prefix before consuming its parent component.
    const { root } = parse(absolute);
    let cursor = root;
    for (const component of absolute.slice(root.length).split(/[\\/]+/)) {
      if (component === "..") cursor = dirname(resolveExistingShellPath(cursor));
      else if (component) cursor = join(cursor, component);
    }
    absolute = cursor;
  }
  return resolveExistingShellPath(absolute);
}

function resolveExistingShellPath(absolute: string): string {
  const suffix: string[] = [];
  let cursor = absolute;
  for (;;) {
    try {
      return join(realpathSync.native(cursor), ...suffix);
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error)
        || (error.code !== "ENOENT" && error.code !== "ENOTDIR")) throw error;
      // A dangling link is an existing entry, not a new regular destination.
      const entry = lstatSync(cursor, { throwIfNoEntry: false });
      if (entry?.isSymbolicLink()) throw error;
      const parent = dirname(cursor);
      if (parent === cursor) throw error;
      suffix.unshift(basename(cursor));
      cursor = parent;
    }
  }
}
