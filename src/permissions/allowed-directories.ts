// Sensitive-path denies always override allowed roots; temp grants join the separate per-turn base set. Callers canonicalize and case-fold once; prefix checks must not resolve paths again (docs/architecture/permission-policy-design.md).
import { resolve as pathResolve, sep as pathSep } from "node:path";
import {
  canonicalizePathForMatch,
  caseFoldForMatch,
  isAdmissionDeniedPath,
  isConfiguredSessionReadPath,
} from "./sensitive-paths.js";
import { expandLeadingTilde } from "../shared/home-tilde.js";
import { aveHome } from "../shared/ave-home.js";
import { verifyAveScratchDir } from "../shared/ave-scratch.js";

// Directory addition pre-flight result. `ok: true` ⇒ caller may persist the directory to settings. `ok: false` ⇒ caller MUST surface `reason` to the user (Layer 0 sensitive directory, root, or empty input). Even an `ok: true` result may carry `adjacencyWarnings[]` (e.g. `.env`, `.git`, `.ssh`, `credentials`, `node_modules/.cache` adjacent) which the renderer SHOULD render as a red banner with explicit opt-in.
export type ValidateDirectoryResult =
  | { ok: true; canonicalPath: string; adjacencyWarnings: string[] }
  | { ok: false; reason: string; adjacencyWarnings: string[] };

const ADJACENCY_WARNING_BASENAMES = [
  ".env",
  ".git",
  ".ssh",
  "credentials",
] as const;

const ADJACENCY_WARNING_NESTED = [
  "node_modules/.cache",
] as const;

function normalizePolicySeparators(p: string): string {
  return p.replace(/\\/g, "/");
}

// Compute the host-default allow-list at boot. Default = `process.cwd` ∪ `homedir/.ave` ∪ the application scratch directory (only while `verifyAveScratchDir` holds: a directory the app created with `0o700` and still owns) MINUS Layer 0 deny paths. Returns canonicalized + case-folded entries ready to be passed to isPathAllowed.
export function computeDefaultAllowedDirectories(cwd: string = process.cwd()): string[] {
  return computeDefaultAllowedDirectoryEntries(cwd, true);
}

// Runtime filesystem roots for native tools. Unlike the Layer 1 matching scope, these keep the OS canonical case so `realpath`-based sandbox checks can validate the same directories without lowercasing path segments.
export function computeDefaultRuntimeAllowedDirectories(cwd: string = process.cwd()): string[] {
  return computeDefaultAllowedDirectoryEntries(cwd, false);
}

function computeDefaultAllowedDirectoryEntries(cwd: string, foldCase: boolean): string[] {
  const scratch = verifyAveScratchDir();
  const candidates = [cwd, aveHome(), ...(scratch.ok ? [scratch.path] : [])];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of candidates) {
    const canonical = canonicalizePathForMatch(raw);
    const folded = caseFoldForMatch(canonical);
    const value = foldCase ? folded : canonical;
    if (isFilesystemRootPath(folded)) continue;
    // Layer 0 always wins — if a default candidate is itself sensitive, skip it (the more-specific deny patterns inside still hard-block any leaf access, so excluding the default is mostly hygiene).
    if (isAdmissionDeniedPath(folded)) continue;
    if (seen.has(folded)) continue;
    seen.add(folded);
    out.push(value);
  }
  return out;
}

// Sanitize a user-provided allow-list (e.g. from `permissions.additionalDirectories` in settings.json). - Resolves `~` to `homedir`. - Canonicalizes via canonicalizePathForMatch + case-fold. - Drops any entry that hits Layer 0 (sensitive path). - De-duplicates. this DOES NOT include the host defaults. Callers should `[...computeDefaultAllowedDirectories,...sanitizeAllowedDirectories(...)]` to assemble the final scope.
export function sanitizeAllowedDirectories(input: readonly string[] | undefined): string[] {
  return sanitizeAllowedDirectoryEntries(input, true);
}

// Runtime filesystem roots for native tools. Applies the same validation as sanitizeAllowedDirectories but preserves canonical OS case.
export function sanitizeRuntimeAllowedDirectories(input: readonly string[] | undefined): string[] {
  return sanitizeAllowedDirectoryEntries(input, false);
}

function sanitizeAllowedDirectoryEntries(
  input: readonly string[] | undefined,
  foldCase: boolean,
): string[] {
  if (!input || input.length === 0) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of input) {
    if (typeof raw !== "string" || raw.length === 0) continue;
    const expanded = expandLeadingTilde(raw);
    if (isFilesystemRootPath(expanded)) continue;
    const canonical = canonicalizePathForMatch(expanded);
    const folded = caseFoldForMatch(canonical);
    const value = foldCase ? folded : canonical;
    if (isFilesystemRootPath(folded)) continue;
    if (isAdmissionDeniedPath(folded)) continue;
    if (seen.has(folded)) continue;
    seen.add(folded);
    out.push(value);
  }
  return out;
}

// Layer 1 prefix check. `canonicalPath` MUST already be canonicalized + case-folded by the caller (frozen-canonical contract). `scope.directories` MUST come from sanitizeAllowedDirectories or computeDefaultAllowedDirectories. Returns `true` iff `canonicalPath === dir` OR `canonicalPath` starts with `dir + "/"` (segment-aligned). Pure string compare — no realpath. ALWAYS returns `false` for empty input (deny-by-default).
export function isPathAllowed(
  canonicalPath: string,
  scope: { directories: readonly string[] },
): boolean {
  if (!canonicalPath) return false;
  if (!scope.directories || scope.directories.length === 0) return false;
  for (const dir of scope.directories) {
    if (!dir) continue;
    if (canonicalPath === dir) return true;
    // Use forward-slash separator since canonicalizePathForMatch already collapsed duplicates and uses POSIX form internally.
    const sep = "/";
    if (canonicalPath.startsWith(dir + sep)) return true;
    // Edge case: directories may end with the platform separator on win32 — accept either form.
    if (pathSep !== sep && canonicalPath.startsWith(dir + pathSep)) return true;
  }
  return false;
}

// What a path operand is about to be used FOR. Layer 1 confines the two asymmetrically: a write or an execution changes the machine and stays inside the authorized directories, while a read only observes it and is bounded by the Layer 0 deny-list alone.
export type PathEffect = "read" | "write";

// The Layer 1 scope plus the one user setting that changes its shape. `blockReadsOutsideWorkingDirectories` restores the pre-asymmetry behaviour: every effect is confined to `directories`. It ships OFF, so a read reaches anywhere the Layer 0 deny-list permits.
export interface PathScopePolicy {
  readonly directories: readonly string[];
  readonly blockReadsOutsideWorkingDirectories: boolean;
}

// Directory scope confines writes, not reads; both tool and shell paths use this predicate. Sensitive-path hard blocks run first for every effect.
export function pathEffectIsConfined(
  effect: PathEffect,
  blockReadsOutsideWorkingDirectories: boolean,
): boolean {
  return effect === "write" || blockReadsOutsideWorkingDirectories;
}

// Keep effect-aware read exemption in this shared predicate; canonicalPath still obeys the frozen-canonical contract.
export function isPathAllowedForEffect(
  canonicalPath: string,
  scope: PathScopePolicy,
  effect: PathEffect,
): boolean {
  if (effect === "read" && isConfiguredSessionReadPath(canonicalPath)) return true;
  if (!pathEffectIsConfined(effect, scope.blockReadsOutsideWorkingDirectories)) return true;
  return isPathAllowed(canonicalPath, scope);
}

// Suggest only the requested directory or a file's immediate parent, never a broader prefix. Return null for covered, sensitive or root scopes; failed stat defaults to file-style suggestion. Inputs are already canonical/case-folded.
export function pickClosestParent(
  canonicalPath: string,
  currentAllowed: readonly string[],
  isDirectory: boolean = false,
): string | null {
  if (!canonicalPath) return null;
  if (isDirectory) {
    if (isFilesystemRootPath(canonicalPath)) return null;
    if (isAdmissionDeniedPath(canonicalPath)) return null;
    if (isPathAllowed(canonicalPath, { directories: currentAllowed })) return null;
    return canonicalPath;
  }
  const parent = caseFoldForMatch(canonicalizePathForMatch(pathResolve(canonicalPath, "..")));
  if (parent === canonicalPath) return null; // already at root
  if (isAdmissionDeniedPath(parent)) return null;
  if (isPathAllowed(canonicalPath, { directories: currentAllowed })) return null;
  if (isPathAllowed(parent, { directories: currentAllowed })) return null;
  return parent;
}

// Pre-flight check before persisting a directory to `additionalDirectories`. Surfaces three classes of problem: 1. Hard reject: empty / sensitive / filesystem root → `ok: false`. 2. Soft warn: directory contains adjacent `.env` / `.git` / `.ssh` / `credentials` / `node_modules/.cache` → `ok: true` + warnings. Renderer is expected to render warnings as a red banner with an explicit "I understand" checkbox before enabling the persist button. this only inspects the directory PATH itself. It does NOT do a filesystem walk to count files — tree-size preview (Layer 1 M3 point 4) is a separate pass at the renderer layer.
export function validateDirectoryAddition(rawPath: string): ValidateDirectoryResult {
  const adjacencyWarnings: string[] = [];
  if (typeof rawPath !== "string" || rawPath.trim().length === 0) {
    return { ok: false, reason: "directory path is empty", adjacencyWarnings };
  }
  const expanded = expandLeadingTilde(rawPath.trim());
  if (isFilesystemRootPath(expanded)) {
    return { ok: false, reason: "filesystem root is not allowed", adjacencyWarnings };
  }
  const canonical = canonicalizePathForMatch(expanded);
  const folded = caseFoldForMatch(canonical);

  // Reject filesystem root.
  if (isFilesystemRootPath(folded)) {
    return { ok: false, reason: "filesystem root is not allowed", adjacencyWarnings };
  }
  // Reject Layer 0 sensitive paths.
  const sensitive = isAdmissionDeniedPath(folded);
  if (sensitive) {
    return {
      ok: false,
      reason: `path matches sensitive pattern '${sensitive}'`,
      adjacencyWarnings,
    };
  }

  // Adjacency hints — pure string heuristics on the basename / path segments. We don't `readdir` the target; that is a renderer concern (preview) and would also be a TOCTOU surface.
  const lowerFolded = normalizePolicySeparators(folded).toLowerCase();
  for (const basename of ADJACENCY_WARNING_BASENAMES) {
    if (
      lowerFolded.endsWith("/" + basename) ||
      lowerFolded.includes("/" + basename + "/")
    ) {
      adjacencyWarnings.push(
        `path contains '${basename}' segment — secrets may be exposed if added`,
      );
    }
  }
  for (const nested of ADJACENCY_WARNING_NESTED) {
    if (lowerFolded.includes("/" + nested.toLowerCase())) {
      adjacencyWarnings.push(
        `path contains '${nested}' — large cache directory, may impact performance`,
      );
    }
  }

  return { ok: true, canonicalPath: folded, adjacencyWarnings };
}

export function isFilesystemRootPath(foldedPath: string): boolean {
  const normalized = normalizePolicySeparators(foldedPath);
  if (normalized === "/") return true;

  const trimmed = normalized.replace(/\/+$/g, "");
  if (/^[a-z]:$/i.test(trimmed)) return true;
  if (/^\/\/[?.]\/[a-z]:$/i.test(trimmed)) return true;
  if (/^\/\/[?.]\/unc\/[^/]+\/[^/]+$/i.test(trimmed)) return true;
  if (/^\/\/[?.]\/volume\{[^/]+}(?:\/|$)/i.test(normalized)) return true;
  if (/^\/\/[?.]\/globalroot\/device\//i.test(normalized)) return true;
  return /^\/\/(?![?.]\/)[^/]+\/[^/]+$/i.test(trimmed);
}

// Assemble the live allow-list scope from defaults + user additions, with Layer 0 sensitive paths filtered out. This is the canonical entry point used by the executor to construct the `scope` argument to isPathAllowed. Order: defaults first, then user additions (to keep the leaf-parent computation deterministic).
export function buildAllowedScope(
  userAdditions: readonly string[] | undefined,
  cwd: string = process.cwd(),
): { directories: string[] } {
  const defaults = computeDefaultAllowedDirectories(cwd);
  const sanitized = sanitizeAllowedDirectories(userAdditions);
  const seen = new Set<string>();
  const directories: string[] = [];
  for (const dir of [...defaults, ...sanitized]) {
    if (seen.has(dir)) continue;
    seen.add(dir);
    directories.push(dir);
  }
  return { directories };
}

// Assemble runtime filesystem roots for native tool sandbox checks. This is intentionally separate from buildAllowedScope: Layer 1 matching uses case-folded strings, while native tools need canonical OS paths.
export function buildRuntimeAllowedDirectories(
  userAdditions: readonly string[] | undefined,
  cwd: string = process.cwd(),
): string[] {
  const defaults = computeDefaultRuntimeAllowedDirectories(cwd);
  const sanitized = sanitizeRuntimeAllowedDirectories(userAdditions);
  const seen = new Set<string>();
  const directories: string[] = [];
  for (const dir of [...defaults, ...sanitized]) {
    const folded = caseFoldForMatch(canonicalizePathForMatch(dir));
    if (seen.has(folded)) continue;
    seen.add(folded);
    directories.push(dir);
  }
  return directories;
}
