import { closeSync, constants, fstatSync, lstatSync, openSync, opendirSync, readSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { FilesystemConfig, FilesystemPathEntry } from "@anthropic-ai/sandbox-runtime";
import { settingsFilePath } from "../data/settings-store.js";
import { aveHome } from "../shared/ave-home.js";
import { inspectPhysicalFilesystemPath, resolvePhysicalFilesystemPath } from "../shared/shell-filesystem-path.js";
import { permissionSettingsPath } from "./permission-settings-store.js";
import { egressGrantFilePath } from "./egress-grants.js";
import { userApprovalFilePath } from "./user-approval-store.js";
import { getAdminPolicyPath, userPolicyPath } from "./policy-store.js";
import { permissionsFilePath } from "./permissions-store.js";
import { projectRulesDirectory } from "./rules/project-rule-files.js";
import { PROTECTED_ROOT_ENTRIES, canonicalizePathForMatch, caseFoldForMatch } from "./sensitive-paths.js";

/** Directory depth of nested repository discovery; the admitted root is depth zero. */
export const SANDBOX_GIT_SCAN_DEPTH = 3;
const MAX_GIT_SCAN_ENTRIES = 16_384;
const MAX_GIT_METADATA_BYTES = 65_536;
const MAX_GIT_METADATA_TOTAL_BYTES = 1_048_576;
const MAX_GIT_ROOT_POLICY_BYTES = 16_384;
const MAX_GIT_POLICY_BYTES = 32_768;
const MAX_MISSING_PATH_ANCESTORS = 64;
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

/** Physical snapshots retain Unicode and POSIX backslashes as filesystem identity. */
function isPhysicalPathWithin(root: string, path: string): boolean {
  const foldedRoot = process.platform === "win32" ? root.toLowerCase() : root;
  const foldedPath = process.platform === "win32" ? path.toLowerCase() : path;
  const rel = relative(foldedRoot, foldedPath);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function resolvePolicyPath(path: string, cwd: string): string {
  return resolvePhysicalFilesystemPath(path, cwd, MAX_MISSING_PATH_ANCESTORS);
}

function resolvePolicyDenyPath(path: string): string {
  try { return resolvePolicyPath(path, process.cwd()); }
  catch (error) {
    // A control below a pointer file cannot exist until that denied entry is replaced.
    if ((error as NodeJS.ErrnoException).code === "ENOTDIR") return path;
    throw error;
  }
}

function addGitMetadataTarget(path: string, cwd: string, paths: Set<string>, routingPins: Set<string>): string {
  const resolved = inspectPhysicalFilesystemPath(path, cwd, MAX_MISSING_PATH_ANCESTORS);
  if (resolved.unresolvedParentTraversal) {
    throw new Error("Sandbox Git control metadata has unresolved parent traversal");
  }
  paths.add(resolved.path);
  if (resolved.firstMissingPath !== undefined) paths.add(resolved.firstMissingPath);
  for (const routingPath of resolved.routingSymlinkPaths) routingPins.add(routingPath);
  return resolved.path;
}

function addProtectedRoutingPins(path: string, routingPins: Set<string>): void {
  try {
    const resolved = inspectPhysicalFilesystemPath(path, process.cwd(), MAX_MISSING_PATH_ANCESTORS);
    for (const routingPath of resolved.routingSymlinkPaths) routingPins.add(routingPath);
  } catch (error) {
    const marker = dirname(path);
    // A regular .git pointer makes its child control paths structurally
    // impossible. Every other inspection failure remains fail-closed.
    if ((error as NodeJS.ErrnoException).code === "ENOTDIR"
      && basename(marker) === ".git" && lstatSync(marker).isFile()) return;
    throw error;
  }
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
    const bytes = buffer.subarray(0, length);
    const decoded = bytes.toString("utf8");
    if (!Buffer.from(decoded, "utf8").equals(bytes)) {
      throw new Error("Sandbox Git control metadata is not valid UTF-8");
    }
    budget.metadataBytes -= length;
    // Only terminal CR/LF bytes delimit these control records. Other
    // whitespace is path data, including a trailing space, tab or NBSP.
    return decoded.replace(/[\r\n]+$/u, "");
  } finally { closeSync(fd); }
}

function addGitControlPaths(
  marker: string,
  paths: Set<string>,
  routingPins: Set<string>,
  budget: GitDiscoveryBudget,
): boolean {
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
  const resolvedMarker = realpathSync.native(marker);
  paths.add(resolvedMarker);
  let gitDir = resolvedMarker;
  if (entry.isFile()) {
    const pointer = readGitMetadata(resolvedMarker, budget) ?? "";
    const match = /^gitdir: ([^\r\n\0]+)$/.exec(pointer);
    if (match === null) {
      if (pointer.startsWith("gitdir: ")) throw new Error("Invalid sandbox Git directory pointer");
      return true;
    }
    gitDir = addGitMetadataTarget(match[1]!, dirname(marker), paths, routingPins);
  } else if (!entry.isDirectory()) {
    throw new Error("Invalid sandbox Git marker");
  }
  // The metadata directory itself prevents pointer replacement, new controls,
  // and writes to a submodule directory that does not exist until later.
  paths.add(gitDir);
  const commonPath = readGitMetadata(join(gitDir, "commondir"), budget);
  if (commonPath === undefined) return true;
  if (!commonPath || /[\r\n\0]/.test(commonPath)) throw new Error("Invalid sandbox Git common directory");
  const commonDir = addGitMetadataTarget(commonPath, gitDir, paths, routingPins);
  paths.add(commonDir);
  return true;
}

function addNestedGitControlPaths(
  root: string,
  paths: Set<string>,
  routingPins: Set<string>,
  budget: GitDiscoveryBudget,
): boolean {
  if (budget.entries <= 0) return false;
  let canonicalRoot: string;
  try { canonicalRoot = realpathSync.native(root); }
  catch (error) { return isMissingPath(error); }
  if (!isPhysicalPathWithin(root, canonicalRoot) || !isPhysicalPathWithin(canonicalRoot, root)) return false;
  const queue = [{ path: root, depth: 0 }];
  const visited = new Set<string>();
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index]!;
    let canonical: string;
    try { canonical = realpathSync.native(current.path); }
    catch (error) { if (isMissingPath(error)) continue; return false; }
    // A directory link may be followed only within this admitted root. Another
    // admitted root is discovered separately with the same invocation budget.
    if (!isPhysicalPathWithin(canonicalRoot, canonical)) continue;
    if (visited.has(canonical)) continue;
    visited.add(canonical);
    const beforePathCount = paths.size;
    const beforeRoutingPinCount = routingPins.size;
    if (current.depth > 0 && !addGitControlPaths(join(current.path, ".git"), paths, routingPins, budget)) return false;
    if ((paths.size !== beforePathCount || routingPins.size !== beforeRoutingPinCount)
      && [...paths, ...routingPins].reduce((bytes, path) => bytes + Buffer.byteLength(path), 0) > MAX_GIT_ROOT_POLICY_BYTES) return false;
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
 * Its paths are inspected only for routing links; their owning union remains
 * responsible for emitting the corresponding deny entries.
 */
export function buildMandatorySandboxWritePolicy(
  writeRoots: readonly string[],
  userDataDir?: string,
  protectedRoutingPaths: readonly string[] = [],
): Pick<FilesystemConfig, "denyWrite"> & { allowWrite: string[] } {
  const rootSnapshots = writeRoots.map(original => ({
    original,
    physical: resolvePolicyPath(original, process.cwd()),
  }));
  const paths = new Set([
    ...rootSnapshots.flatMap(({ original, physical }) => [original, physical]).flatMap((root) =>
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
  const routingPins = new Set<string>();
  const roots = [...new Set(rootSnapshots.map(root => root.physical))];
  const revoked = new Set<string>();
  const revoke = (root: string): void => {
    // A surviving ancestor would re-open an incompletely discovered child.
    for (const candidate of roots) if (isPhysicalPathWithin(candidate, root)) revoked.add(candidate);
  };
  // Root-owned pointers remain explicit denies even when discovery revokes a
  // broad grant. Scan narrow grants first so an ambient temp tree cannot spend
  // the budget needed by an independently admitted workspace or private temp.
  for (const root of roots) {
    if (!addGitControlPaths(join(root, ".git"), paths, routingPins, budget)) revoke(root);
  }
  const discovered = new Set<string>();
  const discoveredRoutingPins = new Set<string>();
  const separatorPattern = process.platform === "win32" ? /[\\/]/u : /\//u;
  for (const root of [...roots].sort((left, right) => right.split(separatorPattern).length - left.split(separatorPattern).length)) {
    if (revoked.has(root)) continue;
    const local = new Set<string>();
    const localRoutingPins = new Set<string>();
    if (!addNestedGitControlPaths(root, local, localRoutingPins, budget)) revoke(root);
    for (const path of local) discovered.add(path);
    for (const path of localRoutingPins) discoveredRoutingPins.add(path);
  }
  if (process.platform === "linux") {
    for (const path of paths) addProtectedRoutingPins(path, routingPins);
    for (const path of protectedRoutingPaths) addProtectedRoutingPins(path, routingPins);
    // A bind mount follows a routing symlink to its target; it cannot pin the
    // directory entry while leaving that entry's parent writable. Remove every
    // grant that could replace the link. Independent child and sibling grants
    // remain available because they do not make the routing parent writable.
    for (const routingPath of [...routingPins, ...discoveredRoutingPins]) {
      const routingParent = dirname(routingPath);
      for (const root of roots) {
        if (isPhysicalPathWithin(root, routingParent)) revoked.add(root);
      }
    }
  }
  const retained = roots.filter(root => !revoked.has(root));
  for (const path of discovered) {
    // Revoked roots are read-only through the default filesystem jail. Never
    // put a deny on their ancestor: it would also override retained child grants.
    if (retained.some(root => isPhysicalPathWithin(root, path) || isPhysicalPathWithin(path, root))
      || !roots.some(root => isPhysicalPathWithin(root, path))) {
      paths.add(path);
    }
  }
  for (const path of discoveredRoutingPins) {
    if (retained.some(root => isPhysicalPathWithin(root, path) || isPhysicalPathWithin(path, root))
      || !roots.some(root => isPhysicalPathWithin(root, path))) routingPins.add(path);
  }
  // Preserve both the directory entry and its target when a setting is a link.
  const entries: FilesystemPathEntry[] = [...new Set([...paths].flatMap((path) => [
    path,
    resolvePolicyDenyPath(path),
  ]))]
    .map((path) => /[*?\[\]]/.test(path) ? { path, literal: true } : path);
  // Linux consumes routing links only to revoke covering grants. Replaying one
  // as a deny bind would follow its target and could mask an unrelated subtree.
  if (process.platform !== "linux") {
    entries.push(...[...routingPins].map(path => ({ path, literal: true } as const)));
  }
  // A backend glob protects future entries without expanding the argument list.
  if (process.platform === "darwin") entries.push("/**/.[gG][iI][tT]");
  if (Buffer.byteLength(JSON.stringify(entries)) > MAX_GIT_POLICY_BYTES) throw new Error("Sandbox Git write policy exceeds its size limit");
  return { allowWrite: roots.filter(root => !revoked.has(root)), denyWrite: entries };
}
