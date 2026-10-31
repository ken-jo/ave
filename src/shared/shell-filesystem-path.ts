import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, sep, win32 } from "node:path";
import { isWindowsNetworkOrDevicePath, modelShellPath, type ShellPathModel } from "./shell-native-path.js";

function rejectNetworkOrDevicePath(path: string, platform: NodeJS.Platform = process.platform): void {
  if (isWindowsNetworkOrDevicePath(path, platform)) {
    throw Object.assign(new Error(`Shell path requires network or device authority: ${path}`), { code: "ENETWORKSHAREPATH", path });
  }
}

const MAX_FILESYSTEM_SYMLINK_HOPS = 64;

/** Check each link from a local volume root before any syscall can follow it. */
export function verifyLocalFilesystemChain(path: string, platform: NodeJS.Platform = process.platform, maxSymlinkHops = MAX_FILESYSTEM_SYMLINK_HOPS, facts?: {
  knownPath: (path: string) => { canonical: string; missing: boolean } | undefined;
  onLocalPath: (path: string, canonical: string, missing: boolean) => void;
}): void {
  if (platform !== "win32") return;
  let hops = 0;
  const walk = (absolute: string): string | undefined => {
    rejectNetworkOrDevicePath(absolute, platform);
    // Normalize the accepted device spelling before deriving or slicing its root.
    const normalized = (sep === "\\" ? modelShellPath(absolute, { dialect: "native" }).normalizedPath : win32.normalize(absolute))
      .replace(/^\\\\\?\\(?=[A-Za-z]:[\\/])/, "");
    const root = sep === "\\" ? modelShellPath(normalized, { dialect: "native" }).volumeRoot : win32.parse(normalized).root;
    rejectNetworkOrDevicePath(root, platform);
    const components = normalized.slice(root.length).split(/[\\/]+/u).filter(Boolean);
    const complete = facts?.knownPath(normalized);
    if (complete !== undefined) return complete.missing ? undefined : complete.canonical;
    let lexicalParent = root;
    let remaining = 0;
    let known = facts?.knownPath(root);
    while (known !== undefined && !known.missing && remaining < components.length) {
      const prefix = win32.join(lexicalParent, components[remaining]!);
      const next = facts?.knownPath(prefix);
      if (next === undefined) break;
      lexicalParent = prefix;
      known = next;
      remaining++;
    }
    if (known?.missing) return undefined;
    let physicalParent = known?.canonical ?? realpathSync.native(root);
    facts?.onLocalPath(lexicalParent, physicalParent, false);
    for (const component of components.slice(remaining)) {
      if (component === ".") continue;
      if (component === "..") { physicalParent = win32.dirname(physicalParent); continue; }
      const candidate = win32.join(physicalParent, component);
      lexicalParent = win32.join(lexicalParent, component);
      const entry = lstatSync(candidate, { throwIfNoEntry: false });
      if (entry === undefined) {
        facts?.onLocalPath(lexicalParent, candidate, true);
        return undefined;
      }
      if (entry.isSymbolicLink()) {
        const target = readlinkSync(candidate);
        rejectNetworkOrDevicePath(target, platform);
        const effectiveTarget = win32.resolve(physicalParent, target);
        rejectNetworkOrDevicePath(effectiveTarget, platform);
        if (++hops > maxSymlinkHops) throw new Error("Filesystem path exceeds the component limit");
        // A local spelling can itself contain links. Inspect that entire chain
        // before realpath is allowed to follow this entry.
        if (walk(effectiveTarget) === undefined) return undefined;
        physicalParent = realpathSync.native(candidate);
      } else {
        // The physical parent and this non-link entry establish the next parent.
        physicalParent = candidate;
      }
      facts?.onLocalPath(lexicalParent, physicalParent, false);
    }
    return physicalParent;
  };
  try { walk(path); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENETWORKSHAREPATH") throw error;
    // Leave I/O failures to the caller's existing resolution behavior.
  }
}

// Follow existing links before collapsing operand components: path.resolve changes link/.. targets. Refuse ambiguous link-parent semantics on Windows; new suffixes inherit the observed existing parent identity.
export function resolveShellFilesystemPath(path: string, cwd: string, model: Omit<ShellPathModel, "location"> = { dialect: "native" }): string {
  rejectNetworkOrDevicePath(path);
  if (sep === "\\") {
    const absolute = anchorFilesystemPath(path, cwd, model);
    rejectNetworkOrDevicePath(absolute);
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
  rejectNetworkOrDevicePath(absolute);
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
  rejectNetworkOrDevicePath(path);
  if (maxMissingAncestors < 0 || (!Number.isSafeInteger(maxMissingAncestors) && maxMissingAncestors !== Number.POSITIVE_INFINITY)) {
    throw new RangeError("Missing ancestor limit must be a non-negative integer");
  }
  const anchored = anchorFilesystemPath(path, cwd);
  rejectNetworkOrDevicePath(anchored);
  const absolute = sep === "\\"
    ? modelShellPath(anchored, { dialect: "native" }).normalizedPath : anchored;
  verifyLocalFilesystemChain(absolute);
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
  rejectNetworkOrDevicePath(path);
  const absolute = isAbsolute(path);
  if (absolute) path = anchorFilesystemPath(path, cwd);
  const root = absolute ? modelShellPath(path, { dialect: "native", location: cwd }).volumeRoot : cwd;
  rejectNetworkOrDevicePath(root);
  verifyLocalFilesystemChain(absolute ? path : anchorFilesystemPath(path, cwd));
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
    if (entry.isSymbolicLink()) {
      if (process.platform === "win32") {
        const target = readlinkSync(candidate);
        rejectNetworkOrDevicePath(target);
        const effectiveTarget = win32.resolve(physicalParent, target);
        rejectNetworkOrDevicePath(effectiveTarget);
        verifyLocalFilesystemChain(effectiveTarget);
      }
      routingSymlinkPaths.push(candidate);
    }
    physicalParent = realpathSync.native(candidate);
  }
  return routingSymlinkPaths;
}
