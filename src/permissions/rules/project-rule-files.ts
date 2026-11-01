// Store project rules under app home, never in the repository; identity uses the eligible repository root or cwd canonical realpath and only rules-language specifiers are persisted.
import { readFile, mkdir, readdir } from "node:fs/promises";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { withFileLock } from "../../lib/with-file-lock.js";
import { writeUtf8FileAtomicSync, replaceUtf8FileAtomicSyncIf, isMissingPathError, PRIVATE_DIR_MODE } from "../../lib/atomic-file.js";
import { captureApprovalWorkingDirectory } from "../user-approval-store.js";
import { caseFoldForMatch } from "../sensitive-paths.js";
import type { ScopedPermissionRuleError } from "../../shared/permissions-events.js";
import type { PermissionRule } from "../permission-manager.js";
import { PermissionRulesFileCorruptError, inertRulePatterns, invalidJsonDetail, validateRuleList } from "./rule-files.js";
import { withShellPolicyMutation } from "../shell-policy-handoff.js";

import { refreshApprovalPersistence, type ApprovalPersistenceGuard } from "../approval-persistence-guard.js";

export interface ProjectRulesFile {
  version: 1;
  // Canonical project root; must agree with the file name's identity.
  projectRoot: string;
  rules: PermissionRule[];
  updatedAt: string;
}

export interface ProjectRulesLocation {
  filePath: string;
  projectRoot: string;
  identity: string;
}

const MAX_REPOSITORY_METADATA_BYTES = 65_536;

// Bound reads on the opened regular file, including concurrent growth.
function readRepositoryMetadata(path: string): string {
  const entry = lstatSync(path);
  if (!entry.isFile()) throw new Error("Invalid repository metadata");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.size > MAX_REPOSITORY_METADATA_BYTES) throw new Error("Invalid repository metadata");
    const buffer = Buffer.alloc(MAX_REPOSITORY_METADATA_BYTES + 1);
    const length = readSync(fd, buffer, 0, buffer.length, 0);
    if (length > MAX_REPOSITORY_METADATA_BYTES) throw new Error("Invalid repository metadata");
    return buffer.toString("utf8", 0, length).trim();
  } finally {
    closeSync(fd);
  }
}

function isRepositoryMarker(marker: string): boolean {
  const entry = lstatSync(marker);
  let gitDir = marker;
  if (entry.isFile()) {
    const match = /^gitdir: ([^\r\n\0]+)$/.exec(readRepositoryMetadata(marker));
    if (!match) return false;
    gitDir = resolve(dirname(marker), match[1]);
  } else if (!entry.isDirectory()) {
    return false;
  }
  if (!statSync(gitDir).isDirectory()) return false;
  const head = readRepositoryMetadata(join(gitDir, "HEAD"));
  if (!/^(?:ref: refs\/[^\s\0]+|[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/.test(head)) return false;
  let commonDir = gitDir;
  let commonPath: string | undefined;
  try {
    commonPath = readRepositoryMetadata(join(gitDir, "commondir"));
  } catch (error) {
    if (!isMissingPathError(error)) throw error;
  }
  if (commonPath !== undefined) {
    if (!commonPath || /[\r\n\0]/.test(commonPath)) return false;
    commonDir = resolve(gitDir, commonPath);
    // Linked worktrees must point back to this checkout's own marker.
    const backlink = resolve(gitDir, readRepositoryMetadata(join(gitDir, "gitdir")));
    if (captureApprovalWorkingDirectory(backlink).identity !== captureApprovalWorkingDirectory(marker).identity) return false;
  }
  return statSync(join(commonDir, "objects")).isDirectory() && statSync(join(commonDir, "refs")).isDirectory();
}

// Nearest verified marker below home; uncertain discovery stays at cwd.
export function projectRootFor(projectCwd: string): string {
  const start = captureApprovalWorkingDirectory(projectCwd).path;
  let home: string;
  try {
    const homePath = homedir();
    if (!isAbsolute(homePath)) return start;
    home = captureApprovalWorkingDirectory(homePath).path;
    if (dirname(home) === home) return start;
  } catch {
    // Without a trustworthy home boundary, project rules stay at cwd.
    return start;
  }
  const homeKey = caseFoldForMatch(home);
  for (let dir = start, guard = 0; guard < 256; guard += 1) {
    const dirKey = caseFoldForMatch(dir);
    // Home and every ancestor of home may identify only an exact-cwd session.
    if (dir !== start && (homeKey === dirKey || homeKey.startsWith(`${dirKey.replace(/\/$/, "")}/`))) break;
    try {
      if (isRepositoryMarker(join(dir, ".git"))) return dir;
      // An invalid inner marker must not inherit an outer repository's allows.
      return start;
    } catch (error) {
      if (!isMissingPathError(error)) return start;
      // A present but incomplete marker is a boundary too.
      try {
        lstatSync(join(dir, ".git"));
        return start;
      } catch (markerError) {
        if (!isMissingPathError(markerError)) return start;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return start;
}

// The directory a project rule saved from `projectCwd` applies to; shown in the dock before saving.
export function projectRuleRoot(projectCwd: string): string {
  return captureApprovalWorkingDirectory(projectRootFor(projectCwd)).path;
}

// Canonical directory shared by rule persistence and sandbox write protection.
export function projectRulesDirectory(baseDir: string): string {
  return resolve(baseDir, "permissions", "project-rules");
}

export function projectRulesLocation(baseDir: string, projectCwd: string): ProjectRulesLocation {
  const { path, identity } = captureApprovalWorkingDirectory(projectRootFor(projectCwd));
  return {
    filePath: resolve(projectRulesDirectory(baseDir), `${identity}.json`),
    projectRoot: path,
    identity,
  };
}

export async function readProjectRulesFile(location: ProjectRulesLocation): Promise<ProjectRulesFile | null> {
  let raw: string;
  try {
    raw = await readFile(location.filePath, "utf8");
  } catch (error) {
    if (isMissingPathError(error)) return null;
    throw error;
  }
  // The lock helper creates an empty placeholder before the first write.
  if (!raw.trim()) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new PermissionRulesFileCorruptError(location.filePath, invalidJsonDetail(error, raw));
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new PermissionRulesFileCorruptError(location.filePath, "not an object");
  }
  const file = parsed as Record<string, unknown>;
  if (file.version !== 1) throw new PermissionRulesFileCorruptError(location.filePath, `unsupported version ${String(file.version)}`);
  if (file.projectRoot !== location.projectRoot) {
    throw new PermissionRulesFileCorruptError(location.filePath, "projectRoot does not match the file identity");
  }
  const rules = validateRuleList(location.filePath, file.rules, { specifiersOnly: true, sourceText: raw, keepInertWildcards: "all" });
  return {
    version: 1,
    projectRoot: location.projectRoot,
    rules,
    updatedAt: typeof file.updatedAt === "string" ? file.updatedAt : "",
  };
}

export async function updateProjectRulesFile(
  location: ProjectRulesLocation,
  mutator: (file: ProjectRulesFile) => void,
  authority?: ApprovalPersistenceGuard,
): Promise<ProjectRulesFile> {
  return withShellPolicyMutation(async () => {
    await mkdir(dirname(location.filePath), { recursive: true, mode: PRIVATE_DIR_MODE });
    return withFileLock(location.filePath, async () => {
      const existing = await readProjectRulesFile(location);
      const file: ProjectRulesFile = existing ?? {
        version: 1,
        projectRoot: location.projectRoot,
        rules: [],
        updatedAt: new Date().toISOString(),
      };
      const inert = inertRulePatterns(existing?.rules);
      mutator(file);
      file.rules = validateRuleList(location.filePath, file.rules, { specifiersOnly: true, keepInertWildcards: inert });
      file.updatedAt = new Date().toISOString();
      await refreshApprovalPersistence(authority);
      if (authority) {
        if (!replaceUtf8FileAtomicSyncIf(location.filePath, `${JSON.stringify(file, null, 2)}\n`, authority.isCurrent)) throw new Error("Approval authority is unavailable");
      } else {
        writeUtf8FileAtomicSync(location.filePath, `${JSON.stringify(file, null, 2)}\n`, 0o600);
      }
      return file;
    });
  });
}

// Exact stored identity; listing and revoke must not repeat repository discovery.
function storedProjectRulesLocation(baseDir: string, projectRoot: string): ProjectRulesLocation {
  const captured = captureApprovalWorkingDirectory(projectRoot);
  return {
    filePath: resolve(baseDir, "permissions", "project-rules", captured.identity + ".json"),
    projectRoot: captured.path,
    identity: captured.identity,
  };
}

// The rules file named by a stored identity, for revoking from a row the listing produced. It never re-runs discovery, so a file whose project root no longer resolves to its name can still be edited in place.
export function storedFileRulesLocation(baseDir: string, identity: string, projectRoot: string): ProjectRulesLocation {
  if (!/^[a-f0-9]{64}$/.test(identity)) throw new Error("Invalid project rules file identity");
  return { filePath: resolve(baseDir, "permissions", "project-rules", `${identity}.json`), projectRoot, identity };
}

// A listed project rules file with the identity its name stores.
export type StoredProjectRulesFile = ProjectRulesFile & { identity: string };

// Enumerate stored projects, retaining independent corruption errors. A file whose root no longer derives its own name is reported as an error and its rules are still listed, so they stay revocable by that stored identity.
export async function listStoredProjectRules(baseDir: string): Promise<{
  files: StoredProjectRulesFile[];
  errors: ScopedPermissionRuleError[];
}> {
  const directory = projectRulesDirectory(baseDir);
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if (isMissingPathError(error)) return { files: [], errors: [] };
    throw error;
  }
  const files: StoredProjectRulesFile[] = [];
  const errors: ScopedPermissionRuleError[] = [];
  for (const name of names.sort()) {
    if (!name.endsWith(".json")) continue;
    const filePath = resolve(directory, name);
    try {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) throw new PermissionRulesFileCorruptError(filePath, "invalid file identity");
      const identity = name.slice(0, -".json".length);
      const raw = await readFile(filePath, "utf8");
      if (!raw.trim()) continue;
      let parsed: unknown;
      try { parsed = JSON.parse(raw); } catch (error) {
        throw new PermissionRulesFileCorruptError(filePath, invalidJsonDetail(error, raw));
      }
      const projectRoot = parsed && typeof parsed === "object" ? (parsed as { projectRoot?: unknown }).projectRoot : undefined;
      if (typeof projectRoot !== "string" || !isAbsolute(projectRoot)) throw new PermissionRulesFileCorruptError(filePath, "invalid project root");
      const file = await readProjectRulesFile(storedFileRulesLocation(baseDir, identity, projectRoot));
      if (!file) continue;
      files.push({ ...file, identity });
      const location = storedProjectRulesLocation(baseDir, projectRoot);
      if (location.filePath !== filePath || location.projectRoot !== projectRoot) {
        console.error("[permission]", new PermissionRulesFileCorruptError(filePath, "projectRoot does not match the file identity"));
        errors.push({ filePath, errorCode: "rules-file-unavailable" });
      }
    } catch (error) {
      console.error("[permission]", error);
      errors.push({ filePath, errorCode: "rules-file-unavailable" });
    }
  }
  return { files, errors };
}
