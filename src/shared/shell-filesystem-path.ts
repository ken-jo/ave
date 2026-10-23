import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, parse, sep } from "node:path";

/** Preserve operand components until the filesystem has followed existing links.
 * path.resolve before realpath changes `link/..` into a different target.
 * A new suffix inherits the last observed existing parent's identity, matching
 * the existing file guards' admission-time filesystem snapshot contract.
 */
export function resolveShellFilesystemPath(path: string, cwd: string): string {
  return resolveFilesystemPath(path, cwd, Number.POSITIVE_INFINITY).path;
}

/** Resolve through the nearest existing ancestor without rewriting path bytes. */
export function resolvePhysicalFilesystemPath(
  path: string,
  cwd: string,
  maxMissingAncestors: number,
): string {
  return resolveFilesystemPath(path, cwd, maxMissingAncestors).path;
}

export interface PhysicalFilesystemPathResolution {
  path: string;
  firstMissingPath: string | undefined;
  unresolvedParentTraversal: boolean;
  routingSymlinkPaths: readonly string[];
}

export function inspectPhysicalFilesystemPath(
  path: string,
  cwd: string,
  maxMissingAncestors: number,
): PhysicalFilesystemPathResolution {
  return {
    ...resolveFilesystemPath(path, cwd, maxMissingAncestors),
    routingSymlinkPaths: inspectRoutingSymlinks(path, cwd, maxMissingAncestors),
  };
}

type BasicPhysicalFilesystemPathResolution = Omit<PhysicalFilesystemPathResolution, "routingSymlinkPaths">;

function resolveFilesystemPath(path: string, cwd: string, maxMissingAncestors: number): BasicPhysicalFilesystemPathResolution {
  if (maxMissingAncestors < 0 || (!Number.isSafeInteger(maxMissingAncestors) && maxMissingAncestors !== Number.POSITIVE_INFINITY)) {
    throw new RangeError("Missing ancestor limit must be a non-negative integer");
  }
  const absolute = isAbsolute(path) ? path : `${cwd}${sep}${path}`;
  const suffix: string[] = [];
  let cursor = absolute;
  for (;;) {
    try {
      const physicalAncestor = realpathSync.native(cursor);
      const unresolvedParentTraversal = suffix.includes("..");
      return {
        path: join(physicalAncestor, ...suffix),
        firstMissingPath: suffix.length > 0 && !unresolvedParentTraversal
          ? join(physicalAncestor, suffix[0]!)
          : undefined,
        unresolvedParentTraversal,
      };
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error)
        || (error.code !== "ENOENT" && error.code !== "ENOTDIR")) throw error;
      if (suffix.length >= maxMissingAncestors) {
        throw new Error("Filesystem path exceeds the missing ancestor limit");
      }
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

function inspectRoutingSymlinks(path: string, cwd: string, maxComponents: number): string[] {
  const absolute = isAbsolute(path);
  const root = absolute ? parse(path).root : cwd;
  const remainder = absolute ? path.slice(root.length) : path;
  const components = remainder.split(process.platform === "win32" ? /[\\/]+/u : /\/+/u).filter(Boolean);
  if (components.length > maxComponents) {
    throw new Error("Filesystem path exceeds the component limit");
  }
  let physicalParent = realpathSync.native(root);
  const routingSymlinkPaths: string[] = [];
  for (const component of components) {
    if (component === ".") continue;
    if (component === "..") {
      physicalParent = dirname(physicalParent);
      continue;
    }
    const candidate = join(physicalParent, component);
    const entry = lstatSync(candidate, { throwIfNoEntry: false });
    if (entry === undefined) break;
    if (entry.isSymbolicLink()) routingSymlinkPaths.push(candidate);
    physicalParent = realpathSync.native(candidate);
  }
  return routingSymlinkPaths;
}
