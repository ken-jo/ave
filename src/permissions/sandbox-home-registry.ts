import { lstatSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative } from "node:path";
import { t } from "../i18n/index.js";
import { markSandboxHomesUnavailable } from "./sandbox-capability.js";

// The sandbox HOMEs this process created and has not yet removed (`sandbox-process-home.ts`). A grant inside the Windows runtime root is admitted only for one of these.
export const liveSandboxProcessHomes = new Set<string>();

/** No sandbox HOME can be made on this Windows host until a restart proves the container runtime root private, so no
 * process that needs one (terminal, shells, MCP servers, workers, extensions, the memory map) starts. */
export class SandboxHomeUnavailableError extends Error {
  readonly code = "sandbox-home-unavailable";
  constructor(cause: unknown) {
    super(t("sandboxPolicy.homesUnavailable"), { cause });
    this.name = "SandboxHomeUnavailableError";
  }
}

export function isSandboxHomeUnavailable(error: unknown): error is SandboxHomeUnavailableError {
  return error instanceof Error && (error as { code?: unknown }).code === "sandbox-home-unavailable";
}

type DirectoryIdentity = { readonly dev: bigint; readonly ino: bigint };
type IssuedHome = { readonly identity: DirectoryIdentity; readonly ancestors: readonly (readonly [string, DirectoryIdentity])[] };

// Each container HOME this process issued to a launch (a sandbox HOME or a holder's staging HOME): its identity when
// created, and that of every directory from its parent up to the runtime root.
const issuedContainerHomes = new Map<string, IssuedHome>();

// `followLinks: false` is the directory at the path itself: a link there is no identity.
function directoryIdentity(path: string, followLinks: boolean): DirectoryIdentity | undefined {
  try {
    const entry = followLinks ? statSync(path, { bigint: true }) : lstatSync(path, { bigint: true });
    return entry.isDirectory() && !entry.isSymbolicLink() ? { dev: entry.dev, ino: entry.ino } : undefined;
  } catch {
    return undefined;
  }
}

const sameIdentity = (left: DirectoryIdentity | undefined, right: DirectoryIdentity): boolean =>
  left !== undefined && left.dev === right.dev && left.ino === right.ino;

/** Record `home`, issued under `root` (the container runtime root), with the identity of each directory up to that root. */
export function recordIssuedContainerHome(home: string, root: string): void {
  const below = relative(root, home);
  const identity = directoryIdentity(home, false);
  if (below === "" || below.startsWith("..") || isAbsolute(below) || identity === undefined) {
    throw new Error(`Container HOME could not be recorded: ${home}`);
  }
  const ancestors: (readonly [string, DirectoryIdentity])[] = [];
  for (let path = dirname(home); ; path = dirname(path)) {
    const ancestor = directoryIdentity(path, false);
    if (ancestor === undefined) throw new Error(`Container HOME could not be recorded: ${home}`);
    ancestors.push([path, ancestor]);
    if (relative(root, path) === "") break;
  }
  issuedContainerHomes.set(home, { identity, ancestors });
}

export function forgetIssuedContainerHome(home: string): void {
  issuedContainerHomes.delete(home);
}

// The issued HOME and every directory up to the root are still the directories they were, none of them a link.
function inPlace(issued: IssuedHome, home: string): boolean {
  return sameIdentity(directoryIdentity(home, false), issued.identity)
    && issued.ancestors.every(([path, identity]) => sameIdentity(directoryIdentity(path, false), identity));
}

/** Whether `cwd` is the HOME issued as `home`, still in place as it was when issued. A path below it, another launch's
 * HOME, a HOME never issued, or one replaced or moved since (or a parent of it) is not; a link as `cwd` counts only
 * when its target is that directory. */
export function isIssuedContainerHome(cwd: string, home: string | undefined): boolean {
  if (home === undefined) return false;
  const issued = issuedContainerHomes.get(home);
  if (issued === undefined) return false;
  return inPlace(issued, home) && sameIdentity(directoryIdentity(cwd, true), issued.identity);
}

/** At a launch: an issued HOME, or a parent of it up to the runtime root, that was replaced or moved since it was
 * issued refuses the launch with the named reason. A HOME this registry never issued is not checked here. */
export function assertIssuedContainerHomeInPlace(home: string | undefined): void {
  if (home === undefined) return;
  const issued = issuedContainerHomes.get(home);
  if (issued === undefined || inPlace(issued, home)) return;
  markSandboxHomesUnavailable();
  throw new SandboxHomeUnavailableError(new Error(`Container HOME or a parent of it was replaced: ${home}`));
}
