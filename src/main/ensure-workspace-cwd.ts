import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { aveHome } from "../shared/ave-home.js";

// Anchor cwd before tool execution; desktop launchers may otherwise start at filesystem root, which the executor rejects.
export function ensureWorkspaceCwd(): string {
  const workspaceDir = join(aveHome(), "workspace");
  mkdirSync(workspaceDir, { recursive: true, mode: 0o700 });
  process.chdir(workspaceDir);
  return workspaceDir;
}
