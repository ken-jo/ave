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
import { canonicalizePathForMatch, caseFoldForMatch } from "./sensitive-paths.js";

/** Control files remain unwritable even when their containing directory is granted. */
const PROTECTED_ROOT_ENTRIES = [
  ".bashrc", ".zshrc", ".profile", ".bash_profile", ".zprofile", ".gitconfig",
  ".vscode",
] as const;

/** Linux discovery depth; the admitted root is depth zero. */
export const SANDBOX_GIT_SCAN_DEPTH = 3;
const MAX_GIT_SCAN_ENTRIES = 16_384;
const MAX_GIT_METADATA_BYTES = 65_536;
const MAX_GIT_METADATA_TOTAL_BYTES = 1_048_576;
const MAX_GIT_ROOT_POLICY_BYTES = 16_384;
const MAX_GIT_POLICY_BYTES = 32_768;
const MAX_MISSING_PATH_ANCESTORS = 64;
const MAX_REPOSITORY_ANCESTORS = 256;
const GIT_CONTROL_ENTRIES = [
  "hooks", "config", "config.worktree", "commondir", "gitdir",
  "objects/info/alternates", "objects/info/http-alternates", "remotes", "branches",
] as const;
export const SANDBOX_BARE_REPOSITORY_ENTRIES = ["HEAD", "objects", "refs", "config"] as const;
function caseInsensitiveGitPattern(path: string): string {
  return path.replace(/[a-z]/gu, character => `[${character}${character.toUpperCase()}]`);
}
const MAC_GIT_CONTROL_GLOBS = GIT_CONTROL_ENTRIES.flatMap(entry => [
  `/**/${caseInsensitiveGitPattern(`.git/${entry}`)}`,
  `/**/${caseInsensitiveGitPattern(".git/modules")}/**/${caseInsensitiveGitPattern(entry)}`,
  `/**/${caseInsensitiveGitPattern(".git/worktrees")}/*/${caseInsensitiveGitPattern(entry)}`,
]);
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
  if (resolved.firstMissingPath !== undefined) {
    paths.add(resolved.path);
    paths.add(resolved.firstMissingPath);
  }
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

function hasGitHead(directory: string): boolean {
  try { return lstatSync(join(directory, "HEAD")).isFile(); }
  catch (error) { if (isMissingPath(error)) return false; throw error; }
}

/** Filesystem-only classification; a bare layout deliberately remains a non-worktree root. */
export function findNonRepositoryWriteRoots(writeRoots: readonly string[]): string[] {
  return classifyNonRepositoryWriteRoots(writeRoots, {
    entries: MAX_GIT_SCAN_ENTRIES, metadataBytes: MAX_GIT_METADATA_TOTAL_BYTES,
  });
}

function classifyNonRepositoryWriteRoots(writeRoots: readonly string[], budget: GitDiscoveryBudget): string[] {
  return [...new Set(writeRoots.map(root => resolvePolicyPath(root, process.cwd())))].filter(root => {
    let current = root;
    for (let depth = 0; depth < MAX_REPOSITORY_ANCESTORS; depth += 1) {
      try {
        const marker = lstatSync(join(current, ".git"));
        if (marker.isDirectory() && hasGitHead(join(current, ".git"))) return false;
        if (marker.isFile()) {
          const pointer = readGitMetadata(join(current, ".git"), budget) ?? "";
          const match = /^gitdir: ([^\r\n\0]+)$/.exec(pointer);
          if (match !== null && hasGitHead(resolvePolicyPath(match[1]!, current))) return false;
        }
        if (marker.isSymbolicLink()) throw new Error("Linked sandbox Git markers are unsupported");
      } catch (error) { if (!isMissingPath(error)) throw error; }
      const parent = dirname(current);
      if (parent === current) return true;
      current = parent;
    }
    throw new Error("Sandbox repository ancestry exceeds its depth limit");
  });
}

function addGitDirectoryControls(
  gitDir: string,
  paths: Set<string>,
  routingPins: Set<string>,
  budget: GitDiscoveryBudget,
): boolean {
  const queue = [gitDir];
  const visited = new Set<string>();
  for (let index = 0; index < queue.length; index += 1) {
    const directory = queue[index]!;
    if (visited.has(directory)) continue;
    visited.add(directory);
    for (const entry of GIT_CONTROL_ENTRIES) paths.add(join(directory, entry));
    if ([...paths, ...routingPins].reduce((bytes, path) => bytes + Buffer.byteLength(path), 0) > MAX_GIT_ROOT_POLICY_BYTES) return false;
    for (const containerName of ["modules", "worktrees"]) {
      const container = join(directory, containerName);
      let stat;
      try { stat = lstatSync(container); }
      catch (error) { if (isMissingPath(error)) { paths.add(container); continue; } throw error; }
      if (stat.isSymbolicLink()) {
        addProtectedRoutingPins(container, routingPins);
        paths.add(container);
        continue;
      }
      if (!stat.isDirectory()) { paths.add(container); continue; }
      const directories = [container];
      for (let childIndex = 0; childIndex < directories.length; childIndex += 1) {
        const child = directories[childIndex]!;
        let handle;
        try { handle = opendirSync(child); }
        catch (error) { if (isMissingPath(error)) continue; return false; }
        try {
          for (let entry = handle.readSync(); entry !== null; entry = handle.readSync()) {
            if (budget.entries-- <= 0) return false;
            const nested = join(child, entry.name);
            let stat;
            try { stat = lstatSync(nested); }
            catch (error) { if (isMissingPath(error)) continue; return false; }
            if (stat.isSymbolicLink()) { paths.add(nested); addProtectedRoutingPins(nested, routingPins); continue; }
            if (!stat.isDirectory()) continue;
            // Metadata stores are identified by HEAD just like worktree markers.
            // Grouping directories are still traversed for nested submodule names.
            if (hasGitHead(nested) || containerName === "worktrees") queue.push(nested);
            else {
              // An existing grouping directory can become a module store in
              // the same invocation; protect its future controls as well.
              for (const control of GIT_CONTROL_ENTRIES) paths.add(join(nested, control));
              if ([...paths, ...routingPins].reduce((bytes, path) => bytes + Buffer.byteLength(path), 0) > MAX_GIT_ROOT_POLICY_BYTES) return false;
              directories.push(nested);
            }
          }
        } finally { handle.closeSync(); }
      }
    }
    if ([...paths, ...routingPins].reduce((bytes, path) => bytes + Buffer.byteLength(path), 0) > MAX_GIT_ROOT_POLICY_BYTES) return false;
  }
  return true;
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
    if (isMissingPath(error)) { paths.add(marker); return true; }
    if (["EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      return false;
    }
    throw error;
  }
  if (!entry.isDirectory()) paths.add(marker);
  // A marker link is not a supported repository pointer. Never read its target
  // as host metadata; regular gitdir pointer files cover linked worktrees.
  if (entry.isSymbolicLink()) throw new Error("Linked sandbox Git markers are unsupported");
  const resolvedMarker = realpathSync.native(marker);
  if (!entry.isDirectory()) paths.add(resolvedMarker);
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
  if (!addGitDirectoryControls(gitDir, paths, routingPins, budget)) return false;
  const commonPath = readGitMetadata(join(gitDir, "commondir"), budget);
  if (commonPath === undefined) return true;
  if (!commonPath || /[\r\n\0]/.test(commonPath)) throw new Error("Invalid sandbox Git common directory");
  const commonDir = addGitMetadataTarget(commonPath, gitDir, paths, routingPins);
  return addGitDirectoryControls(commonDir, paths, routingPins, budget);
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
    if (current.depth > 0) {
      const marker = join(current.path, ".git");
      let entry;
      try { entry = lstatSync(marker); }
      catch (error) { if (!isMissingPath(error)) return false; }
      // A directory repository is identified by its HEAD marker. Pointer files
      // remain controls even if their target is not yet a valid repository.
      if (entry !== undefined && (!entry.isDirectory() || hasGitHead(marker))) {
        if (!addGitControlPaths(marker, paths, routingPins, budget)) return false;
      }
    }
    if ((paths.size !== beforePathCount || routingPins.size !== beforeRoutingPinCount)
      && [...paths, ...routingPins].reduce((bytes, path) => bytes + Buffer.byteLength(path), 0) > MAX_GIT_ROOT_POLICY_BYTES) return false;
    // Glob rules cover controls named beneath .git, but an existing pointer
    // can route them to an arbitrary directory name. Discover every macOS
    // indirection, including dependency and metadata trees, or revoke the
    // incomplete grant when the shared entry/path budgets are exhausted.
    if (process.platform !== "darwin" && current.depth === SANDBOX_GIT_SCAN_DEPTH) continue;
    let directory;
    try { directory = opendirSync(current.path); }
    catch (error) { if (isMissingPath(error)) continue; return false; }
    try {
      for (let entry = directory.readSync(); entry !== null; entry = directory.readSync()) {
        if (budget.entries-- <= 0) {
          return false;
        }
        if (process.platform !== "darwin" && gitScanIgnoredDirectories.has(entry.name.toLowerCase())) continue;
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
  for (const root of classifyNonRepositoryWriteRoots(roots, budget)) {
    for (const entry of [...SANDBOX_BARE_REPOSITORY_ENTRIES, ...(hasGitHead(root) ? ["hooks"] : [])]) {
      const path = join(root, entry);
      if (process.platform === "darwin") paths.add(path);
      else {
        // Never manufacture a host bare-layout entry merely to mount a deny.
        try { lstatSync(path); paths.add(path); }
        catch (error) { if (!isMissingPath(error)) throw error; }
      }
    }
  }
  const revoked = new Set<string>();
  const revoke = (root: string): void => {
    // A surviving ancestor would re-open an incompletely discovered child.
    for (const candidate of roots) if (isPhysicalPathWithin(candidate, root)) revoked.add(candidate);
  };
  const discovered = new Set<string>();
  const discoveredRoutingPins = new Set<string>();
  const separatorPattern = process.platform === "win32" ? /[\\/]/u : /\//u;
  // Scan narrow grants first so a broad ambient tree cannot spend the budget
  // required by an independently admitted workspace or private temp root.
  for (const root of [...roots].sort((left, right) => right.split(separatorPattern).length - left.split(separatorPattern).length)) {
    if (revoked.has(root)) continue;
    const local = new Set<string>();
    const localRoutingPins = new Set<string>();
    if (!addGitControlPaths(join(root, ".git"), local, localRoutingPins, budget)
      || !addNestedGitControlPaths(root, local, localRoutingPins, budget)) revoke(root);
    for (const path of local) discovered.add(path);
    for (const path of localRoutingPins) discoveredRoutingPins.add(path);
  }
  if (process.platform === "linux") {
    for (const path of paths) addProtectedRoutingPins(path, routingPins);
    for (const path of discovered) addProtectedRoutingPins(path, discoveredRoutingPins);
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
  // Backend globs cover future controls at any depth without denying ordinary
  // object, ref, index and HEAD updates in existing metadata directories.
  if (process.platform === "darwin") entries.push(...MAC_GIT_CONTROL_GLOBS);
  if (Buffer.byteLength(JSON.stringify(entries)) > MAX_GIT_POLICY_BYTES) throw new Error("Sandbox Git write policy exceeds its size limit");
  return { allowWrite: roots.filter(root => !revoked.has(root)), denyWrite: entries };
}
