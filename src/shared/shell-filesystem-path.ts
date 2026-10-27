import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, sep } from "node:path";
import { modelShellPath, type ShellPathModel } from "./shell-native-path.js";

// Follow existing links before collapsing operand components: path.resolve changes link/.. targets. Refuse ambiguous link-parent semantics on Windows; new suffixes inherit the observed existing parent identity.
export function resolveShellFilesystemPath(path: string, cwd: string, model: Omit<ShellPathModel, "location"> = { dialect: "native" }): string {
  if (sep === "\\") {
    const absolute = anchorFilesystemPath(path, cwd, model);
    const { normalizedPath, volumeRoot: root } = modelShellPath(absolute, { dialect: "native" });
    const lexical = resolveExistingShellPath(normalizedPath);
    // Children can collapse parents before following links or follow each prefix first. Neither reading alone establishes the operand's identity.
    const physical = resolveExistingShellPath(physicalParentPath(absolute, root));
    if (lexical !== physical) {
      throw Object.assign(new Error("Shell path has ambiguous directory-link parents"), { code: "EAMBIGUOUSLINKPARENT" });
    }
    return physical;
  }
  return resolveExistingShellPath(path, cwd);
}

function physicalParentPath(absolute: string, root: string): string {
  let cursor = root;
  for (const component of absolute.slice(root.length).split(/[\\/]+/)) {
    if (component === "..") cursor = cursor === root ? root : dirname(resolveExistingShellPath(cursor));
    else if (component) cursor = join(cursor, component);
  }
  return cursor;
}

/** Win32 APIs fold ".." lexically; this reading follows each existing link before its "..". */
export function physicalParentReading(absolute: string): string {
  return physicalParentPath(absolute, modelShellPath(absolute, { dialect: "native" }).volumeRoot);
}

function resolveExistingShellPath(path: string, cwd = ""): string {
  return resolveFilesystemPath(path, cwd, Number.POSITIVE_INFINITY).path;
}

// Resolve through the nearest existing ancestor without rewriting path bytes.
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
  /** POSIX: a `..` after a missing component, whose meaning depends on what that component becomes. Win32 normalizes `..` lexically before opening, so there the resolved path is already the opened one and this stays false. */
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

function anchorFilesystemPath(path: string, cwd: string, model: Omit<ShellPathModel, "location"> = { dialect: "native" }): string {
  if (sep === "\\") {
    const result = modelShellPath(path, { ...model, location: cwd });
    if (result.nativePath === undefined) throw Object.assign(new Error("Shell path namespace is unresolved"), { code: "EUNRESOLVEDSHELLPATH" });
    return result.nativePath;
  }
  if (!isAbsolute(path)) return `${cwd}${sep}${path}`;
  return path;
}

function resolveFilesystemPath(path: string, cwd: string, maxMissingAncestors: number): BasicPhysicalFilesystemPathResolution {
  if (maxMissingAncestors < 0 || (!Number.isSafeInteger(maxMissingAncestors) && maxMissingAncestors !== Number.POSITIVE_INFINITY)) {
    throw new RangeError("Missing ancestor limit must be a non-negative integer");
  }
  const anchored = anchorFilesystemPath(path, cwd);
  const absolute = sep === "\\"
    ? modelShellPath(anchored, { dialect: "native" }).normalizedPath : anchored;
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
  if (absolute) path = anchorFilesystemPath(path, cwd);
  const root = absolute ? modelShellPath(path, { dialect: "native", location: cwd }).volumeRoot : cwd;
  const remainder = absolute ? path.slice(root.length) : path;
  const components = remainder.split(sep === "\\" ? /[\\/]+/u : /\/+/u).filter(Boolean);
  if (components.length > maxComponents) {
    throw new Error("Filesystem path exceeds the component limit");
  }
  let physicalParent = realpathSync.native(root);
  const routingSymlinkPaths: string[] = [];
  for (const component of components) {
    if (component === ".") continue;
    if (component === "..") {
      if (sep === "\\"
        && physicalParent.length <= modelShellPath(physicalParent, { dialect: "native" }).volumeRoot.length) continue;
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
