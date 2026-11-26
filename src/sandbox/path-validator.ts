/**
 * Portions adapted from OpenHarness (MIT License)
 * https://github.com/HKUDS/OpenHarness/blob/main/src/openharness/sandbox/path_validator.py
 * Copyright (c) 2025 OpenHarness Contributors
 *
 * Resolve symlinks before checking sandbox and extra-root containment.
 */
import {
  admitLocalPath, admitLocalRoute, admitRouteAncestor, admitShareHop, localFs, type LocalPathVerdict, type LocalRoute,
  windowsSharePath, withLocalityDecision,
} from "../shared/local-path-io.js";
import { classifyWindowsSpelling } from "../shared/windows-path-spelling.js";
import { admitWindowsLookupPaths, windowsObligationsApply } from "../permissions/admitted-obligation.js";
import { listAuthorizedWorkspaceRoots } from "../permissions/workspace-authorized-roots.js";
import {
  basename,
  dirname,
  join,
  resolve as pathResolve,
  win32,
} from "node:path";
import { isPathWithin } from "../plugins/plugin-storage-containment.js";
import { expandLeadingTilde } from "../shared/home-tilde.js";

export interface SandboxValidationResult {
  allowed: boolean;
  reason: string;
}

/** Resolve missing paths through their nearest existing parent so future creation cannot bypass link containment. */
export function validateSandboxPath(
  path: string,
  cwd: string,
  extraAllowed: string[] = [],
): SandboxValidationResult {
  try {
    return withLocalityDecision(() => validateInDecision(path, cwd, extraAllowed));
  } catch (error) {
    // Resolution failures, disappearing entries, and process-backed links cannot authorize access.
    if (error instanceof PathResolutionError) {
      return { allowed: false, reason: error.message };
    }
    throw error;
  }
}

function validateInDecision(path: string, cwd: string, extraAllowed: readonly string[]): SandboxValidationResult {
  const authorities = shareAuthorities(cwd, extraAllowed);
  const resolved = canonicalizeInDecision(path, authorities);
  const resolvedCwd = canonicalizeInDecision(cwd, authorities);

  if (isWithin(resolvedCwd, resolved)) {
    return { allowed: true, reason: "" };
  }

  for (const allowed of extraAllowed) {
    const resolvedAllowed = canonicalizeInDecision(expandLeadingTilde(allowed), authorities);
    if (isWithin(resolvedAllowed, resolved)) {
      return { allowed: true, reason: "" };
    }
  }

  return {
    allowed: false,
    reason: `path ${resolved} is outside the sandbox boundary (${resolvedCwd})`,
  };
}

/** The share roots the caller authorized: the authority to resolve share spellings inside them; nothing else is. */
function shareAuthorities(cwd: string, extraAllowed: readonly string[]): string[] {
  if (!windowsObligationsApply()) return [];
  const cwdShare = windowsSharePath(cwd);
  const authorizedCwd = cwdShare !== undefined && listAuthorizedWorkspaceRoots()
    .some(root => normalizeForBoundaryCompare(win32.normalize(root)) === normalizeForBoundaryCompare(win32.normalize(cwd)));
  return [...(authorizedCwd ? [cwdShare] : []), ...extraAllowed.flatMap(root => windowsSharePath(expandLeadingTilde(root)) ?? [])];
}

/**
 * The physical spelling of an existing target, resolved only on a route proven local or inside an authorized share root;
 * unresolved Windows paths return no physical target.
 */
export function physicalReadTarget(path: string, cwd: string, extraAllowed: readonly string[]): string | undefined {
  return withLocalityDecision(() => {
    const nativeWindows = windowsObligationsApply();
    try {
      if (nativeWindows) {
        const share = windowsSharePath(path);
        return share === undefined ? admitWindowsLookupPaths([path], "preview").get(path)?.target
          : resolveAuthorizedShare(share, shareAuthorities(cwd, extraAllowed));
      }
      const route = filesystemResolution(() => admittedRoute(path));
      return typeof route === "string" ? path : resolveExistingPath(route.verdict);
    } catch (error) {
      if (!(error instanceof PathResolutionError)) throw error;
      return nativeWindows ? undefined : path;
    }
  });
}

class PathResolutionError extends Error {}
const PATH_RESOLUTION_ERRNOS: ReadonlySet<string> = new Set([
  "ENOENT",
  "ENOTDIR",
  "EACCES",
  "EPERM",
  "ELOOP",
  "EINVAL",
  "ENAMETOOLONG",
  "EIO",
  "ESTALE",
]);

function filesystemResolution<T>(read: () => T): T {
  try {
    return read();
  } catch (error) {
    if (
      error instanceof Error && "code" in error &&
      typeof error.code === "string" && PATH_RESOLUTION_ERRNOS.has(error.code)
    ) {
      throw new PathResolutionError(`cannot resolve sandbox path (${error.code})`);
    }
    throw error;
  }
}

function resolveExistingPath(verdict: LocalPathVerdict): string {
  return filesystemResolution(() => localFs.realpathNative(verdict));
}

function readPathEntry(verdict: LocalPathVerdict) {
  return filesystemResolution(() => localFs.lstat(verdict));
}

/**
 * A local route or a direct share spelling. Reaching a share through a local link provides no share authority.
 */
function admittedRoute(absolute: string): LocalRoute | string {
  if (windowsObligationsApply()) {
    const share = windowsSharePath(absolute);
    if (share !== undefined) return share;
  }
  const spelling = classifyWindowsSpelling(absolute);
  if (spelling.kind === "share" && spelling.driveAlias === undefined) {
    throw new PathResolutionError("cannot resolve sandbox path (network or device path)");
  }
  try {
    return admitLocalRoute(spelling.kind === "share" && spelling.driveAlias !== undefined ? spelling.driveAlias : absolute);
  } catch (error) {
    const { code, incomplete, cause } = error as { code?: unknown; incomplete?: unknown; cause?: unknown };
    if (code !== "ENETWORKSHAREPATH") throw error;
    // A walk that could not read an entry reports that entry's own failure.
    if (incomplete === true && cause !== undefined) filesystemResolution(() => { throw cause; });
    throw new PathResolutionError("cannot resolve sandbox path (network or device path)");
  }
}

export function isLexicallyWithinSandbox(path: string, cwd: string, extraAllowed: readonly string[]): boolean {
  return [cwd, ...extraAllowed].some(root => isWithin(pathResolve(expandLeadingTilde(root)), path));
}

/** Pin every local spelling a read check may look up in one launch; the check's own lookups then reuse them within this decision. */
export function pinSandboxLookups(paths: readonly string[]): void {
  if (!windowsObligationsApply()) return;
  const local = paths.map(path => pathResolve(expandLeadingTilde(path))).filter(path => windowsSharePath(path) === undefined);
  admitWindowsLookupPaths(local, "preview");
}

/** How one spelling may be looked up: following its names, or inspecting its own entry. */
interface Lookups {
  follow(path: string): LocalPathVerdict;
  entry(path: string): LocalPathVerdict;
}

function canonicalizeInDecision(path: string, authorities: readonly string[]): string {
  const absolute = pathResolve(expandLeadingTilde(path));
  if (windowsObligationsApply()) {
    const share = windowsSharePath(absolute);
    if (share !== undefined) {
      const resolved = resolveAuthorizedShare(share, authorities);
      if (resolved === undefined) throw new PathResolutionError("cannot resolve sandbox path (outside its share authority)");
      return resolved;
    }
    const local = admitWindowsLookupPaths([absolute], "preview").get(absolute);
    if (local === undefined) throw new PathResolutionError("cannot prove a local sandbox path");
    return local.target;
  }
  const route = admittedRoute(absolute);
  if (typeof route === "string") throw new PathResolutionError("cannot resolve sandbox path (outside its share authority)");
  return resolveFrom(route.verdict.path, {
    follow: ancestor => admitRouteAncestor(route, ancestor),
    entry: ancestor => admitLocalPath(ancestor),
  });
}

function resolveAuthorizedShare(path: string, authorities: readonly string[]): string | undefined {
  for (const root of authorities) {
    if (isWithin(root, path)) return filesystemResolution(() => admitShareHop(path, root));
  }
  return undefined;
}

function resolveFrom(walked: string, lookups: Lookups): string {
  if (localFs.exists(lookups.follow(walked))) {
    return resolveExistingPath(lookups.follow(walked));
  }

  const suffix: string[] = [];
  let cursor = walked;
  while (!localFs.exists(lookups.follow(cursor))) {
    // A dangling link is not a new file under its parent; its entry already exists.
    const entry = readPathEntry(lookups.entry(cursor));
    if (entry?.isSymbolicLink()) return resolveExistingPath(lookups.follow(cursor));
    const parent = dirname(cursor);
    if (parent === cursor) {
      return walked;
    }
    suffix.unshift(basename(cursor));
    cursor = parent;
  }

  const canonicalParent = resolveExistingPath(lookups.follow(cursor));
  return suffix.length > 0 ? join(canonicalParent, ...suffix) : canonicalParent;
}

/** Use parent/candidate order and case-insensitive Windows/macOS checks for paths realpath cannot resolve yet. */
function isWithin(parent: string, child: string): boolean {
  return isPathWithin(normalizeForBoundaryCompare(parent), normalizeForBoundaryCompare(child));
}

function normalizeForBoundaryCompare(path: string): string {
  return process.platform === "win32" || process.platform === "darwin"
    ? path.toLowerCase()
    : path;
}
