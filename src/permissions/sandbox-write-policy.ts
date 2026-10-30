import { type BigIntStats, type Stats, closeSync, constants, fstatSync, lstatSync, openSync, opendirSync, readSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { FilesystemConfig, FilesystemPathEntry } from "@anthropic-ai/sandbox-runtime";
import { settingsFilePath } from "../data/settings-store.js";
import { AVE_HOME_CONFIGURATION_DIRECTORY, aveHome } from "../shared/ave-home.js";
import { inspectPhysicalFilesystemPath, resolvePhysicalFilesystemPath } from "../shared/shell-filesystem-path.js";
import { permissionSettingsPath } from "./permission-settings-store.js";
import { egressGrantFilePath } from "./egress-grants.js";
import { userApprovalFilePath } from "./user-approval-store.js";
import { getAdminPolicyPath, userPolicyPath } from "./policy-store.js";
import { permissionsFilePath } from "./permissions-store.js";
import { projectRulesDirectory } from "./rules/project-rule-files.js";
import { PROTECTED_ROOT_ENTRIES, canonicalizePathForMatch, caseFoldForMatch } from "./sensitive-paths.js";
import { sandboxQuarantineRoot } from "./sandbox-quarantine.js";

// Git execution controls use recursive platform-specific rules and Linux rescans; exclude .git from this shared floor so objects/refs remain writable without creating absent mountpoints. Keep .gitconfig and .githooks denied.
export function isSandboxGitMetadataEntry(entry: string): boolean {
  return entry === ".git" || entry.startsWith(".git/");
}
const SANDBOX_LOADER_ENTRIES = [
  ".bash_profile", ".githooks", ".pre-commit-config.yaml", "lefthook.yml",
  ".claude/settings.json", ".claude/settings.local.json", ".claude/hooks", ".claude/commands", ".idea/workspace.xml",
  ".envrc", ".mise.toml", "mise.toml", ".tool-versions", ".npmrc", ".yarnrc.yml", "bunfig.toml", ".husky",
] as const;
const SANDBOX_PROTECTED_ROOT_ENTRIES = [...new Set([
  ...PROTECTED_ROOT_ENTRIES.filter(entry => !isSandboxGitMetadataEntry(entry)), ...SANDBOX_LOADER_ENTRIES,
])];

// Linux discovery depth; the admitted root is depth zero.
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
const LINUX_GIT_CONTROL_ENTRIES = [...GIT_CONTROL_ENTRIES, "info/attributes"] as const;
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
interface GitControlEntryIdentity {
  readonly dev: number | bigint;
  readonly ino: number | bigint;
  readonly size: number | bigint;
  readonly mtimeMs: number | bigint;
  readonly ctimeMs: number | bigint;
  readonly kind: "directory" | "file" | "link" | "other";
}
export interface SandboxGitControlSnapshot {
  readonly isPathExcluded?: (path: string, includesChildren?: boolean) => boolean;
  readonly bareRoots: ReadonlySet<string>;
  readonly roots: ReadonlyMap<string, GitControlEntryIdentity | undefined>;
  readonly entries: ReadonlyMap<string, GitControlEntryIdentity | undefined>;
  readonly markers: ReadonlyMap<string, GitControlEntryIdentity | undefined>;
  readonly stores: ReadonlyMap<string, GitControlEntryIdentity | undefined>;
  readonly markerStores: ReadonlyMap<string, readonly string[]>;
  readonly replacedMarkers: ReadonlySet<string>;
  readonly directories: ReadonlyMap<string, GitControlEntryIdentity | undefined>;
  readonly directoryTargets: ReadonlyMap<string, string>;
  readonly directoryDepths?: ReadonlyMap<string, number>;
  readonly storeMissingAncestors: ReadonlyMap<string, string>;
}
interface GitControlDiscovery {
  loaderPaths?: Set<string>;
  isPathExcluded?: (path: string, includesChildren?: boolean) => boolean;
  roots: readonly string[];
  cleanup: boolean;
  quarantineRoot: string;
  markers: Map<string, GitControlEntryIdentity | undefined>;
  stores: Map<string, GitControlEntryIdentity | undefined>;
  markerStores: Map<string, readonly string[]>;
  replacedMarkers: Set<string>;
  directories: Map<string, GitControlEntryIdentity | undefined>;
  directoryTargets: Map<string, string>;
  directoryDepths: Map<string, number>;
  storeMissingAncestors: Map<string, string>;
  scannedStores: Set<string>;
  bareEntries: Map<string, GitControlEntryIdentity | undefined>;
  previous?: SandboxGitControlSnapshot;
}
function gitControlEntries(discovery?: GitControlDiscovery): readonly string[] {
  return process.platform === "linux" || discovery ? LINUX_GIT_CONTROL_ENTRIES : GIT_CONTROL_ENTRIES;
}
function gitEntryIdentity(path: string): GitControlEntryIdentity | undefined {
  let stat;
  try { stat = lstatSync(path); }
  catch (error) { if (isMissingPath(error)) return undefined; throw error; }
  return {
    dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs,
    kind: stat.isDirectory() ? "directory" : stat.isFile() ? "file" : stat.isSymbolicLink() ? "link" : "other",
  };
}
function sameGitEntry(left: GitControlEntryIdentity | undefined, right: GitControlEntryIdentity | undefined): boolean {
  return left !== undefined && right !== undefined && left.dev === right.dev && left.ino === right.ino && left.kind === right.kind;
}
const gitScanIgnoredDirectories = new Set([
  ".git", ".hg", ".svn", "node_modules", ".venv", "venv", "vendor", "dist", "build", ".cache",
]);

// Canonical snapshots use forward slashes, independent of the native separator.
function isCanonicalPathWithin(root: string, path: string): boolean {
  const foldedRoot = process.platform === "win32" ? root.toLowerCase() : root;
  const foldedPath = process.platform === "win32" ? path.toLowerCase() : path;
  return foldedPath === foldedRoot
    || foldedPath.startsWith(foldedRoot.endsWith("/") ? foldedRoot : `${foldedRoot}/`);
}

// Physical snapshots retain Unicode and POSIX backslashes as filesystem identity.
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

function minimalLiteralDenyPaths(paths: readonly string[], inherited: readonly string[]): string[] {
  const keyFor = (path: string) => process.platform === "win32" ? path.toLowerCase() : path;
  const inheritedKeys = new Set(inherited.map(path => {
    while (path.endsWith(sep) && dirname(path) !== path) path = path.slice(0, -1);
    return keyFor(path);
  }));
  const retained = new Set(inheritedKeys);
  for (const path of [...paths].sort((left, right) => left.length - right.length)) {
    const key = keyFor(path);
    if (retained.has(key)) continue;
    let parent = dirname(key);
    while (parent !== dirname(parent) && !retained.has(parent)) parent = dirname(parent);
    if (!retained.has(parent)) retained.add(key);
  }
  const emitted = new Set<string>();
  return paths.filter(path => {
    const key = keyFor(path);
    if (inheritedKeys.has(key) || !retained.has(key) || emitted.has(key)) return false;
    emitted.add(key);
    return true;
  });
}

function addGitMetadataTarget(path: string, cwd: string, paths: Set<string>, routingPins: Set<string>, discovery?: GitControlDiscovery): string {
  const resolved = inspectPhysicalFilesystemPath(path, cwd, MAX_MISSING_PATH_ANCESTORS);
  if (resolved.unresolvedParentTraversal) {
    throw new Error("Sandbox Git control metadata has unresolved parent traversal");
  }
  if (resolved.firstMissingPath !== undefined) {
    paths.add(resolved.path);
    paths.add(resolved.firstMissingPath);
    discovery?.storeMissingAncestors.set(resolved.path, resolved.firstMissingPath);
  }
  for (const routingPath of resolved.routingSymlinkPaths) routingPins.add(routingPath);
  return resolved.path;
}

function addProtectedRoutingPins(path: string, routingPins: Set<string>, deniedPaths?: ReadonlySet<string>): void {
  try {
    const resolved = inspectPhysicalFilesystemPath(path, process.cwd(), MAX_MISSING_PATH_ANCESTORS);
    if (resolved.firstMissingPath !== undefined && lstatSync(dirname(resolved.firstMissingPath), { throwIfNoEntry: false })?.isFile()) {
      // Some native APIs report a child below a regular file as missing. The
      // existing ancestor proof must still establish that the blocker is denied.
      throw Object.assign(new Error("ENOTDIR: sandbox control path has a regular-file ancestor"), { code: "ENOTDIR" });
    }
    for (const routingPath of resolved.routingSymlinkPaths) routingPins.add(routingPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOTDIR") {
      let ancestor = dirname(path);
      for (let depth = 0; depth < MAX_MISSING_PATH_ANCESTORS; depth += 1) {
        let entry: Stats;
        try { entry = lstatSync(ancestor); }
        catch (inspectionError) {
          if (!isMissingPath(inspectionError)) throw inspectionError;
          const parent = dirname(ancestor);
          if (parent === ancestor) break;
          ancestor = parent;
          continue;
        }
        const physical = resolvePolicyPath(ancestor, process.cwd());
        // A denied regular entry cannot contain children until that protected
        // entry is replaced. Retain its own routing pins before omitting the
        // structurally impossible descendant, including prior deny placeholders.
        if ((entry.isFile() || entry.isSymbolicLink() && lstatSync(physical).isFile())
          && (basename(ancestor) === ".git" || deniedPaths?.has(ancestor))) {
          addProtectedRoutingPins(ancestor, routingPins);
          return;
        }
        break;
      }
    }
    throw error;
  }
}

// Compare filesystem grants, including canonical Windows aliases and casing.
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

// No pipes, links or unbounded reads may turn discovery into an arbitrary file read.
function readGitMetadata(path: string, budget: GitDiscoveryBudget): string | undefined {
  let fd: number;
  let entry: BigIntStats | undefined;
  try {
    if (constants.O_NOFOLLOW === undefined) {
      // Windows file IDs are 64-bit; Number stats can round two IDs together.
      entry = lstatSync(path, { bigint: true });
      if (!entry.isFile()) throw new Error("Invalid sandbox Git control metadata");
    }
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
  }
  catch (error) { if (isMissingPath(error)) return undefined; throw error; }
  try {
    if (entry !== undefined) {
      const opened = fstatSync(fd, { bigint: true });
      if (entry.dev !== opened.dev || entry.ino !== opened.ino) throw new Error("Sandbox Git metadata changed during discovery");
    }
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
    // Only terminal CR/LF bytes delimit these control records. Other whitespace is path data, including a trailing space, tab or NBSP.
    return decoded.replace(/[\r\n]+$/u, "");
  } finally { closeSync(fd); }
}


// Read only the path-bearing configuration subset; unknown settings never execute.
// Conditional includes are over-approximated, so a later condition change cannot expose hooks.
function decodeGitConfigPath(value: string): string {
  let result = "";
  let quoted = false;
  let pendingSpace = "";
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (!quoted && (character === "#" || character === ";")) break;
    if (character === '"') { result += pendingSpace; pendingSpace = ""; quoted = !quoted; continue; }
    if (character === "\\") {
      const escaped = value[++index];
      const escapes: Record<string, string> = { n: "\n", t: "\t", b: "\b", "\\": "\\", '"': '"' };
      if (escaped === undefined || escapes[escaped] === undefined) throw new Error("Invalid sandbox Git configuration path escape");
      result += pendingSpace + escapes[escaped]; pendingSpace = "";
      continue;
    }
    if (!quoted && /[ \t]/u.test(character)) { if (result) pendingSpace += character; continue; }
    result += pendingSpace + character; pendingSpace = "";
  }
  if (quoted || !result || /[\0\r\n]/u.test(result) || result.includes("%(")) throw new Error("Unsupported sandbox Git configuration path");
  return result;
}

function expandGitConfigurationPath(path: string): string {
  if (path === "~" || path.startsWith("~/")) {
    const home = process.env.HOME ?? process.env.USERPROFILE;
    if (!home) throw new Error("Sandbox Git configuration home is unavailable");
    return join(home, path.slice(2));
  }
  if (path.startsWith("~")) throw new Error("Named-home sandbox Git configuration paths are unsupported");
  return path;
}

function addConfiguredGitHookPaths(
  configuration: string, workingDirectories: readonly string[], paths: Set<string>, routingPins: Set<string>,
  budget: GitDiscoveryBudget, visited = new Set<string>(), depth = 0, protectMissing = true,
): void {
  if (depth > 10) throw new Error("Sandbox Git configuration include depth exceeded");
  const configPath = resolvePolicyDenyPath(configuration);
  if (visited.has(configPath)) return;
  visited.add(configPath);
  const content = readGitMetadata(configPath, budget);
  if (content !== undefined || protectMissing) {
    paths.add(configuration);
    paths.add(configPath);
    addProtectedRoutingPins(configuration, routingPins);
  }
  if (content === undefined) return;
  let section = "";
  const logicalLines: string[] = [];
  let current = "";
  for (const line of content.split(/\r?\n/u)) {
    current += line;
    const trailing = /\\+$/u.exec(current)?.[0].length ?? 0;
    if (trailing % 2 === 1) { current = current.slice(0, -1); continue; }
    logicalLines.push(current); current = "";
  }
  if (current) throw new Error("Invalid sandbox Git configuration continuation");
  for (const line of logicalLines) {
    const header = /^\s*\[([^\]]+)\]/u.exec(line);
    if (header) section = header[1]!.trim().toLowerCase();
    const body = header ? line.slice(header[0].length) : line;
    const setting = /^\s*([a-z][a-z0-9-]*)\s*=\s*(.*)$/iu.exec(body);
    if (!setting) continue;
    const key = setting[1]!.toLowerCase();
    if (section === "core" && key === "hookspath") {
      const target = expandGitConfigurationPath(decodeGitConfigPath(setting[2]!));
      // A POSIX null device cannot contain hooks; retaining its ordinary write role is necessary for shell redirection.
      if (process.platform !== "win32" && target === "/dev/null") continue;
      for (const cwd of workingDirectories) {
        const resolved = resolve(target.startsWith("/") || isAbsolute(target) ? target : join(cwd, target));
        paths.add(resolved);
        paths.add(resolvePolicyDenyPath(resolved));
        addProtectedRoutingPins(resolved, routingPins);
      }
    } else if ((section === "include" || /^includeif\s+"/u.test(section)) && key === "path") {
      const included = expandGitConfigurationPath(decodeGitConfigPath(setting[2]!));
      addConfiguredGitHookPaths(resolve(dirname(configPath), included), workingDirectories, paths, routingPins, budget, visited, depth + 1);
    }
  }
}

function addInheritedGitConfigHookPaths(workingDirectories: readonly string[], paths: Set<string>, routingPins: Set<string>, budget: GitDiscoveryBudget): void {
  const home = process.env.HOME ?? process.env.USERPROFILE;
  const configs = new Set([
    ...(process.env.GIT_CONFIG_NOSYSTEM === "1" ? [] : [process.env.GIT_CONFIG_SYSTEM ?? "/etc/gitconfig"]),
    ...(process.platform === "darwin" && process.env.GIT_CONFIG_SYSTEM === undefined ? ["/usr/local/etc/gitconfig", "/opt/homebrew/etc/gitconfig"] : []),
    ...(process.env.GIT_CONFIG_GLOBAL ? [process.env.GIT_CONFIG_GLOBAL] : home ? [join(home, ".gitconfig"), join(process.env.XDG_CONFIG_HOME ?? join(home, ".config"), "git", "config")] : []),
  ]);
  for (const config of configs) addConfiguredGitHookPaths(config, workingDirectories, paths, routingPins, budget);
}

function addInheritedGitHookPaths(roots: readonly string[], paths: Set<string>, routingPins: Set<string>, budget: GitDiscoveryBudget): void {
  addInheritedGitConfigHookPaths(roots, paths, routingPins, budget);
  for (const root of roots) {
    let current = root;
    for (let depth = 0; depth < MAX_REPOSITORY_ANCESTORS; depth += 1) {
      const marker = join(current, ".git");
      let identity;
      try { identity = lstatSync(marker); }
      catch (error) { if (!isMissingPath(error)) throw error; }
      if (identity?.isSymbolicLink()) throw new Error("Linked sandbox Git markers are unsupported");
      if (identity?.isDirectory() || identity?.isFile()) {
        let gitDir = marker;
        if (identity.isFile()) {
          const pointer = readGitMetadata(marker, budget) ?? "";
          const match = /^gitdir: ([^\r\n\0]+)$/u.exec(pointer);
          if (match === null) break;
          gitDir = resolvePolicyPath(match[1]!, current);
        }
        const contexts = [current, gitDir];
        for (const name of ["config", "config.worktree"]) addConfiguredGitHookPaths(join(gitDir, name), contexts, paths, routingPins, budget, new Set(), 0, false);
        const commonPath = readGitMetadata(join(gitDir, "commondir"), budget);
        if (commonPath !== undefined) {
          if (!commonPath || /[\r\n\0]/u.test(commonPath)) throw new Error("Invalid sandbox Git common directory");
          const commonDir = resolvePolicyPath(commonPath, gitDir);
          addConfiguredGitHookPaths(join(commonDir, "config"), contexts, paths, routingPins, budget, new Set(), 0, false);
        }
        break;
      }
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
      if (depth === MAX_REPOSITORY_ANCESTORS - 1) throw new Error("Sandbox Git hook ancestry exceeds its depth limit");
    }
  }
}

function hasGitHead(directory: string): boolean {
  try { return lstatSync(join(directory, "HEAD")).isFile(); }
  catch (error) { if (isMissingPath(error)) return false; throw error; }
}

// Filesystem-only classification; a bare layout deliberately remains a non-worktree root.
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
  gitDir: string | readonly string[],
  paths: Set<string>,
  routingPins: Set<string>,
  budget: GitDiscoveryBudget,
  discovery?: GitControlDiscovery,
  relatedStores?: Set<string>,
): boolean {
  const queue = typeof gitDir === "string" ? [gitDir] : [...gitDir];
  const visited = discovery?.previous ? discovery.scannedStores : new Set<string>();
  for (let index = 0; index < queue.length; index += 1) {
    const directory = queue[index]!;
    if (visited.has(directory)) continue;
    visited.add(directory);
    if (discovery?.isPathExcluded?.(directory)) continue;
    relatedStores?.add(directory);
    if (discovery?.previous && discovery.cleanup && !discovery.roots.some(root =>
      isPhysicalPathWithin(root, directory) || isPhysicalPathWithin(directory, root))) {
      discovery.stores.set(directory, discovery.previous.stores.get(directory));
      continue;
    }
    const missingAncestor = discovery?.previous?.storeMissingAncestors.get(directory);
    if (discovery && missingAncestor !== undefined) {
      discovery.storeMissingAncestors.set(directory, missingAncestor);
      discovery.stores.set(directory, undefined);
      if (!discovery.isPathExcluded?.(missingAncestor) && gitEntryIdentity(missingAncestor) !== undefined) {
        paths.add(missingAncestor);
        discovery.replacedMarkers.add(missingAncestor);
      }
      continue;
    }
    const identity = gitEntryIdentity(directory);
    discovery?.stores.set(directory, identity);
    if (discovery && !discovery.previous) {
      const commonPath = readGitMetadata(join(directory, "commondir"), budget);
      if (commonPath !== undefined) {
        if (!commonPath || /[\r\n\0]/.test(commonPath)) throw new Error("Invalid sandbox Git common directory");
        queue.push(addGitMetadataTarget(commonPath, directory, paths, routingPins, discovery));
      }
    }
    if (discovery?.cleanup && !discovery.roots.some(root =>
      isPhysicalPathWithin(root, directory) || isPhysicalPathWithin(directory, root))) continue;
    if (discovery?.previous && !discovery.previous.stores.has(directory)) {
      paths.add(directory);
      discovery.replacedMarkers.add(directory);
      continue;
    }
    if (discovery?.previous?.stores.has(directory)
      && (discovery.previous.stores.get(directory) !== undefined || identity !== undefined)
      && !sameGitEntry(discovery.previous.stores.get(directory), identity)) {
      if (discovery.previous.stores.get(directory) === undefined && identity !== undefined) {
        paths.add(directory);
        discovery.replacedMarkers.add(directory);
        continue;
      }
      throw new Error("Sandbox Git metadata store identity changed during invocation");
    }
    if (!discovery?.previous && !discovery?.cleanup) {
      addInheritedGitConfigHookPaths([directory, dirname(directory)], discovery?.loaderPaths ?? paths, routingPins, budget);
      for (const name of ["config", "config.worktree"]) addConfiguredGitHookPaths(join(directory, name), [directory, dirname(directory)], discovery?.loaderPaths ?? paths, routingPins, budget, new Set(), 0, false);
    }
    for (const entry of gitControlEntries(discovery)) paths.add(join(directory, entry));
    if ([...paths, ...routingPins].reduce((bytes, path) => bytes + Buffer.byteLength(path), 0) > MAX_GIT_ROOT_POLICY_BYTES) return false;
    for (const containerName of ["modules", "worktrees"]) {
      const container = join(directory, containerName);
      if (discovery?.isPathExcluded?.(container)) continue;
      let stat;
      try { stat = lstatSync(container); }
      catch (error) { if (isMissingPath(error)) { paths.add(container); continue; } throw error; }
      if (stat.isSymbolicLink()) {
        if (!discovery?.previous) addProtectedRoutingPins(container, routingPins);
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
            if (discovery?.isPathExcluded?.(nested)) continue;
            let stat;
            try { stat = lstatSync(nested); }
            catch (error) { if (isMissingPath(error)) continue; return false; }
            if (stat.isSymbolicLink()) {
              paths.add(nested);
              if (!discovery?.previous) addProtectedRoutingPins(nested, routingPins);
              continue;
            }
            if (!stat.isDirectory()) continue;
            if (discovery?.previous && !discovery.previous.stores.has(nested)) {
              discovery.stores.set(nested, gitEntryIdentity(nested));
              paths.add(nested);
              discovery.replacedMarkers.add(nested);
              continue;
            }
            // Metadata stores are identified by HEAD just like worktree markers. Grouping directories are still traversed for nested submodule names.
            if (hasGitHead(nested) || containerName === "worktrees") queue.push(nested);
            else {
              // An existing grouping directory can become a module store in the same invocation; protect its future controls as well.
              discovery?.stores.set(nested, gitEntryIdentity(nested));
              if (discovery) queue.push(nested);
              for (const control of gitControlEntries(discovery)) paths.add(join(nested, control));
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

// Capture the bounded Linux control set without creating missing mount targets. A post-command pass uses only pre-resolved stores: newly introduced routing bytes and marker links never choose a host path for quarantine.
export function snapshotSandboxGitControls(
  writeRoots: readonly string[], previous?: SandboxGitControlSnapshot,
): SandboxGitControlSnapshot {
  if (previous) previous = restrictSandboxGitControlSnapshot(previous, writeRoots);
  const roots = previous ? new Map(previous.roots) : new Map(
    [...new Set(writeRoots.map(root => resolvePolicyPath(root, process.cwd())))].map(root => [root, gitEntryIdentity(root)] as const),
  );
  const discovery: GitControlDiscovery = {
    roots: [...roots.keys()], markers: new Map(), stores: new Map(), markerStores: new Map(), replacedMarkers: new Set(),
    directories: new Map(), directoryTargets: new Map(), directoryDepths: new Map(), storeMissingAncestors: new Map(), scannedStores: new Set(), bareEntries: new Map(),
    cleanup: true, quarantineRoot: resolvePolicyPath(sandboxQuarantineRoot(), process.cwd()),
    ...(previous?.isPathExcluded ? { isPathExcluded: previous.isPathExcluded } : {}),
    ...(previous ? { previous } : {}),
  };
  const paths = new Set<string>();
  const pins = new Set<string>();
  const budget: GitDiscoveryBudget = { entries: MAX_GIT_SCAN_ENTRIES, metadataBytes: MAX_GIT_METADATA_TOTAL_BYTES };
  const bareRoots = previous?.bareRoots ?? new Set(classifyNonRepositoryWriteRoots([...roots.keys()], budget));
  for (const root of bareRoots) for (const name of [...SANDBOX_BARE_REPOSITORY_ENTRIES, "hooks"]) {
    const path = join(root, name);
    if (!discovery.isPathExcluded?.(path)) discovery.bareEntries.set(path, gitEntryIdentity(path));
  }
  for (const [root, identity] of roots) {
    if (discovery.isPathExcluded?.(root)) continue;
    if (isPhysicalPathWithin(resolvePolicyPath(sandboxQuarantineRoot(), process.cwd()), root)) continue;
    const current = gitEntryIdentity(root);
    if (identity !== undefined && !sameGitEntry(identity, current)) {
      throw new Error("Sandbox Git cleanup write root identity changed during invocation");
    }
    if (current === undefined) continue;
    if (current.kind !== "directory" || realpathSync.native(root) !== root) {
      throw new Error("Sandbox Git cleanup write root is not a physical directory");
    }
    if (!addGitControlPaths(join(root, ".git"), paths, pins, budget, discovery)
      || !addNestedGitControlPaths(root, paths, pins, budget, discovery)) {
      throw new Error("Sandbox Git cleanup scan could not complete within its discovery budget");
    }
  }
  if (previous) {
    const stores = [...new Set([...previous.markerStores.values()].flat())].filter(store =>
      ![...discovery.replacedMarkers].some(marker => isPhysicalPathWithin(marker, store)));
    if (!addGitDirectoryControls(stores, paths, pins, budget, discovery)) {
      throw new Error("Sandbox Git cleanup scan could not complete within its discovery budget");
    }
  }
  return finishGitControlSnapshot(roots, bareRoots, discovery, paths);
}

// Narrow the captured grant set without re-reading or trusting later metadata.
export function restrictSandboxGitControlSnapshot(
  snapshot: SandboxGitControlSnapshot, effectiveWriteRoots: readonly string[],
  isPathExcluded?: (path: string, includesChildren?: boolean) => boolean,
): SandboxGitControlSnapshot {
  const effective = new Set(effectiveWriteRoots.map(root => resolve(root)));
  const excluded = snapshot.isPathExcluded && isPathExcluded
    ? (path: string, includesChildren?: boolean): boolean => snapshot.isPathExcluded!(path, includesChildren) || isPathExcluded(path, includesChildren)
    : isPathExcluded ?? snapshot.isPathExcluded;
  const roots = new Map([...snapshot.roots].filter(([root]) => effective.has(root) && !excluded?.(root)));
  const withinRoots = (path: string): boolean => !excluded?.(path) && [...roots.keys()].some(root => isPhysicalPathWithin(root, path));
  const markerStores = new Map([...snapshot.markerStores].filter(([marker]) =>
    [...roots.keys()].some(root => isPhysicalPathWithin(root, marker))));
  const referencedStores = new Set([...markerStores.values()].flat());
  return {
    roots,
    bareRoots: new Set([...snapshot.bareRoots].filter(root => roots.has(root))),
    entries: new Map([...snapshot.entries].filter(([path]) => withinRoots(path))),
    markers: new Map([...snapshot.markers].filter(([path]) => withinRoots(path))),
    directories: new Map([...snapshot.directories].filter(([path]) => withinRoots(path))),
    directoryTargets: new Map([...snapshot.directoryTargets].filter(([path]) => withinRoots(path))),
    ...(snapshot.directoryDepths ? { directoryDepths: new Map([...snapshot.directoryDepths].filter(([path]) => withinRoots(path))) } : {}),
    storeMissingAncestors: new Map([...snapshot.storeMissingAncestors].filter(([path]) => withinRoots(path) || referencedStores.has(path))),
    stores: new Map([...snapshot.stores].filter(([path]) => withinRoots(path) || referencedStores.has(path))),
    markerStores,
    replacedMarkers: new Set([...snapshot.replacedMarkers].filter(withinRoots)),
    ...(excluded ? { isPathExcluded: excluded } : {}),
  };
}

function finishGitControlSnapshot(
  roots: ReadonlyMap<string, GitControlEntryIdentity | undefined>, bareRoots: ReadonlySet<string>,
  discovery: GitControlDiscovery, paths: ReadonlySet<string>,
): SandboxGitControlSnapshot {
  const entries = new Map<string, GitControlEntryIdentity | undefined>();
  for (const path of new Set([...paths, ...discovery.markers.keys()])) {
    if (!discovery.isPathExcluded?.(path) && [...roots.keys()].some(root => isPhysicalPathWithin(root, path))) entries.set(path, gitEntryIdentity(path));
  }
  for (const root of bareRoots) for (const name of [...SANDBOX_BARE_REPOSITORY_ENTRIES, "hooks"]) {
    if (!discovery.isPathExcluded?.(join(root, name))) entries.set(join(root, name), discovery.bareEntries.get(join(root, name)));
  }
  return {
    roots, bareRoots, entries, markers: discovery.markers, stores: discovery.stores, markerStores: discovery.markerStores,
    replacedMarkers: discovery.replacedMarkers,
    directories: discovery.directories,
    directoryTargets: discovery.directoryTargets,
    directoryDepths: discovery.directoryDepths,
    storeMissingAncestors: discovery.storeMissingAncestors,
    ...(discovery.isPathExcluded ? { isPathExcluded: discovery.isPathExcluded } : {}),
  };
}

function addGitControlPaths(
  marker: string,
  paths: Set<string>,
  routingPins: Set<string>,
  budget: GitDiscoveryBudget,
  discovery?: GitControlDiscovery,
): boolean {
  if (discovery?.isPathExcluded?.(marker)) return true;
  let entry;
  try { entry = lstatSync(marker); }
  catch (error) {
    if (isMissingPath(error)) { paths.add(marker); discovery?.markers.set(marker, undefined); return true; }
    if (["EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      return false;
    }
    throw error;
  }
  const markerIdentity = gitEntryIdentity(marker);
  discovery?.markers.set(marker, markerIdentity);
  if (discovery?.previous) {
    const original = discovery.previous.markers.get(marker);
    const unchanged = sameGitEntry(original, markerIdentity)
      && (markerIdentity?.kind !== "file" || (original !== undefined && markerIdentity !== undefined && original.size === markerIdentity.size
        && original.mtimeMs === markerIdentity.mtimeMs && original.ctimeMs === markerIdentity.ctimeMs));
    if (!unchanged) {
      paths.add(marker);
      discovery.replacedMarkers.add(marker);
      return true;
    }
    const stores = discovery.previous.markerStores.get(marker) ?? [];
    discovery.markerStores.set(marker, stores);
    return addGitDirectoryControls(stores, paths, routingPins, budget, discovery);
  }
  if (!entry.isDirectory()) paths.add(marker);
  // A marker link is not a supported repository pointer. Never read its target as host metadata; regular gitdir pointer files cover linked worktrees.
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
    gitDir = addGitMetadataTarget(match[1]!, dirname(marker), paths, routingPins, discovery);
  } else if (!entry.isDirectory()) {
    throw new Error("Invalid sandbox Git marker");
  }
  // Inherited relative hook paths are relative to each discovered repository, not its covering write grant.
  addInheritedGitConfigHookPaths([dirname(marker), gitDir], discovery?.loaderPaths ?? paths, routingPins, budget);
  discovery?.markerStores.set(marker, [gitDir]);
  const relatedStores = discovery ? new Set<string>() : undefined;
  if (!addGitDirectoryControls(gitDir, paths, routingPins, budget, discovery, relatedStores)) return false;
  if (discovery && relatedStores) {
    discovery.markerStores.set(marker, [...relatedStores]);
    return true;
  }
  const commonPath = readGitMetadata(join(gitDir, "commondir"), budget);
  if (commonPath === undefined) return true;
  if (!commonPath || /[\r\n\0]/.test(commonPath)) throw new Error("Invalid sandbox Git common directory");
  const commonDir = addGitMetadataTarget(commonPath, gitDir, paths, routingPins);
  discovery?.markerStores.set(marker, [gitDir, commonDir]);
  return addGitDirectoryControls(commonDir, paths, routingPins, budget, discovery);
}

function addNestedGitControlPaths(
  root: string,
  paths: Set<string>,
  routingPins: Set<string>,
  budget: GitDiscoveryBudget,
  discovery?: GitControlDiscovery,
): boolean {
  if (budget.entries <= 0) return false;
  let canonicalRoot: string;
  try { canonicalRoot = realpathSync.native(root); }
  catch (error) { return isMissingPath(error); }
  if (!isPhysicalPathWithin(root, canonicalRoot) || !isPhysicalPathWithin(canonicalRoot, root)) return false;
  const queue = [{ path: root, depth: 0 }, ...(discovery?.previous ? [...discovery.previous.directoryTargets.keys()]
    .filter(path => isPhysicalPathWithin(root, path))
    .map(path => ({ path, depth: discovery.previous!.directoryDepths?.get(path) ?? SANDBOX_GIT_SCAN_DEPTH })) : [])];
  const visited = new Set<string>();
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index]!;
    if (discovery?.isPathExcluded?.(current.path)) continue;
    discovery?.directoryDepths.set(current.path, current.depth);
    const routeIdentity = discovery ? gitEntryIdentity(current.path) : undefined;
    if (discovery?.previous && routeIdentity?.kind === "link"
      && !discovery.previous.directoryTargets.has(current.path)
      && !sameGitEntry(discovery.previous.directories.get(current.path), routeIdentity)) {
      discovery.directories.set(current.path, routeIdentity);
      continue;
    }
    let canonical: string;
    if (discovery?.previous?.directoryTargets.has(current.path)) {
      const frozenTarget = discovery.previous.directoryTargets.get(current.path);
      discovery.directories.set(current.path, routeIdentity);
      if (frozenTarget === undefined) {
        discovery.replacedMarkers.add(current.path);
        continue;
      }
      discovery.directoryTargets.set(current.path, frozenTarget);
      try {
        if (realpathSync.native(current.path) !== frozenTarget
          || !sameGitEntry(discovery.previous.directories.get(current.path), gitEntryIdentity(current.path))) discovery.replacedMarkers.add(current.path);
      } catch {
        discovery.replacedMarkers.add(current.path);
      }
      if (!isPhysicalPathWithin(canonicalRoot, frozenTarget) || discovery.isPathExcluded?.(frozenTarget)) continue;
      if (!sameGitEntry(discovery.previous.directories.get(frozenTarget), gitEntryIdentity(frozenTarget))
        || realpathSync.native(frozenTarget) !== frozenTarget) {
        throw new Error("Sandbox Git directory route target identity changed during invocation");
      }
      canonical = frozenTarget;
    } else {
      try { canonical = realpathSync.native(current.path); }
      catch (error) { if (isMissingPath(error)) continue; return false; }
    }
    if (discovery?.isPathExcluded?.(canonical)) continue;
    if (discovery && !discovery.previous && routeIdentity?.kind === "link") {
      if (!sameGitEntry(routeIdentity, gitEntryIdentity(current.path))) return false;
      discovery.directories.set(current.path, routeIdentity);
      discovery.directoryTargets.set(current.path, canonical);
    }
    // A directory link may be followed only within this admitted root. Another admitted root is discovered separately with the same invocation budget.
    if (!isPhysicalPathWithin(canonicalRoot, canonical)) continue;
    if (visited.has(canonical)) continue;
    visited.add(canonical);
    discovery?.directories.set(canonical, gitEntryIdentity(canonical));
    const beforePathCount = paths.size;
    const beforeRoutingPinCount = routingPins.size;
    if (current.depth > 0) {
      const marker = join(discovery ? canonical : current.path, ".git");
      let entry;
      try { if (!discovery?.isPathExcluded?.(marker)) entry = lstatSync(marker); }
      catch (error) { if (!isMissingPath(error)) return false; }
      // A directory repository is identified by its HEAD marker. Pointer files remain controls even if their target is not yet a valid repository.
      if (entry !== undefined && (discovery || process.platform === "linux" || !entry.isDirectory() || hasGitHead(marker))) {
        if (!addGitControlPaths(marker, paths, routingPins, budget, discovery)) return false;
      }
    }
    if ((paths.size !== beforePathCount || routingPins.size !== beforeRoutingPinCount)
      && [...paths, ...routingPins].reduce((bytes, path) => bytes + Buffer.byteLength(path), 0) > MAX_GIT_ROOT_POLICY_BYTES) return false;
    // Glob rules cover controls named beneath.git, but an existing pointer can route them to an arbitrary directory name. Discover every macOS indirection, including dependency and metadata trees, or revoke the incomplete grant when the shared entry/path budgets are exhausted.
    if ((discovery || process.platform !== "darwin") && current.depth === SANDBOX_GIT_SCAN_DEPTH) continue;
    let directory;
    try { directory = opendirSync(discovery ? canonical : current.path); }
    catch (error) { if (isMissingPath(error)) continue; return false; }
    try {
      for (let entry = directory.readSync(); entry !== null; entry = directory.readSync()) {
        if (budget.entries-- <= 0) {
          return false;
        }
        if ((discovery || process.platform !== "darwin") && gitScanIgnoredDirectories.has(entry.name.toLowerCase())) continue;
        const child = join(discovery ? canonical : current.path, entry.name);
        if (discovery && isPhysicalPathWithin(discovery.quarantineRoot, child)) continue;
        let descend = entry.isDirectory() || entry.isSymbolicLink();
        // Some filesystems return DT_UNKNOWN. Such an entry is not evidence that a directory cannot contain protected metadata.
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

// Sensitive/application literal denies include absent paths. Linux Git controls alone use existing entries plus a recoverable post-command quarantine sweep. Store locations come from their writers so changing a layout also changes this boundary. Routing paths supply identity only. Inherited write denies must be absolute literal denies independently emitted in the caller's final union; they can cover redundant descendants after every target is resolved.
export function buildMandatorySandboxWritePolicy(
  writeRoots: readonly FilesystemPathEntry[],
  userDataDir?: string,
  protectedRoutingPaths: readonly string[] = [],
  inheritedWriteDenies: readonly string[] = [],
): Pick<FilesystemConfig, "denyWrite"> & {
  allowWrite: string[];
  narrowedWriteRoots: readonly { root: string; reason: "entry-budget" | "path-budget" | "filesystem-access" | "routing-link" }[];
  gitControlSnapshot?: SandboxGitControlSnapshot;
} {
  if (inheritedWriteDenies.some(path => !isAbsolute(path) || /[*?\[\]]/.test(path))) throw new Error("Invalid inherited sandbox write deny");
  const rootSnapshots = writeRoots.map(entry => {
    const original = typeof entry === "string" ? entry : entry.path;
    // A marked literal already carries the admitted identity; discovery must retain that canonical path.
    return { original, physical: typeof entry === "string" ? resolvePolicyPath(original, process.cwd()) : original };
  });
  const paths = new Set([
    ...rootSnapshots.flatMap(({ original, physical }) => [original, physical]).flatMap((root) =>
      SANDBOX_PROTECTED_ROOT_ENTRIES.map((entry) => join(root, entry))),
    // The configuration directory is a control boundary, including future files.
    join(aveHome(), AVE_HOME_CONFIGURATION_DIRECTORY),
    permissionSettingsPath(),
    userApprovalFilePath(),
    egressGrantFilePath(),
    userPolicyPath(),
    getAdminPolicyPath(),
    permissionsFilePath(),
    sandboxQuarantineRoot(),
    dirname(projectRulesDirectory(aveHome())),
    ...(userDataDir === undefined ? [] : [settingsFilePath(userDataDir)]),
  ]);
  const budget = { entries: MAX_GIT_SCAN_ENTRIES, metadataBytes: MAX_GIT_METADATA_TOTAL_BYTES };
  const routingPins = new Set<string>();
  const roots = [...new Set(rootSnapshots.map(root => root.physical))];
  addInheritedGitHookPaths(roots, paths, routingPins, budget);
  const rootIdentities = new Map(roots.map(root => [root, gitEntryIdentity(root)] as const));
  const bareRoots = new Set(classifyNonRepositoryWriteRoots(roots, budget));
  const gitDiscovery: GitControlDiscovery | undefined = process.platform === "linux" ? {
    roots, loaderPaths: paths, cleanup: false, quarantineRoot: resolvePolicyPath(sandboxQuarantineRoot(), process.cwd()),
    markers: new Map(), stores: new Map(), markerStores: new Map(), replacedMarkers: new Set(), directories: new Map(), directoryTargets: new Map(), directoryDepths: new Map(), storeMissingAncestors: new Map(), scannedStores: new Set(), bareEntries: new Map(),
  } : undefined;
  for (const root of bareRoots) {
    if (gitDiscovery) for (const name of [...SANDBOX_BARE_REPOSITORY_ENTRIES, "hooks"]) {
      gitDiscovery.bareEntries.set(join(root, name), gitEntryIdentity(join(root, name)));
    }
    for (const entry of [...SANDBOX_BARE_REPOSITORY_ENTRIES, ...(hasGitHead(root) ? ["hooks"] : [])]) {
      const path = join(root, entry);
      if (process.platform === "darwin") paths.add(path);
      else {
        // Never manufacture a host bare-layout entry merely to mount a deny.
        if (gitDiscovery) {
          if (gitDiscovery.bareEntries.get(path) !== undefined) paths.add(path);
        } else {
          try { lstatSync(path); paths.add(path); }
          catch (error) { if (!isMissingPath(error)) throw error; }
        }
      }
    }
  }
  const revoked = new Set<string>();
  const narrowed = new Map<string, "entry-budget" | "path-budget" | "filesystem-access" | "routing-link">();
  const revoke = (root: string, reason: "entry-budget" | "path-budget" | "filesystem-access" | "routing-link"): void => {
    // A surviving ancestor would re-open an incompletely discovered child.
    for (const candidate of roots) if (isPhysicalPathWithin(candidate, root)) {
      revoked.add(candidate);
      narrowed.set(candidate, reason);
    }
  };
  const discovered = new Set<string>();
  const discoveredRoutingPins = new Set<string>();
  // Roots are joined with the host separator, so depth follows it rather than the policy platform.
  const separatorPattern = sep === "\\" ? /[\\/]/u : /\//u;
  // Scan narrow grants first so a broad ambient tree cannot spend the budget required by an independently admitted workspace or private temp root.
  for (const root of [...roots].sort((left, right) => right.split(separatorPattern).length - left.split(separatorPattern).length)) {
    if (revoked.has(root)) continue;
    const local = new Set<string>();
    const localRoutingPins = new Set<string>();
    if (!addGitControlPaths(join(root, ".git"), local, localRoutingPins, budget, gitDiscovery)
      || !addNestedGitControlPaths(root, local, localRoutingPins, budget, gitDiscovery)) {
      const pathBytes = [...local, ...localRoutingPins].reduce((bytes, path) => bytes + Buffer.byteLength(path), 0);
      revoke(root, budget.entries <= 0 ? "entry-budget" : pathBytes > MAX_GIT_ROOT_POLICY_BYTES ? "path-budget" : "filesystem-access");
    }
    for (const path of local) discovered.add(path);
    for (const path of localRoutingPins) discoveredRoutingPins.add(path);
  }
  if (process.platform === "linux") {
    // Missing Git binds manufacture host mountpoints and can change repository interpretation. The post-command owner handles newly created controls.
    for (const path of discovered) {
      try { lstatSync(path); }
      catch (error) { if (isMissingPath(error)) discovered.delete(path); else throw error; }
    }
    const literalWriteDenies = new Set([...paths, ...inheritedWriteDenies]);
    for (const path of paths) addProtectedRoutingPins(path, routingPins, literalWriteDenies);
    for (const path of discovered) addProtectedRoutingPins(path, discoveredRoutingPins, literalWriteDenies);
    for (const path of protectedRoutingPaths) addProtectedRoutingPins(path, routingPins, literalWriteDenies);
    // A bind mount follows a routing symlink to its target; it cannot pin the directory entry while leaving that entry's parent writable. Remove every grant that could replace the link. Independent child and sibling grants remain available because they do not make the routing parent writable.
    for (const routingPath of [...routingPins, ...discoveredRoutingPins]) {
      const routingParent = dirname(routingPath);
      for (const root of roots) {
        if (isPhysicalPathWithin(root, routingParent)) revoke(root, "routing-link");
      }
    }
  }
  const retained = roots.filter(root => !revoked.has(root));
  for (const path of discovered) {
    // Revoked roots are read-only through the default filesystem jail. Never put a deny on their ancestor: it would also override retained child grants.
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
  const resolvedDenyPaths = [...new Set([...paths].flatMap((path) => [
    path,
    resolvePolicyDenyPath(path),
  ]))];
  // Resolve every child first so a linked loader keeps its physical deny even
  // when its lexical spelling is already covered by a denied parent directory.
  // Windows may omit an inherited deny during ACL narrowing; retain its full
  // mandatory set until that later platform-specific decision has finished.
  const entries: FilesystemPathEntry[] = minimalLiteralDenyPaths(resolvedDenyPaths, process.platform === "win32" ? [] : inheritedWriteDenies)
    .map((path) => /[*?\[\]]/.test(path) ? { path, literal: true } : path);
  // Linux consumes routing links only to revoke covering grants. Replaying one as a deny bind would follow its target and could mask an unrelated subtree.
  if (process.platform !== "linux") {
    entries.push(...[...routingPins].map(path => ({ path, literal: true } as const)));
  }
  // Backend globs cover future controls at any depth without denying ordinary object, ref, index and HEAD updates in existing metadata directories.
  if (process.platform === "darwin") entries.push(...MAC_GIT_CONTROL_GLOBS);
  if (Buffer.byteLength(JSON.stringify(entries)) > MAX_GIT_POLICY_BYTES) throw new Error("Sandbox Git write policy exceeds its size limit");
  return {
    allowWrite: roots.filter(root => !revoked.has(root)), denyWrite: entries,
    narrowedWriteRoots: [...narrowed].map(([root, reason]) => ({ root, reason })),
    ...(gitDiscovery ? { gitControlSnapshot: finishGitControlSnapshot(
      new Map([...rootIdentities].filter(([root]) => !revoked.has(root))),
      new Set([...bareRoots].filter(root => !revoked.has(root))), gitDiscovery, discovered,
    ) } : {}),
  };
}
