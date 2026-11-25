import { lstatSync, statSync } from "node:fs";

// The sandbox HOMEs this process created and has not yet removed (`sandbox-process-home.ts`). A grant inside the Windows runtime root is admitted only for one of these.
export const liveSandboxProcessHomes = new Set<string>();

type DirectoryIdentity = { readonly dev: bigint; readonly ino: bigint };

// Each container HOME this process issued to a launch (a sandbox HOME or a holder's staging HOME), by its identity when created.
const issuedContainerHomes = new Map<string, DirectoryIdentity>();

// `followLinks: false` is the directory at the path itself: a link there is no identity.
function directoryIdentity(path: string, followLinks: boolean): DirectoryIdentity | undefined {
  try {
    const entry = followLinks ? statSync(path, { bigint: true }) : lstatSync(path, { bigint: true });
    return entry.isDirectory() && !entry.isSymbolicLink() ? { dev: entry.dev, ino: entry.ino } : undefined;
  } catch {
    return undefined;
  }
}

export function recordIssuedContainerHome(home: string): void {
  const identity = directoryIdentity(home, false);
  if (identity === undefined) throw new Error(`Container HOME could not be recorded: ${home}`);
  issuedContainerHomes.set(home, identity);
}

export function forgetIssuedContainerHome(home: string): void {
  issuedContainerHomes.delete(home);
}

/** Whether `cwd` is the HOME issued as `home`, still the directory it was when issued. A path below it, another launch's
 * HOME, a HOME never issued or one replaced or moved since is not; a link as `cwd` counts only when its target is that directory. */
export function isIssuedContainerHome(cwd: string, home: string | undefined): boolean {
  if (home === undefined) return false;
  const issued = issuedContainerHomes.get(home);
  if (issued === undefined) return false;
  const same = (identity: DirectoryIdentity | undefined): boolean =>
    identity !== undefined && identity.dev === issued.dev && identity.ino === issued.ino;
  return same(directoryIdentity(home, false)) && same(directoryIdentity(cwd, true));
}
