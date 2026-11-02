import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "../lib/logger.js";
import { aveHome, createAveHomeIfAbsent } from "../shared/ave-home.js";
import { errorMessage } from "../shared/error-message.js";

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
    // anchors in the OS temp directory instead and writes nothing under AVE_HOME; bootstrap() reports the home failure as usual.
    const fallback = tmpdir();
    log.error("main: AVE_HOME could not be created with its protected descriptor (%s); cwd anchored to the OS temp directory", errorMessage(error));
    process.chdir(fallback);
    return fallback;
  }
  const workspaceDir = join(home, "workspace");
  mkdirSync(workspaceDir, { recursive: true, mode: 0o700 });
  process.chdir(workspaceDir);
  return workspaceDir;
}
