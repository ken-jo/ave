import { lstatSync, mkdtempSync, realpathSync, renameSync, rmdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "../lib/logger.js";
import { findNonRepositoryWriteRoots, SANDBOX_BARE_REPOSITORY_ENTRIES } from "./sandbox-write-policy.js";

const log = createLogger("sandbox-bare-repository-cleanup");

function entryAt(path: string): ReturnType<typeof lstatSync> | undefined {
  try { return lstatSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/**
 * Linux cannot deny absent bare-layout names without creating host mountpoints.
 * Capture absent reserved names, then retire entries appearing during the
 * invocation. Absence is not process provenance: external concurrent writers
 * must coordinate these names. Pre-existing entries and replaced roots survive.
 */
export function prepareSandboxBareRepositoryCleanup(writeRoots: readonly string[]): () => void {
  const roots = findNonRepositoryWriteRoots(writeRoots).flatMap(root => {
    const identity = entryAt(root);
    if (!identity?.isDirectory() || identity.isSymbolicLink()) return [];
    const physical = realpathSync.native(root);
    const names = [...SANDBOX_BARE_REPOSITORY_ENTRIES, "hooks"];
    return [{ root: physical, identity, absent: names.filter(name => entryAt(join(physical, name)) === undefined) }];
  });
  let swept = false;
  return () => {
    if (swept) return;
    swept = true;
    for (const { root, identity, absent } of roots) {
      const sameRoot = (): boolean => {
        const current = entryAt(root);
        return current?.isDirectory() === true && !current.isSymbolicLink()
          && current.dev === identity.dev && current.ino === identity.ino
          && realpathSync.native(root) === root;
      };
      const hasHead = entryAt(join(root, "HEAD")) !== undefined;
      for (const name of absent) {
        if (name === "hooks" && !hasHead) continue;
        if (!sameRoot()) {
          log.warn(`Sandbox bare-repository cleanup refused a replaced root: ${root}`);
          break;
        }
        const path = join(root, name);
        const created = entryAt(path);
        if (!created) continue;
        // Rename the entry before removal. Recursive removal never follows an
        // entry symlink, and a concurrent replacement cannot acquire its name.
        const quarantine = mkdtempSync(join(root, ".ave-bare-cleanup-"));
        const retired = join(quarantine, name);
        try {
          renameSync(path, retired);
          const moved = entryAt(retired);
          if (!sameRoot() || moved?.dev !== created.dev || moved.ino !== created.ino) {
            throw new Error("Sandbox bare-repository cleanup identity changed");
          }
          rmSync(retired, { recursive: true, force: true });
          log.warn(`Removed sandbox-created bare repository entry: ${path}`);
        } finally {
          // A failed identity check preserves the quarantined data for review.
          try { rmdirSync(quarantine); } catch { /* Nonempty quarantine stays intact. */ }
        }
      }
    }
  };
}
