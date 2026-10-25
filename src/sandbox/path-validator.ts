/**
 * Portions adapted from OpenHarness (MIT License)
 * https://github.com/HKUDS/OpenHarness/blob/main/src/openharness/sandbox/path_validator.py
 * Copyright (c) 2025 OpenHarness Contributors
 *
 * Resolve symlinks before checking sandbox and extra-root containment.
 */
import { existsSync, lstatSync, realpathSync } from "node:fs";
import {
  basename,
  dirname,
  join,
  resolve as pathResolve,
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
    const resolved = canonicalize(path);
    const resolvedCwd = canonicalize(cwd);

    if (isWithin(resolvedCwd, resolved)) {
      return { allowed: true, reason: "" };
    }

    for (const allowed of extraAllowed) {
      const resolvedAllowed = canonicalize(expandLeadingTilde(allowed));
      if (isWithin(resolvedAllowed, resolved)) {
        return { allowed: true, reason: "" };
      }
    }

    return {
      allowed: false,
      reason: `path ${resolved} is outside the sandbox boundary (${resolvedCwd})`,
    };
  } catch (error) {
    // Resolution failures, disappearing entries, and process-backed links cannot authorize access.
    if (error instanceof PathResolutionError) {
      return { allowed: false, reason: error.message };
    }
    throw error;
  }
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

function resolveExistingPath(path: string): string {
  return filesystemResolution(() => realpathSync.native(path));
}

function readPathEntry(path: string) {
  return filesystemResolution(() => lstatSync(path, { throwIfNoEntry: false }));
}

function canonicalize(path: string): string {
  const absolute = pathResolve(expandLeadingTilde(path));
  if (existsSync(absolute)) {
    return resolveExistingPath(absolute);
  }

  const suffix: string[] = [];
  let cursor = absolute;
  while (!existsSync(cursor)) {
    // A dangling link is not a new file under its parent; its entry already exists.
    const entry = readPathEntry(cursor);
    if (entry?.isSymbolicLink()) return resolveExistingPath(cursor);
    const parent = dirname(cursor);
    if (parent === cursor) {
      return absolute;
    }
    suffix.unshift(basename(cursor));
    cursor = parent;
  }

  const canonicalParent = resolveExistingPath(cursor);
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
