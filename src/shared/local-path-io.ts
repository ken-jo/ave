import { accessSync, type BigIntStats, constants, type Dir, existsSync, lstatSync, opendirSync, openSync, readdirSync, readlinkSync, realpathSync, type Stats, statSync } from "node:fs";
import { resolve, sep, win32 } from "node:path";
import { type DriveIdentity, queryDriveIdentity } from "./windows-drive-locality.js";
import { classifyWindowsSpelling, normalizeWindowsPathSpelling, windowsVolumeRoot } from "./windows-path-spelling.js";

/*
 * The one place the path boundary looks anything up. A lookup takes a verdict, and a verdict comes only from
 * `classifyWindowsSpelling` and, for a drive, a mapping read in the current decision:
 *   - an entry verdict (`admitLocalPath`) admits a lookup that does not follow the last name (lstat, readlink);
 *   - a route verdict (`admitLocalRoute`) walks the path from its volume root, re-admitting every link target and every
 *     parent a lookup answers with, and admits any lookup of the path or an ancestor (`admitRouteAncestor`).
 * A share, device, ambiguous or unproven spelling is refused (`ENETWORKSHAREPATH`) before anything is opened, and so is a
 * walk that cannot finish. A verdict serves only the decision that issued it.
 */

class Decision {
  readonly drives = new Map<string, DriveIdentity>();
  readonly memos = new Map<object, Map<string, unknown>>();
  // A decision opened by a single lookup outside any running decision; it serves only the synchronous run that opened it.
  open = true;
  constructor(readonly detached = false) {}
}

let active: Decision | undefined;

/** One permission, sandbox or listing decision; drive mappings are read again for the next one. */
export type LocalityDecision = object;

export function openLocalityDecision(): LocalityDecision {
  return new Decision();
}

/**
 * Runs `fn` in `decision`, else in the decision already running, else in a new one. Two top-level calls never share a
 * decision, so no drive answer serves a judgment that did not read it.
 */
export function withLocalityDecision<T>(fn: () => T, decision?: LocalityDecision): T {
  const chosen = decision ?? active ?? new Decision();
  if (!(chosen instanceof Decision)) throw new TypeError("Unknown locality decision");
  if (chosen === active) return fn();
  const previous = active;
  active = chosen;
  try {
    const result = fn();
    if (typeof (result as { then?: unknown } | null)?.then === "function") throw new Error("A locality decision cannot span an await");
    return result;
  } finally {
    active = previous;
  }
}

/**
 * A decision for each synchronous run of a caller that is entered repeatedly, such as the rows of one listing: rows in
 * one run share drive answers, and the first row after an await proves them again. Inside a running decision, that one.
 */
export function createRunLocality(): () => LocalityDecision {
  let current: Decision | undefined;
  return () => {
    if (active !== undefined) return active;
    if (current?.open !== true) {
      const decision = new Decision();
      current = decision;
      queueMicrotask(() => { decision.open = false; });
    }
    return current;
  };
}

function currentDecision(): Decision {
  if (active !== undefined) return active;
  const decision = new Decision(true);
  queueMicrotask(() => { decision.open = false; });
  return decision;
}

/** A memo owned by `owner` that lives as long as the current decision; outside a running decision every call gets a fresh one. */
export function decisionMemo<V>(owner: object): Map<string, V> {
  const decision = currentDecision();
  let memo = decision.memos.get(owner);
  if (memo === undefined) {
    memo = new Map();
    decision.memos.set(owner, memo);
  }
  return memo as Map<string, V>;
}

/** Leave to look up `path` within one decision; only this module issues one. */
export class LocalPathVerdict {
  private constructor(readonly path: string, readonly route: boolean, readonly decision: Decision) {}
  static issue(path: string, route: boolean, decision: Decision): LocalPathVerdict {
    const verdict = new LocalPathVerdict(path, route, decision);
    issued.add(verdict);
    return verdict;
  }
}
const issued = new WeakSet<LocalPathVerdict>();

export interface LocalRoute {
  verdict: LocalPathVerdict;
  /** The physical path the walk reached; undefined when it found a missing name. */
  physical: string | undefined;
  /** Whether the walk followed a symbolic link or junction to reach the physical path. */
  followedLink: boolean;
}

function use(verdict: LocalPathVerdict, route: boolean): string {
  const own = active === undefined ? verdict.decision.detached && verdict.decision.open : verdict.decision === active;
  if (!issued.has(verdict) || !own) throw new Error("Filesystem lookup without a verdict of this decision");
  if (route && !verdict.route) throw new Error("Filesystem lookup follows a name its verdict did not walk");
  return verdict.path;
}

function refused(path: string, reached?: string): Error {
  return Object.assign(new Error(`Shell path requires network or device authority: ${path}`), {
    code: "ENETWORKSHAREPATH", path, ...(reached === undefined ? {} : { reached }),
  });
}

/** A lookup that cannot finish proves nothing: its path takes the opaque spelling, as an unproven drive does. */
export function unprovenLookup(at: string, rest: readonly string[], error: unknown): Error {
  const marker = `\\\\?\\GLOBALROOT\\??\\${at.replace(/^\\\\\?\\/u, "")}`;
  return Object.assign(refused(marker, [marker.replace(/[\\/]+$/u, ""), ...rest].join("\\")), { cause: error, incomplete: true });
}

/** Refuses a spelling that names no local drive path; returns its drive when it names one. */
function refuseSpelling(path: string): string | undefined {
  const spelling = classifyWindowsSpelling(path, "win32");
  if (spelling.kind === "local-drive") return spelling.drive;
  // A host-path simulation of Windows keeps its own roots; on Windows an unanchored path would borrow the current one.
  if (spelling.kind === "unanchored" && sep !== "\\") return undefined;
  throw refused(path);
}

function driveIdentity(drive: string, decision: Decision): DriveIdentity {
  let identity = decision.drives.get(drive);
  if (identity === undefined) {
    identity = queryDriveIdentity(drive);
    decision.drives.set(drive, identity);
  }
  return identity;
}

/**
 * Refuses `path` unless it names a local drive path. The refusal reaches the spelling and then `rest`; a mapped drive's
 * spelling is what it maps to.
 */
function proveSpelling(path: string, decision: Decision, rest: readonly string[] = []): void {
  let drive: string | undefined;
  try { drive = refuseSpelling(path); }
  catch (error) { throw Object.assign(error as Error, { reached: [path.replace(/[\\/]+$/u, ""), ...rest].join("\\") }); }
  if (drive === undefined || sep !== "\\") return;
  const identity = driveIdentity(drive, decision);
  if (identity.local) return;
  const components = path.replace(/^[\\/]{2}\?[\\/]/u, "").slice(3).split(/[\\/]+/u).filter(Boolean);
  throw refused(identity.root, [identity.root.replace(/[\\/]+$/u, ""), ...components, ...rest].join("\\"));
}

/** Whether drive `drive` (`X:`) exists in this decision: a local volume, or a mapping nothing has proved local. */
export function localDriveExists(drive: string): boolean {
  const identity = driveIdentity(drive.toUpperCase(), currentDecision());
  return identity.local || !identity.absent;
}

/** An entry verdict: `path` may be inspected without following its last name. Its parents are the caller's to prove. */
export function admitLocalPath(path: string): LocalPathVerdict {
  const decision = currentDecision();
  if (process.platform === "win32") proveSpelling(path, decision);
  return LocalPathVerdict.issue(path, false, decision);
}

/** A share spelling or a direct drive mapping, established without opening any path. */
export function windowsSharePath(path: string): string | undefined {
  const spelling = classifyWindowsSpelling(path, "win32");
  if (spelling.kind === "share") {
    const share = win32.normalize(spelling.extended ? `\\\\${path.slice(8)}` : path);
    return !spelling.loopback && /^\\\\[^\\]+\\[^\\]+/u.test(share) ? share : undefined;
  }
  if (spelling.kind !== "local-drive" || spelling.drive === undefined) return undefined;
  const identity = driveIdentity(spelling.drive, currentDecision());
  if (identity.local || classifyWindowsSpelling(identity.root, "win32").kind !== "share") return undefined;
  return win32.join(identity.root, win32.normalize(spelling.driveAlias ?? path).slice(3));
}

function shareContains(root: string, path: string): boolean {
  const relative = win32.relative(root, path);
  return relative === "" || (relative !== ".." && !relative.startsWith("..\\") && !win32.isAbsolute(relative));
}

/** Walk only toward the authorized share root or within it, rechecking every link before following its target. */
export function admitShareHop(path: string, root: string): string | undefined {
  if (windowsSharePath(path) !== path || windowsSharePath(root) !== root || !shareContains(root, path)) return undefined;
  const decision = currentDecision();
  const base = win32.parse(root).root;
  const walk = (target: string, depth: number): string | undefined => {
    if (depth > MAX_FILESYSTEM_SYMLINK_HOPS || !shareContains(root, target)) return undefined;
    const pieces = target.slice(base.length).split("\\").filter(Boolean);
    let parent = base;
    for (const [index, piece] of pieces.entries()) {
      const candidate = win32.join(parent, piece);
      const verdict = LocalPathVerdict.issue(candidate, false, decision);
      const found = localFs.lstat(verdict);
      if (found === undefined) return win32.join(candidate, ...pieces.slice(index + 1));
      if (found.isSymbolicLink()) {
        const link = localFs.readlink(verdict);
        const classified = classifyWindowsSpelling(link, "win32");
        const relative = classified.kind === "unanchored" && !/^(?:[\\/]|[A-Za-z]:)/u.test(link);
        const next = windowsSharePath(relative ? win32.resolve(parent, link) : link);
        if (next === undefined || !shareContains(root, next)) return undefined;
        return walk(win32.join(next, ...pieces.slice(index + 1)), depth + 1);
      }
      if (!found.isDirectory() && index + 1 < pieces.length) return undefined;
      parent = candidate;
    }
    return parent;
  };
  return walk(path, 0);
}

export interface LocalFilesystemFacts {
  knownPath: (path: string) => { canonical: string; missing: boolean } | undefined;
  onLocalPath: (path: string, canonical: string, missing: boolean, followedLink: boolean) => void;
}

export const MAX_FILESYSTEM_SYMLINK_HOPS = 64;

/**
 * A route verdict for `path` after a walk from its volume root. `projectMissing` continues a missing name lexically and
 * reports the projected physical path.
 */
export function admitLocalRoute(path: string, options: {
  platform?: NodeJS.Platform; maxSymlinkHops?: number; facts?: LocalFilesystemFacts; projectMissing?: boolean; rejectDanglingLink?: boolean;
} = {}): LocalRoute {
  const decision = currentDecision();
  const route = (options.platform ?? process.platform) === "win32"
    ? walkWindowsRoute(path, decision, options.maxSymlinkHops ?? MAX_FILESYSTEM_SYMLINK_HOPS, options.facts, options.projectMissing === true, options.rejectDanglingLink === true)
    : { physical: path, followedLink: false };
  return { verdict: LocalPathVerdict.issue(path, true, decision), ...route };
}

/**
 * A route verdict for an ancestor of a walked path. An ancestor the walk passed through, as Windows normalizes it, is
 * admitted as walked; any other spelling, such as a lexical parent above a `..`, is walked first.
 */
export function admitRouteAncestor(route: LocalRoute, ancestor: string): LocalPathVerdict {
  use(route.verdict, true);
  const decision = route.verdict.decision as Decision;
  if (process.platform === "win32") {
    const fold = (value: string) => resolve(value).toLowerCase().replace(/[\\/]+$/u, "");
    const walked = fold(route.verdict.path);
    const prefix = fold(ancestor);
    if (walked !== prefix && !walked.startsWith(`${prefix}${sep}`)) walkWindowsRoute(ancestor, decision, MAX_FILESYSTEM_SYMLINK_HOPS, undefined, false);
  }
  return LocalPathVerdict.issue(ancestor, true, decision);
}

function walkWindowsRoute(
  path: string, decision: Decision, maxSymlinkHops: number, facts: LocalFilesystemFacts | undefined, projectMissing: boolean,
  rejectDanglingLink = false,
): Pick<LocalRoute, "physical" | "followedLink"> {
  let hops = 0;
  let projectedMissing = false;
  const entry = (candidate: string) => LocalPathVerdict.issue(candidate, false, decision);
  const routed = (candidate: string) => LocalPathVerdict.issue(candidate, true, decision);
  const reachedPastLink = (error: unknown, rest: readonly string[]): unknown => {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENETWORKSHAREPATH" || !("path" in error)) return error;
    const reached = String("reached" in error ? error.reached : error.path);
    return Object.assign(error, { reached: rest.length === 0 ? reached : [reached.replace(/[\\/]+$/u, ""), ...rest].join("\\") });
  };
  const unproven = unprovenLookup;
  const walk = (absolute: string): string | undefined => {
    refuseSpelling(absolute);
    // Normalize the accepted device spelling before deriving or slicing its root.
    const normalized = (sep === "\\" ? normalizeWindowsPathSpelling(absolute) : win32.normalize(absolute))
      .replace(/^\\\\\?\\(?=[A-Za-z]:[\\/])/, "");
    const root = sep === "\\" ? windowsVolumeRoot(normalized) : win32.parse(normalized).root;
    const components = normalized.slice(root.length).split(/[\\/]+/u).filter(Boolean);
    // A drive letter can name a share. Its mapping, read without opening the drive, decides before any lookup.
    proveSpelling(root, decision, components);
    const complete = facts?.knownPath(normalized);
    if (complete !== undefined) {
      if (complete.missing) return undefined;
      // A recorded identity is a spelling like any other: its drive is proven in this decision before it serves.
      proveSpelling(complete.canonical, decision);
      return complete.canonical;
    }
    let lexicalParent = root;
    let remaining = 0;
    let known = facts?.knownPath(root);
    while (known !== undefined && !known.missing && remaining < components.length) {
      const prefix = win32.join(lexicalParent, components[remaining] as string);
      const next = facts?.knownPath(prefix);
      if (next === undefined) break;
      lexicalParent = prefix;
      known = next;
      remaining++;
    }
    if (known?.missing) return undefined;
    let physicalParent: string;
    if (known !== undefined) physicalParent = known.canonical;
    else {
      try { physicalParent = localFs.realpathNative(routed(root)); }
      catch (error) {
        if (missingEntry(error) && !projectMissing) return undefined;
        throw unproven(root, components, error);
      }
    }
    const pending = components.slice(remaining);
    // A lookup that answers with another spelling re-enters the boundary: a share, a device or another drive.
    proveSpelling(physicalParent, decision, pending);
    facts?.onLocalPath(lexicalParent, physicalParent, false, hops !== 0);
    for (const [index, component] of pending.entries()) {
      if (component === ".") continue;
      if (component === "..") { physicalParent = win32.dirname(physicalParent); continue; }
      const candidate = win32.join(physicalParent, component);
      const rest = pending.slice(index + 1);
      lexicalParent = win32.join(lexicalParent, component);
      let found: Stats | undefined;
      try { found = localFs.lstat(entry(candidate)); }
      catch (error) {
        if (!missingEntry(error)) throw unproven(candidate, rest, error);
      }
      if (found === undefined) {
        facts?.onLocalPath(lexicalParent, candidate, true, hops !== 0);
        projectedMissing = true;
        return projectMissing ? win32.join(candidate, ...rest) : undefined;
      }
      if (found.isSymbolicLink()) {
        let target: string;
        try { target = localFs.readlink(entry(candidate)); }
        catch (error) { throw unproven(candidate, rest, error); }
        let resolvedTarget: string | undefined;
        try {
          // Only a plain drive or relative target is followed; any share or device target stops the walk at its spelling.
          if (/^[\\/]{2}|^[\\/]\?\?[\\/]/u.test(target)) throw refused(target);
          const effectiveTarget = win32.resolve(physicalParent, target);
          if (++hops > maxSymlinkHops) throw unproven(candidate, [], new Error("Filesystem path exceeds the component limit"));
          // A local spelling can itself contain links. Inspect that entire chain before a lookup may follow this entry.
          resolvedTarget = walk(effectiveTarget);
        } catch (error) {
          throw reachedPastLink(error, rest);
        }
        if (resolvedTarget === undefined || (rejectDanglingLink && projectedMissing)) return undefined;
        if (projectMissing) physicalParent = resolvedTarget;
        else {
          try { physicalParent = localFs.realpathNative(routed(candidate)); }
          catch (error) { throw unproven(candidate, rest, error); }
        }
      } else if (projectMissing || facts) {
        // The physical parent and this non-link entry establish the next parent. Facts consumers match on the
        // canonical spelling, so expand 8.3 aliases and casing; other callers keep the input spelling.
        // A step that cannot be canonicalized proves no identity; it is never recorded as one.
        try { physicalParent = localFs.realpathNative(routed(candidate)); }
        catch (error) { throw unproven(candidate, rest, error); }
      } else physicalParent = candidate;
      proveSpelling(physicalParent, decision, rest);
      facts?.onLocalPath(lexicalParent, physicalParent, false, hops !== 0);
    }
    return physicalParent;
  };
  const physical = walk(path);
  return { physical, followedLink: hops !== 0 };
}

function missingEntry(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/** Lookups, each of the path its verdict names. */
export const localFs = {
  access(verdict: LocalPathVerdict, mode: number): void {
    accessSync(use(verdict, true), mode);
  },
  requireSearchAccess(verdict: LocalPathVerdict): void {
    localFs.access(verdict, constants.X_OK);
  },
  lstat(verdict: LocalPathVerdict): Stats | undefined {
    return lstatSync(use(verdict, false), { throwIfNoEntry: false });
  },
  lstatBigint(verdict: LocalPathVerdict): BigIntStats | undefined {
    return lstatSync(use(verdict, false), { bigint: true, throwIfNoEntry: false });
  },
  readlink(verdict: LocalPathVerdict): string {
    return readlinkSync(use(verdict, false));
  },
  realpath(verdict: LocalPathVerdict): string {
    return realpathSync(use(verdict, true));
  },
  realpathNative(verdict: LocalPathVerdict): string {
    return realpathSync.native(use(verdict, true));
  },
  stat(verdict: LocalPathVerdict): Stats {
    return statSync(use(verdict, true));
  },
  statBigint(verdict: LocalPathVerdict): BigIntStats {
    return statSync(use(verdict, true), { bigint: true });
  },
  exists(verdict: LocalPathVerdict): boolean {
    return existsSync(use(verdict, true));
  },
  readdir(verdict: LocalPathVerdict): string[] {
    return readdirSync(use(verdict, true));
  },
  opendir(verdict: LocalPathVerdict): Dir {
    return opendirSync(use(verdict, true));
  },
  open(verdict: LocalPathVerdict, flags: number): number {
    return openSync(use(verdict, true), flags);
  },
};

/**
 * How the walk of `path` from its volume root ends: `local`, `refused` at a share, device, ambiguous or non-local drive
 * spelling, or `incomplete` at an entry it could not read, which proves neither.
 */
export function routeLocality(path: string): "local" | "refused" | "incomplete" {
  try {
    withLocalityDecision(() => admitLocalRoute(path));
    return "local";
  } catch (error) {
    const { code, incomplete } = error as { code?: unknown; incomplete?: unknown };
    return code === "ENETWORKSHAREPATH" && incomplete !== true ? "refused" : "incomplete";
  }
}
