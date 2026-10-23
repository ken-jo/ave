import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { settingsFilePath } from "../data/settings-store.js";
import { aveHome } from "../shared/ave-home.js";
import { permissionSettingsPath } from "./permission-settings-store.js";
import { egressGrantFilePath } from "./egress-grants.js";
import { userApprovalFilePath } from "./user-approval-store.js";
import { getAdminPolicyPath, userPolicyPath } from "./policy-store.js";
import { permissionsFilePath } from "./permissions-store.js";
import { projectRulesDirectory } from "./rules/project-rule-files.js";
import { canonicalizePathForMatch } from "./sensitive-paths.js";

/** Control files remain unwritable even when their containing directory is granted. */
const PROTECTED_ROOT_ENTRIES = [
  ".bashrc", ".zshrc", ".profile", ".bash_profile", ".zprofile", ".gitconfig",
  ".git/hooks", ".git/config", ".vscode",
] as const;

/**
 * Literal denies include absent paths: the runtime must prevent their creation,
 * rather than filtering the policy by what happens to exist before a command.
 * Store locations come from their writers so changing a layout also changes
 * this boundary. Existing sensitive-write protection is unioned separately.
 */
export function getMandatorySandboxWriteDenyPaths(
  writeRoots: readonly string[],
  userDataDir?: string,
): string[] {
  const paths = [
    ...[homedir(), ...writeRoots].flatMap((root) =>
      PROTECTED_ROOT_ENTRIES.map((entry) => join(root, entry))),
    permissionSettingsPath(),
    userApprovalFilePath(),
    egressGrantFilePath(),
    userPolicyPath(),
    getAdminPolicyPath(),
    permissionsFilePath(),
    dirname(projectRulesDirectory(aveHome())),
    ...(userDataDir === undefined ? [] : [settingsFilePath(userDataDir)]),
  ];
  // Preserve both the directory entry and its target when a setting is a link.
  return [...new Set(paths.flatMap((path) => [path, canonicalizePathForMatch(path)]))];
}
