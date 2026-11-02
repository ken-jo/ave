import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { aveHome, establishAveHomePrivacyAtBoot } from "../shared/ave-home.js";

// Anchor cwd before tool execution; desktop launchers may otherwise start at filesystem root, which the executor rejects.
// It is the first AVE_HOME write of both the desktop and the headless entry, so the home is protected (on Windows: created) first.
export function ensureWorkspaceCwd(): string {
  establishAveHomePrivacyAtBoot();
  const workspaceDir = join(aveHome(), "workspace");
  mkdirSync(workspaceDir, { recursive: true, mode: 0o700 });
  process.chdir(workspaceDir);
  return workspaceDir;
}
