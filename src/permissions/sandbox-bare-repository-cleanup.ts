import { lstatSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "../lib/logger.js";
import { createSandboxQuarantine } from "./sandbox-quarantine.js";
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
 * Capture absent reserved names, then quarantine entries appearing during the
 * invocation. Absence is not process provenance: external concurrent writers
 * must coordinate these names. Pre-existing entries and replaced roots survive.
 */
export async function prepareSandboxBareRepositoryCleanup(
  writeRoots: readonly string[], commandId: string,
): Promise<() => string | undefined> {
  const roots = findNonRepositoryWriteRoots(writeRoots).flatMap(root => {
    const identity = entryAt(root);
    if (!identity?.isDirectory() || identity.isSymbolicLink()) return [];
    const physical = realpathSync.native(root);
    const names = [...SANDBOX_BARE_REPOSITORY_ENTRIES, "hooks"];
    return [{ root: physical, identity, absent: names.filter(name => entryAt(join(physical, name)) === undefined) }];
  });
  if (!roots.some(root => root.absent.length > 0)) return () => undefined;
  const quarantine = await createSandboxQuarantine(commandId);
  let swept = false;
  return () => {
    if (swept) return quarantine.notice();
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
        if (entryAt(path)) quarantine.move(path, identity);
      }
    }
    return quarantine.notice();
  };
}
