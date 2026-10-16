/**
 * Per-project permission rule files (issue #28, P1a):
 * `<ave home>/permissions/project-rules/<identity>.json`, where identity is the
 * Store B working-directory identity of the project root — the git root of
 * the session cwd, or the cwd outside a repository (sha256 of the case-folded
 * canonical realpath). Rules are never written into the user's
 * repository. Project files hold rules-language specifiers only.
 */
import { readFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { withFileLock } from "../../lib/with-file-lock.js";
import { writeUtf8FileAtomicSync, isMissingPathError, PRIVATE_DIR_MODE } from "../../lib/atomic-file.js";
import { captureApprovalWorkingDirectory } from "../user-approval-store.js";
import type { PermissionRule } from "../permission-manager.js";
import { PermissionRulesFileCorruptError, invalidJsonDetail, validateRuleList } from "./rule-files.js";
import { withShellPolicyMutation } from "../shell-policy-handoff.js";


export interface ProjectRulesFile {
  version: 1;
  /** Canonical project root; must agree with the file name's identity. */
  projectRoot: string;
  rules: PermissionRule[];
  updatedAt: string;
}

export interface ProjectRulesLocation {
  filePath: string;
  projectRoot: string;
  identity: string;
}

/**
 * The project a session cwd belongs to: the nearest ancestor (inclusive) that
 * holds a `.git` entry, so sessions started in a subdirectory share the
 * repository's rules; the cwd itself when it is not inside a repository.
 */
function projectRootFor(projectCwd: string): string {
  const start = captureApprovalWorkingDirectory(projectCwd).path;
  for (let dir = start, guard = 0; guard < 256; guard += 1) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return start;
}

export function projectRulesLocation(baseDir: string, projectCwd: string): ProjectRulesLocation {
  const { path, identity } = captureApprovalWorkingDirectory(projectRootFor(projectCwd));
  return {
    filePath: resolve(baseDir, "permissions", "project-rules", `${identity}.json`),
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
  const rules = validateRuleList(location.filePath, file.rules, { specifiersOnly: true, sourceText: raw });
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
      mutator(file);
      file.rules = validateRuleList(location.filePath, file.rules, { specifiersOnly: true });
      file.updatedAt = new Date().toISOString();
      writeUtf8FileAtomicSync(location.filePath, `${JSON.stringify(file, null, 2)}\n`, 0o600);
      return file;
    });
  });
}
