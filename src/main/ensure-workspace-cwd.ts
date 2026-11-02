import { mkdirSync, mkdtempSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { createLogger } from "../lib/logger.js";
import { aveHome, createAveHomeIfAbsent } from "../shared/ave-home.js";
import { verifyPrivateTempDir } from "../shared/ave-scratch.js";

const log = createLogger("ave");

/** The workspace fallback is not a private directory of this account; a start never runs with a foreign-writable workspace root. */
export class WorkspaceFallbackUnsafeError extends Error {
  constructor(readonly directory: string, readonly reason: string) {
    super(`Ave could not create its data folder, and the temporary workspace ${directory} is not private to this account (${reason}). `
      + "Check the permissions of the temporary directory (TEMP/TMPDIR) and of AVE_HOME, then start Ave again.");
    this.name = "WorkspaceFallbackUnsafeError";
  }
}

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
    return anchorInTemporaryWorkspace(error);
  }
  const workspaceDir = join(home, "workspace");
  mkdirSync(workspaceDir, { recursive: true, mode: 0o700 });
  process.chdir(workspaceDir);
  return workspaceDir;
}

function anchorInTemporaryWorkspace(error: unknown): string {
  const fallback = mkdtempSync(join(tmpdir(), "ave-workspace-"));
  const name = basename(fallback);
  // The same check as the scratch directory: mkdtemp inherits whatever the temp directory grants, so it is verified, not assumed.
  const verified = verifyPrivateTempDir(fallback);
  // The temp path names the user's profile; logs and the refusal name only the directory's own name.
  if (!verified.ok) throw new WorkspaceFallbackUnsafeError(name, verified.reason.split(fallback).join(name));
  log.warn("main: AVE_HOME could not be created with its protected descriptor (%s); cwd anchored to a dedicated temporary directory %s",
    error instanceof Error ? error.name : typeof error, name);
  process.chdir(fallback);
  process.once("exit", () => removeIfEmpty(fallback));
  return fallback;
}

/** On exit the fallback is removed only while it is still empty; anything the user or a tool left in it stays. */
function removeIfEmpty(fallback: string): void {
  // Windows cannot remove a process's current directory.
  if (resolve(process.cwd()) === resolve(fallback)) process.chdir(tmpdir());
  try {
    rmdirSync(fallback);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOTEMPTY" || code === "EEXIST" || code === "ENOENT") return;
    log.warn("main: temporary workspace %s was not removed on exit (%s)", basename(fallback), code ?? "unknown");
  }
}
