import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { aveHome } from "../shared/ave-home.js";

/**
 * Anchor process.cwd() to ~/.ave/workspace/. Creates the directory if
 * missing (0o700). Called at main-process entry so tool execution does
 * not run from filesystem root when Ave is launched from Finder/`open`
 * — src/tools/executor.ts fails-closed on root cwd.
 */
export function ensureWorkspaceCwd(): string {
  const workspaceDir = join(aveHome(), "workspace");
  mkdirSync(workspaceDir, { recursive: true, mode: 0o700 });
  process.chdir(workspaceDir);
  return workspaceDir;
}
