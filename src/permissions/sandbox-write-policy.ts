import { closeSync, constants, fstatSync, lstatSync, openSync, opendirSync, readSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { FilesystemConfig, FilesystemPathEntry } from "@anthropic-ai/sandbox-runtime";
import { settingsFilePath } from "../data/settings-store.js";
import { aveHome } from "../shared/ave-home.js";
import { permissionSettingsPath } from "./permission-settings-store.js";
import { egressGrantFilePath } from "./egress-grants.js";
import { userApprovalFilePath } from "./user-approval-store.js";
import { getAdminPolicyPath, userPolicyPath } from "./policy-store.js";
import { permissionsFilePath } from "./permissions-store.js";
import { projectRulesDirectory } from "./rules/project-rule-files.js";
import { canonicalizePathForMatch, caseFoldForMatch, foldCanonicalPathSeparators } from "./sensitive-paths.js";

/** Control files remain unwritable even when their containing directory is granted. */
const PROTECTED_ROOT_ENTRIES = [
  ".bashrc", ".zshrc", ".profile", ".bash_profile", ".zprofile", ".gitconfig",
  ".git", ".git/hooks", ".git/config", ".git/modules", ".vscode",
] as const;

/** Directory depth of nested repository discovery; the admitted root is depth zero. */
export const SANDBOX_GIT_SCAN_DEPTH = 3;
const MAX_GIT_SCAN_ENTRIES = 16_384;
const MAX_GIT_METADATA_BYTES = 65_536;
const MAX_GIT_METADATA_TOTAL_BYTES = 1_048_576;
const MAX_GIT_ROOT_POLICY_BYTES = 16_384;
const MAX_GIT_POLICY_BYTES = 32_768;
interface GitDiscoveryBudget { entries: number; metadataBytes: number }
const gitScanIgnoredDirectories = new Set([
  ".git", ".hg", ".svn", "node_modules", ".venv", "venv", "vendor", "dist", "build", ".cache",
]);

/** Canonical snapshots use forward slashes, independent of the native separator. */
function isCanonicalPathWithin(root: string, path: string): boolean {
  const foldedRoot = process.platform === "win32" ? root.toLowerCase() : root;
  const foldedPath = process.platform === "win32" ? path.toLowerCase() : path;
  return foldedPath === foldedRoot
    || foldedPath.startsWith(foldedRoot.endsWith("/") ? foldedRoot : `${foldedRoot}/`);
}

/** Compare filesystem grants, including canonical Windows aliases and casing. */
export function isGrantPathWithin(root: string, path: string): boolean {
  if (process.platform !== "win32") {
    const rel = relative(resolve(root), resolve(path));
    return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
  }
  const foldedRoot = caseFoldForMatch(canonicalizePathForMatch(root));
  const foldedPath = caseFoldForMatch(canonicalizePathForMatch(path));
  return isCanonicalPathWithin(foldedRoot, foldedPath);
}

function isMissingPath(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR";
}

/** No pipes, links or unbounded reads may turn discovery into an arbitrary file read. */
function readGitMetadata(path: string, budget: GitDiscoveryBudget): string | undefined {
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0)); }
  catch (error) { if (isMissingPath(error)) return undefined; throw error; }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_GIT_METADATA_BYTES) throw new Error("Invalid sandbox Git control metadata");
    if (stat.size > budget.metadataBytes) throw new Error("Sandbox Git metadata budget exhausted");
    const buffer = Buffer.alloc(Math.min(MAX_GIT_METADATA_BYTES, budget.metadataBytes) + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, length);
      if (count === 0) break;
      length += count;
    }
    if (length > MAX_GIT_METADATA_BYTES) throw new Error("Sandbox Git control metadata is too large");
    if (length > budget.metadataBytes) throw new Error("Sandbox Git metadata budget exhausted");
    const after = fstatSync(fd);
    if (length !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) {
      throw new Error("Sandbox Git metadata changed during discovery");
    }
    budget.metadataBytes -= length;
    // Only terminal CR/LF bytes delimit these control records. Other
    // whitespace is path data, including a trailing space, tab or NBSP.
    return buffer.toString("utf8", 0, length).replace(/[\r\n]+$/u, "");
  } finally { closeSync(fd); }
}

function addGitControlPaths(marker: string, paths: Set<string>, budget: GitDiscoveryBudget): boolean {
  let entry;
  try { entry = lstatSync(marker); }
  catch (error) {
    if (isMissingPath(error)) return true;
    if (["EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      return false;
    }
    throw error;
  }
  paths.add(marker);
  // A marker link is not a supported repository pointer. Never read its target
  // as host metadata; regular gitdir pointer files cover linked worktrees.
  if (entry.isSymbolicLink()) throw new Error("Linked sandbox Git markers are unsupported");
  const resolvedMarker = realpathSync(marker);
  paths.add(resolvedMarker);
  let gitDir = resolvedMarker;
  if (entry.isFile()) {
    const pointer = readGitMetadata(resolvedMarker, budget) ?? "";
    const match = /^gitdir: ([^\r\n\0]+)$/.exec(pointer);
    if (match === null) {
      if (pointer.startsWith("gitdir: ")) throw new Error("Invalid sandbox Git directory pointer");
      return true;
    }
    gitDir = resolve(dirname(marker), match[1]!);
  } else if (!entry.isDirectory()) {
    throw new Error("Invalid sandbox Git marker");
  }
  // The metadata directory itself prevents pointer replacement, new controls,
  // and writes to a submodule directory that does not exist until later.
  paths.add(gitDir);
  paths.add(canonicalizePathForMatch(gitDir));
  const commonPath = readGitMetadata(join(gitDir, "commondir"), budget);
  if (commonPath === undefined) return true;
  if (!commonPath || /[\r\n\0]/.test(commonPath)) throw new Error("Invalid sandbox Git common directory");
  const commonDir = resolve(gitDir, commonPath);
  paths.add(commonDir);
  paths.add(canonicalizePathForMatch(commonDir));
  return true;
}

function addNestedGitControlPaths(root: string, paths: Set<string>, budget: GitDiscoveryBudget): boolean {
  if (budget.entries <= 0) return false;
  let canonicalRoot: string;
  try { canonicalRoot = foldCanonicalPathSeparators(realpathSync(root)); }
  catch (error) { return isMissingPath(error); }
  if (!isCanonicalPathWithin(root, canonicalRoot) || !isCanonicalPathWithin(canonicalRoot, root)) return false;
  const queue = [{ path: root, depth: 0 }];
  const visited = new Set<string>();
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index]!;
    let canonical: string;
    try { canonical = foldCanonicalPathSeparators(realpathSync(current.path)); }
    catch (error) { if (isMissingPath(error)) continue; return false; }
    // A directory link may be followed only within this admitted root. Another
    // admitted root is discovered separately with the same invocation budget.
    if (!isCanonicalPathWithin(canonicalRoot, canonical)) continue;
    if (visited.has(canonical)) continue;
    visited.add(canonical);
    const before = paths.size;
    if (current.depth > 0 && !addGitControlPaths(join(current.path, ".git"), paths, budget)) return false;
    if (paths.size !== before && [...paths].reduce((bytes, path) => bytes + Buffer.byteLength(path), 0) > MAX_GIT_ROOT_POLICY_BYTES) return false;
    if (current.depth === SANDBOX_GIT_SCAN_DEPTH) continue;
    let directory;
    try { directory = opendirSync(current.path); }
    catch (error) { if (isMissingPath(error)) continue; return false; }
    try {
      for (let entry = directory.readSync(); entry !== null; entry = directory.readSync()) {
        if (budget.entries-- <= 0) {
          return false;
        }
        if (gitScanIgnoredDirectories.has(entry.name.toLowerCase())) continue;
        const child = join(current.path, entry.name);
        let descend = entry.isDirectory() || entry.isSymbolicLink();
        // Some filesystems return DT_UNKNOWN. Such an entry is not evidence
        // that a directory cannot contain protected metadata.
        if (!descend && !entry.isFile() && !entry.isBlockDevice() && !entry.isCharacterDevice()
          && !entry.isFIFO() && !entry.isSocket()) {
          try { const stat = lstatSync(child); descend = stat.isDirectory() || stat.isSymbolicLink(); }
          catch (error) { if (!isMissingPath(error)) return false; }
        }
        if (descend) queue.push({ path: child, depth: current.depth + 1 });
      }
    } catch (error) { if (!isMissingPath(error)) return false; }
    finally { directory.closeSync(); }
  }
  return true;
}

/**
 * Literal denies include absent paths: the runtime must prevent their creation,
 * rather than filtering the policy by what happens to exist before a command.
 * Store locations come from their writers so changing a layout also changes
 * this boundary. Existing sensitive-write protection is unioned separately.
 */
export function buildMandatorySandboxWritePolicy(
  writeRoots: readonly string[],
  userDataDir?: string,
): Pick<FilesystemConfig, "denyWrite"> & { allowWrite: string[] } {
  const rootSnapshots = writeRoots.map(original => ({ original, canonical: canonicalizePathForMatch(original) }));
  const paths = new Set([
    ...rootSnapshots.flatMap(({ original, canonical }) => [original, canonical]).flatMap((root) =>
      PROTECTED_ROOT_ENTRIES.map((entry) => join(root, entry))),
    permissionSettingsPath(),
    userApprovalFilePath(),
    egressGrantFilePath(),
    userPolicyPath(),
    getAdminPolicyPath(),
    permissionsFilePath(),
    dirname(projectRulesDirectory(aveHome())),
    ...(userDataDir === undefined ? [] : [settingsFilePath(userDataDir)]),
  ]);
  const budget = { entries: MAX_GIT_SCAN_ENTRIES, metadataBytes: MAX_GIT_METADATA_TOTAL_BYTES };
  const roots = [...new Set(rootSnapshots.map(root => root.canonical))];
  const revoked = new Set<string>();
  const revoke = (root: string): void => {
    // A surviving ancestor would re-open an incompletely discovered child.
    for (const candidate of roots) if (isCanonicalPathWithin(candidate, root)) revoked.add(candidate);
  };
  // Root-owned pointers remain explicit denies even when discovery revokes a
  // broad grant. Scan narrow grants first so an ambient temp tree cannot spend
  // the budget needed by an independently admitted workspace or private temp.
  for (const root of roots) {
    if (!addGitControlPaths(join(root, ".git"), paths, budget)) revoke(root);
  }
  const discovered = new Set<string>();
  for (const root of [...roots].sort((left, right) => right.split("/").length - left.split("/").length)) {
    if (revoked.has(root)) continue;
    const local = new Set<string>();
    if (!addNestedGitControlPaths(root, local, budget)) revoke(root);
    for (const path of local) discovered.add(path);
  }
  const retained = roots.filter(root => !revoked.has(root));
  for (const path of discovered) {
    for (const spelling of [path, canonicalizePathForMatch(path)]) {
      // Revoked roots are read-only through the default filesystem jail. Never
      // put a deny on their ancestor: it would also override retained child grants.
      if (retained.some(root => isCanonicalPathWithin(root, spelling) || isCanonicalPathWithin(spelling, root))
        || !roots.some(root => isCanonicalPathWithin(root, spelling))) paths.add(spelling);
    }
  }
  // Preserve both the directory entry and its target when a setting is a link.
  const entries: FilesystemPathEntry[] = [...new Set([...paths].flatMap((path) => [path, canonicalizePathForMatch(path)]))]
    .map((path) => /[*?\[\]]/.test(path) ? { path, literal: true } : path);
  // A backend glob protects future entries without expanding the argument list.
  if (process.platform === "darwin") entries.push("/**/.[gG][iI][tT]");
  if (Buffer.byteLength(JSON.stringify(entries)) > MAX_GIT_POLICY_BYTES) throw new Error("Sandbox Git write policy exceeds its size limit");
  return { allowWrite: roots.filter(root => !revoked.has(root)), denyWrite: entries };
}
