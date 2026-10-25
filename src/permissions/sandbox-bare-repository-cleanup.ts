import { lstatSync, realpathSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { createLogger } from "../lib/logger.js";
import { errorMessage } from "../shared/error-message.js";
import { createSandboxQuarantine } from "./sandbox-quarantine.js";
import { isGrantPathWithin, restrictSandboxGitControlSnapshot, SANDBOX_BARE_REPOSITORY_ENTRIES, snapshotSandboxGitControls, type SandboxGitControlSnapshot } from "./sandbox-write-policy.js";

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
  writeRoots: readonly string[], commandId: string, initial?: SandboxGitControlSnapshot,
): Promise<() => string | undefined> {
  const before = initial ? restrictSandboxGitControlSnapshot(initial, writeRoots) : snapshotSandboxGitControls(writeRoots);
  const roots = [...before.bareRoots].flatMap(root => {
    const identity = before.roots.get(root);
    if (identity?.kind !== "directory") return [];
    const names = [...SANDBOX_BARE_REPOSITORY_ENTRIES, "hooks"];
    return [{ root, identity, absent: names.filter(name => before.entries.get(join(root, name)) === undefined) }];
  });
  if (writeRoots.length === 0) return () => undefined;
  const quarantine = await createSandboxQuarantine(commandId);
  let swept = false;
  return () => {
    if (swept) return quarantine.notice();
    swept = true;
    const candidates = new Map<string, { readonly dev: number | bigint; readonly ino: number | bigint }>();
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
        if (before.isPathExcluded?.(path)) continue;
        if (entryAt(path)) candidates.set(path, identity);
      }
    }
    try {
      const after = snapshotSandboxGitControls(writeRoots, before);
      for (const [path, identity] of after.entries) {
        if (before.isPathExcluded?.(path)) continue;
        const replacedControl = after.replacedMarkers.has(path) && (after.markers.has(path) || after.stores.has(path));
        if (identity === undefined || (before.entries.get(path) !== undefined && !replacedControl)) continue;
        if ([...before.bareRoots].some(root => path === join(root, "hooks") && entryAt(join(root, "HEAD")) === undefined)) continue;
        const parent = dirname(path);
        const parentIdentity = before.stores.get(parent) ?? before.roots.get(parent) ?? before.directories.get(parent) ?? entryAt(parent);
        // A missing parent means the entry went with it (a concurrent writer in
        // a shared root removed the repository); nothing remains to quarantine.
        if (!parentIdentity) continue;
        candidates.set(path, parentIdentity);
      }
      const moved: string[] = [];
      for (const [path, identity] of [...candidates].sort(([left], [right]) => left.split(sep).length - right.split(sep).length)) {
        if (moved.some(parent => isGrantPathWithin(parent, path))) continue;
        if (before.isPathExcluded?.(path)) continue;
        if (before.isPathExcluded?.(path, true)) throw new Error("Sandbox Git quarantine would include a protected path");
        quarantine.move(path, identity);
        moved.push(path);
      }
    } catch (error) {
      const notice = quarantine.notice();
      if (!notice || errorMessage(error).includes(notice)) throw error;
      throw new Error(`${errorMessage(error)}\n${notice}`, { cause: error });
    }
    return quarantine.notice();
  };
}
