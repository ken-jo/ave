import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createLogger } from "../lib/logger.js";
import { aveHome, createAveHomeIfAbsent } from "../shared/ave-home.js";

const log = createLogger("ave");

// Anchor cwd before tool execution; desktop launchers may otherwise start at filesystem root, which the executor rejects.
// It is the first AVE_HOME write of both the desktop and the headless entry, and it runs before the host-instance lock: on Windows a
// missing home is created by the protection helper first (create-only), and nothing here repairs or claims anything.
export function ensureWorkspaceCwd(): string {
  const home = aveHome();
  try {
    createAveHomeIfAbsent(home);
  } catch (error) {
    // The helper could not create the home. A plain mkdir would give it an inherited DACL that is refused for good, so this start
    // writes nothing under AVE_HOME. The cwd becomes the default workspace root (allowed directory, in-project write scope, terminal
    // jail base), so it is a fresh, empty directory of its own, never the shared temp root. bootstrap() reports the home failure as usual.
    const fallback = mkdtempSync(join(tmpdir(), "ave-workspace-"));
    // The temp path names the user's profile; the warning names only the directory's own name and the error class.
    log.warn("main: AVE_HOME could not be created with its protected descriptor (%s); cwd anchored to a dedicated temporary directory %s",
      error instanceof Error ? error.name : typeof error, basename(fallback));
    process.chdir(fallback);
    return fallback;
  }
  const workspaceDir = join(home, "workspace");
  mkdirSync(workspaceDir, { recursive: true, mode: 0o700 });
  process.chdir(workspaceDir);
  return workspaceDir;
}
