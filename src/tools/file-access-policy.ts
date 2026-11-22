import { pathEffectIsConfined, type PathEffect } from "../permissions/allowed-directories.js";
import {
  canonicalizePathForMatch,
  createAdmissionDeniedPathMatcher,
  createSensitivePathMatcher,
  isAdmissionDeniedPath,
  isSensitivePath,
  isConfiguredSessionReadPath,
  resolvePathForPolicy,
} from "../permissions/sensitive-paths.js";
import { createStageWorkspacesMatcher } from "../permissions/stage-workspace-binding.js";
import { validateSandboxPath } from "../sandbox/path-validator.js";
import type { ToolExecutionContext, ToolExecutionResult } from "./types.js";

/** A path is judged as spelled and then as it resolves now. */
function asSpelledThenResolved(match: (path: string) => string | null): (path: string) => string | null {
  return (path) => match(path) ?? match(resolvePathForPolicy(path));
}

export function sensitiveFilePattern(path: string, effect: PathEffect = "read"): string | null {
  return asSpelledThenResolved((candidate) => isSensitivePath(candidate, effect))(path);
}

export function admissionDeniedFilePattern(path: string, effect: PathEffect = "read"): string | null {
  return asSpelledThenResolved((candidate) => isAdmissionDeniedPath(candidate, effect))(path);
}

/**
 * `sensitiveFilePattern` and `admissionDeniedFilePattern` for the many paths of one pass, such as a search's results. The
 * policy's own locations (the Ave home, the configured key files) are looked up once for the pass; each path is still
 * resolved afresh.
 */
export function createFilePathPolicy(effect: PathEffect = "read"): {
  sensitive: (path: string) => string | null;
  admissionDenied: (path: string) => string | null;
} {
  return {
    sensitive: asSpelledThenResolved(createSensitivePathMatcher(effect)),
    admissionDenied: asSpelledThenResolved(createAdmissionDeniedPathMatcher(effect)),
  };
}

/**
 * For a walk down from `root`: whether an entry lies in the stage workspaces folder and is passed over, as a secret file is. A root
 * inside that folder was decided at the permission floor, so nothing beneath it is passed over.
 */
export function createStageWorkspacesSkip(root: string): (path: string) => boolean {
  const inside = createStageWorkspacesMatcher();
  return inside(root) || inside(resolvePathForPolicy(root)) ? () => false : path => inside(path);
}

/** Execute-time sensitive and directory gates shared by native file operations. */
export function ensureFileAccess(
  path: string,
  context: ToolExecutionContext,
  effect: PathEffect,
): ToolExecutionResult | null {
  const sensitive = admissionDeniedFilePattern(path, effect);
  if (sensitive) {
    return { output: `Sensitive path: ${path} matches ${sensitive}`, isError: true };
  }
  if (effect === "read" && isConfiguredSessionReadPath(canonicalizePathForMatch(path))) return null;
  if (!pathEffectIsConfined(effect, context.blockReadsOutsideWorkingDirectories === true)) {
    return null;
  }
  const check = validateSandboxPath(path, context.cwd, [...context.extraAllowedDirectories]);
  if (!check.allowed) {
    return { output: `Sandbox: ${check.reason}`, isError: true };
  }
  return null;
}
