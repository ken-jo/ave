import { accessSync, constants, lstatSync, opendirSync, realpathSync, statSync } from "node:fs";
import { posix } from "node:path";
import { sameFileIdentity } from "../lib/file-identity.js";
import type { ContainerBackend } from "../shared/container-platform.js";
import { canonicalWhereItExists } from "./mxc-runtime-root.js";
import { mxcPolicyRows, type MxcFilesystemGrants, type MxcPolicyRows, type MxcWatchedRow } from "./mxc-windows.js";
import { userDenyCoversPierce, type PolicyModel } from "./policy-model.js";

type NestedGrantRule = "deny-wins" | "most-specific";

const NESTED_GRANT_RULE: Readonly<Partial<Record<ContainerBackend, NestedGrantRule>>> = Object.freeze({
  seatbelt: "deny-wins",
  bubblewrap: "most-specific",
});

export interface PosixPolicyLookups {
  /** Whether the path exists, without following a final link. */
  exists(path: string): boolean;
  /** Resolve the deepest existing ancestor and keep the missing suffix. */
  canonical(path: string): string;
  /** List child names without following links, up to the requested bound. */
  children(path: string, limit: number): readonly string[];
  /** Whether the host account can read the path and search it if it is a directory. */
  readable(path: string): boolean;
  /** Directory identity, without following a final link. */
  directoryIdentity(path: string): { readonly device: bigint; readonly inode: bigint } | undefined;
  readonly home: string;
  readonly foldsCase: boolean;
  /**
   * Bubblewrap only: write roots whose absent protected names are watched rather than held by a placeholder (a
   * long-lived holder's user folders, design 7). Such a name is in no list; it is returned in `watched`.
   */
  readonly watchedRoots?: readonly string[];
}

export type PosixPolicyRefusal =
  | "backend-unmeasured" | "pattern-row" | "relative-row" | "nested-grant-under-deny" | "deny-without-outcome"
  | "chain-unreadable" | "grant-limit-exceeded" | "root-write-grant" | "placeholder-parent-unproved";

interface BubblewrapPlaceholder {
  readonly path: string;
  readonly ancestor: string;
  readonly device: bigint;
  readonly inode: bigint;
  readonly parents: readonly string[];
}

export interface PosixFilesystemGrants extends MxcFilesystemGrants {
  readonly chainFolders: readonly string[];
  readonly ungrantedDenies: readonly string[];
  readonly carvedReadLimitedAt?: readonly string[];
  readonly pins?: readonly string[];
  readonly placeholders?: readonly BubblewrapPlaceholder[];
}

function isAbsent(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP";
}

export function posixPolicyLookups(home: string, foldsCase: boolean): PosixPolicyLookups {
  const exists = (path: string): boolean => {
    try {
      lstatSync(path);
      return true;
    } catch (error) {
      if (!isAbsent(error)) throw error;
      return false;
    }
  };
  return {
    home, foldsCase, exists,
    canonical(path) {
      try {
        return realpathSync.native(path);
      } catch (error) {
        // A dangling final link must not be admitted as a resolved child.
        if (!isAbsent(error) || exists(path)) throw error;
        return canonicalWhereItExists(path);
      }
    },
    children(path, limit) {
      const names: string[] = [];
      const directory = opendirSync(path, { bufferSize: 1 });
      try {
        while (names.length < limit) {
          const entry = directory.readSync();
          if (entry === null) break;
          names.push(entry.name);
        }
      } finally {
        directory.closeSync();
      }
      return names;
    },
    readable(path) {
      try {
        accessSync(path, constants.R_OK | (statSync(path).isDirectory() ? constants.X_OK : 0));
        return true;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (isAbsent(error) || code === "EACCES" || code === "EPERM") return false;
        throw error;
      }
    },
    directoryIdentity(path) {
      try {
        const stat = lstatSync(path, { bigint: true });
        return stat.isDirectory() ? { device: stat.dev, inode: stat.ino } : undefined;
      } catch (error) {
        if (isAbsent(error)) return undefined;
        throw error;
      }
    },
  };
}

export class PosixContainerPolicyError extends Error {
  constructor(readonly code: PosixPolicyRefusal, detail: string) {
    super(detail);
    this.name = "PosixContainerPolicyError";
  }
}

function pathKey(path: string, foldsCase: boolean): string {
  return foldsCase ? path.normalize("NFC").toLowerCase() : path;
}

export function atOrUnder(path: string, root: string, foldsCase: boolean): boolean {
  const key = pathKey(path, foldsCase);
  const parent = pathKey(root, foldsCase);
  return key === parent || key.startsWith(parent === "/" ? parent : `${parent}/`);
}

export function canonicalPath(path: string, literal: boolean, lookups: PosixPolicyLookups): string {
  const expanded = path === "~" ? lookups.home : path.startsWith("~/") ? lookups.home + path.slice(1) : path;
  if (!posix.isAbsolute(expanded)) throw new PosixContainerPolicyError("relative-row", `Container row is relative: ${path}`);
  if (!literal && /[*?[\]{}]/u.test(expanded)) throw new PosixContainerPolicyError("pattern-row", `Container row is a pattern: ${path}`);
  const canonical = lookups.canonical(expanded);
  if (!posix.isAbsolute(canonical)) throw new PosixContainerPolicyError("relative-row", `Canonical container row is relative: ${canonical}`);
  return posix.normalize(canonical).replace(/\/+$/u, "") || "/";
}

function nearestEnclosing(path: string, candidates: readonly string[], foldsCase: boolean): string | undefined {
  let nearest: string | undefined;
  for (const candidate of candidates) {
    if ((nearest === undefined || candidate.length > nearest.length) && atOrUnder(path, candidate, foldsCase)) {
      nearest = candidate;
    }
  }
  return nearest;
}

function assertDenyOutcomes(
  readDenies: readonly string[], writeFloor: readonly string[], result: MxcFilesystemGrants, foldsCase: boolean,
  nestedRule: NestedGrantRule = "deny-wins",
): void {
  const readGrants = [...result.readwrite, ...result.readonly];
  for (const [rows, grants, stamps] of [
    [readDenies, readGrants, result.denied],
    [writeFloor, result.readwrite, [...result.denied, ...result.readonly]],
  ]) {
    for (const row of rows) {
      const grant = nearestEnclosing(row, grants, foldsCase);
      const stamp = nearestEnclosing(row, stamps, foldsCase);
      if (grant !== undefined && (stamp === undefined
        || (nestedRule === "most-specific" && stamp.length < grant.length))) {
        throw new PosixContainerPolicyError("deny-without-outcome", `Container deny has no outcome: ${row}`);
      }
    }
  }
}

const MAX_CARVE_ENTRIES = 2_000;
const MAX_CARVE_GRANTS = 400;
const BUBBLEWRAP_PRIVATE_MOUNTS = ["/proc", "/dev", "/run"] as const;

function carveGrants(
  readwrite: readonly string[], readonly: readonly string[], readDenies: readonly string[],
  writeFloor: readonly string[], lookups: PosixPolicyLookups,
  finalize: (grants: MxcFilesystemGrants) => MxcFilesystemGrants,
): Omit<PosixFilesystemGrants, "ungrantedDenies"> {
  const key = (path: string) => pathKey(path, lookups.foldsCase);
  const covers = (root: string, path: string) => atOrUnder(path, root, lookups.foldsCase);
  const grants = [...readwrite, ...readonly];
  const chain = new Map<string, string>([["/", "/"]]);
  const carvedDenies = new Set<string>();
  for (const deny of readDenies) {
    const reopened = grants.filter(grant => key(deny) !== key(grant) && covers(deny, grant));
    if (reopened.length === 0) continue;
    carvedDenies.add(deny);
    for (const grant of reopened) {
      for (let dir = posix.dirname(grant); ; dir = posix.dirname(dir)) {
        chain.set(key(dir), dir);
        if (dir === "/") break;
      }
    }
  }

  // The root is always carved. Any other chain folder is carved only where it covers a carved deny: a grant wholly inside
  // one (a plugin's install root above its data root, both inside the Ave home) stays a grant of its own, its subpath.
  const coversCarvedDeny = (path: string) => [...carvedDenies].some(deny => covers(path, deny));
  const carvedChain = (path: string) => chain.has(key(path)) && (path === "/" || coversCarvedDeny(path));
  let rw = readwrite.filter(path => !carvedChain(path));
  let ro = readonly.filter(path => !carvedChain(path));
  const denied = readDenies.filter(deny => !carvedDenies.has(deny));
  let final = finalize({ readwrite: rw, readonly: ro, denied });
  const firstExcess = [...final.readwrite, ...final.readonly][MAX_CARVE_GRANTS];
  if (firstExcess !== undefined) {
    throw new PosixContainerPolicyError("grant-limit-exceeded", `Container grant limit (${MAX_CARVE_GRANTS}) exceeded at: ${firstExcess}`);
  }
  const grantKeys = new Set(grants.map(key));
  const emitted = new Set([...rw, ...ro].map(key));
  const limited: string[] = [];
  let remainingEntries = MAX_CARVE_ENTRIES;
  const chainFolders = [...chain.values()].sort((left, right) => left.length - right.length);
  for (const folder of chainFolders) {
    // A grant kept whole already opens its subtree.
    if (emitted.has(key(folder))) continue;
    const enclosing = nearestEnclosing(folder, grants, lookups.foldsCase);
    if (enclosing === undefined) continue;
    // A surviving grant reopens its subtree inside a carved deny. Denies inside that grant still apply.
    const activeDenies = readDenies.filter(deny => !covers(deny, enclosing));
    if (activeDenies.some(deny => covers(deny, folder))) continue;
    const candidates = new Map<string, string>();
    try {
      const children = lookups.children(folder, remainingEntries + 1);
      if (children.length > remainingEntries) {
        remainingEntries = 0;
        limited.push(folder);
        continue;
      }
      remainingEntries -= children.length;
      for (const name of children) {
        const child = posix.join(folder, name);
        if (child === "/dev" || chain.has(key(child))) continue;
        let resolved: string;
        try {
          resolved = lookups.canonical(child);
        } catch (error) {
          if (isAbsent(error)) continue;
          throw error;
        }
        const resolvedKey = key(resolved);
        if (!covers(enclosing, resolved) || !lookups.exists(resolved) || resolved === "/dev" || chain.has(resolvedKey)
          || grantKeys.has(resolvedKey) || emitted.has(resolvedKey)) continue;
        if (activeDenies.some(deny => covers(deny, resolved))) continue;
        if (resolvedKey !== key(child)
          && (chainFolders.some(path => covers(resolved, path))
            || grants.some(path => covers(resolved, path) || covers(path, resolved)))) continue;
        candidates.set(resolvedKey, resolved);
      }
    } catch {
      throw new PosixContainerPolicyError("chain-unreadable", `Container cannot read chain folder: ${folder}`);
    }

    if (candidates.size === 0) continue;
    if (emitted.size + candidates.size > MAX_CARVE_GRANTS) {
      limited.push(folder);
      continue;
    }
    const canWrite = readwrite.some(root => key(root) === key(enclosing));
    const nextRw = [...rw];
    const nextRo = [...ro];
    for (const path of candidates.values()) {
      const output = canWrite && !writeFloor.some(floor => covers(floor, path)) ? nextRw : nextRo;
      output.push(path);
    }
    const next = finalize({ readwrite: nextRw, readonly: nextRo, denied });
    if (next.readwrite.length + next.readonly.length > MAX_CARVE_GRANTS) {
      limited.push(folder);
      continue;
    }
    rw = nextRw;
    ro = nextRo;
    final = next;
    for (const id of candidates.keys()) emitted.add(id);
  }
  return {
    ...final,
    chainFolders,
    ...(limited.length > 0 ? { carvedReadLimitedAt: limited } : {}),
  };
}

function rankRows(model: PolicyModel, nestedRule: NestedGrantRule, lookups: PosixPolicyLookups): PosixFilesystemGrants {
  const canonicalRows = { ...model, rows: model.rows.map((row) => ({ ...row, path: canonicalPath(row.path, row.literal, lookups) })) };
  const rows: MxcPolicyRows = mxcPolicyRows(canonicalRows);
  if (nestedRule === "most-specific" && rows.writeGrants.includes("/")) {
    throw new PosixContainerPolicyError("root-write-grant", "Container cannot grant write access to /");
  }
  const key = (path: string) => pathKey(path, lookups.foldsCase);
  const covers = (root: string, path: string) => atOrUnder(path, root, lookups.foldsCase);
  const strictlyCovers = (root: string, path: string) => key(root) !== key(path) && covers(root, path);
  const coveredBy = (path: string, roots: readonly string[]) => roots.some((root) => covers(root, path));
  const dedupe = (paths: readonly string[]) => {
    const seen = new Set<string>();
    return paths.filter((path) => {
      const id = key(path);
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  };

  for (const pierce of rows.floorPierces) {
    const rule = rows.userDenies.find((deny) => covers(deny, pierce));
    if (rule !== undefined) throw userDenyCoversPierce(rule, pierce);
  }
  const pierces = new Set(rows.floorPierces.map(key));
  const readDenies = dedupe([
    ...rows.readDenies, ...rows.protectedFloor.filter((floor) => !pierces.has(key(floor))), ...rows.userDenies,
  ]);
  const readDenyKeys = new Set(readDenies.map(key));
  const readSurvives = (path: string) => !readDenyKeys.has(key(path))
    && !coveredBy(path, rows.userDenies)
    && (!coveredBy(path, rows.protectedFloor) || coveredBy(path, rows.floorPierces))
    && lookups.exists(path);
  const writeFloorRows = [...rows.writeFloor, ...rows.protectedFloor];
  const writeSurvives = (path: string) => !coveredBy(path, writeFloorRows);
  const writable = dedupe(rows.writeGrants).filter(readSurvives);
  const writableGrants = writable.filter(writeSurvives);
  const readonlyGrants = [
    ...dedupe(rows.readGrants).filter(readSurvives), ...writable.filter((path) => !writeSurvives(path)),
  ];
  const finalize = (carved: MxcFilesystemGrants): MxcFilesystemGrants => {
    const { readwrite, readonly: requestedReadonly } = carved;
    const requestedGrants = [...readwrite, ...requestedReadonly];
    const reachedDenies = carved.denied.filter((deny) => requestedGrants.some((grant) => strictlyCovers(grant, deny)));
    const retainedDenies: string[] = [];
    for (const deny of reachedDenies.toSorted((a, b) => a.length - b.length)) {
      const parent = nearestEnclosing(deny, retainedDenies, lookups.foldsCase);
      if (parent === undefined || (nestedRule === "most-specific" && requestedGrants.some(
        (grant) => strictlyCovers(parent, grant) && strictlyCovers(grant, deny),
      ))) {
        retainedDenies.push(deny);
      }
    }
    const retained = new Set(retainedDenies);
    const denied = reachedDenies.filter((deny) => retained.has(deny));

    if (nestedRule === "deny-wins") {
      for (const grant of requestedGrants) {
        const deny = denied.find((path) => strictlyCovers(path, grant));
        if (deny !== undefined) {
          throw new PosixContainerPolicyError("nested-grant-under-deny", `Container grant ${grant} is nested under deny ${deny}`);
        }
      }
    }

    const writeFloor = writeFloorRows.filter((path) => readwrite.some((grant) => strictlyCovers(grant, path)));
    const writableKeys = new Set(readwrite.map(key));
    const readonly = dedupe([
      ...requestedReadonly, ...writeFloor.filter((path) => {
        const deny = nearestEnclosing(path, denied, lookups.foldsCase);
        if (deny === undefined) return true;
        if (nestedRule === "deny-wins") return false;
        const write = nearestEnclosing(path, readwrite, lookups.foldsCase);
        return write !== undefined && write.length > deny.length;
      }),
    ]).filter((path) => !writableKeys.has(key(path)));

    return { readwrite, readonly, denied };
  };
  const result = nestedRule === "deny-wins"
    ? carveGrants(writableGrants, readonlyGrants, readDenies, writeFloorRows, lookups, finalize)
    : { ...finalize({ readwrite: writableGrants, readonly: readonlyGrants, denied: readDenies }), chainFolders: [] };
  assertDenyOutcomes(readDenies, writeFloorRows, result, lookups.foldsCase, nestedRule);
  const deniedKeys = new Set(result.denied.map(key));
  return { ...result, ungrantedDenies: readDenies.filter(deny => !deniedKeys.has(key(deny))) };
}

function bubblewrapReadBase(result: PosixFilesystemGrants, lookups: PosixPolicyLookups): PosixFilesystemGrants {
  if (!result.readonly.includes("/")) return result;

  const children = lookups.children("/", MAX_CARVE_ENTRIES + 1);
  if (children.length > MAX_CARVE_ENTRIES) {
    throw new PosixContainerPolicyError("grant-limit-exceeded", "Container cannot enumerate the root within its grant limit");
  }
  const readonly = result.readonly.filter((path) => path !== "/");
  const excluded = [...BUBBLEWRAP_PRIVATE_MOUNTS, ...result.denied, ...result.readwrite, ...readonly];
  const rootGrants = new Set<string>();
  for (const name of children) {
    const path = posix.join("/", name);
    if (BUBBLEWRAP_PRIVATE_MOUNTS.some((root) => atOrUnder(path, root, false)) || !lookups.readable(path)) continue;

    const canonical = canonicalPath(path, true, lookups);
    if (canonical === "/" || !lookups.exists(canonical) || excluded.some((root) => atOrUnder(canonical, root, false))) continue;
    rootGrants.add(canonical);
  }

  for (const path of rootGrants) {
    let parent = posix.dirname(path);
    while (parent !== "/" && !rootGrants.has(parent)) parent = posix.dirname(parent);
    if (parent === "/") readonly.push(path);
  }
  return { ...result, readonly };
}

function applyBubblewrapRows(result: PosixFilesystemGrants, lookups: PosixPolicyLookups): PosixFilesystemGrants {
  const { readwrite, readonly, denied } = bubblewrapReadBase(result, lookups);
  const enclosingRows = [...readwrite, ...readonly, ...denied];
  const writeRows = new Set(readwrite);
  const pins = new Set<string>();
  const placeholders: BubblewrapPlaceholder[] = [];
  const watched: MxcWatchedRow[] = [];
  const projectedReadonly: string[] = [];
  const projectedDenied: string[] = [];
  // A nested write root is a mount point, but the folders above it inside the enclosing write root are not. Renaming one
  // of them carries the nested mount, and every row below it, away, so each existing folder between the two is pinned.
  for (const path of readwrite) {
    const parent = posix.dirname(path);
    if (parent === path) continue;
    const enclosing = nearestEnclosing(parent, enclosingRows, false);
    if (enclosing === undefined || !writeRows.has(enclosing)) continue;
    for (let folder = parent; folder !== enclosing; folder = posix.dirname(folder)) {
      if (lookups.directoryIdentity(folder) !== undefined) pins.add(folder);
    }
  }
  for (const [path, isDenied] of [
    ...readonly.map((path) => [path, false] as const),
    ...denied.map((path) => [path, true] as const),
  ]) {
    const parent = posix.dirname(path);
    const enclosing = nearestEnclosing(parent, enclosingRows, false);
    const exists = lookups.exists(path);
    if (exists) (isDenied ? projectedDenied : projectedReadonly).push(path);
    if (enclosing === undefined || !writeRows.has(enclosing)) continue;
    for (let folder = parent; folder !== enclosing; folder = posix.dirname(folder)) {
      if (!exists || lookups.directoryIdentity(folder) !== undefined) pins.add(folder);
    }
    if (exists) continue;

    const parents: string[] = [];
    let ancestor = parent;
    let identity = lookups.directoryIdentity(ancestor);
    while (identity === undefined && ancestor !== enclosing && !lookups.exists(ancestor)) {
      parents.unshift(ancestor);
      ancestor = posix.dirname(ancestor);
      identity = lookups.directoryIdentity(ancestor);
    }
    if (identity === undefined) {
      throw new PosixContainerPolicyError("placeholder-parent-unproved", `Container cannot prove a parent of: ${path}`);
    }
    if (lookups.watchedRoots?.some((root) => atOrUnder(enclosing, root, lookups.foldsCase)) === true) {
      // Neither emitted nor created: the nearest existing folder's identity, checked again at the start and the release.
      watched.push({ path, anchor: ancestor, volumeSerial: String(identity.device), fileId: String(identity.inode) });
      for (const folder of parents) pins.delete(folder);
      continue;
    }
    placeholders.push({ path, ancestor, ...identity, parents });
    projectedDenied.push(path);
  }

  const writable = [...readwrite, ...pins];
  const firstExcess = [...writable, ...projectedReadonly, ...projectedDenied][MAX_CARVE_GRANTS];
  if (firstExcess !== undefined) {
    throw new PosixContainerPolicyError("grant-limit-exceeded", `Container grant limit (${MAX_CARVE_GRANTS}) exceeded at: ${firstExcess}`);
  }
  return { ...result, readwrite: writable, readonly: projectedReadonly, denied: projectedDenied, pins: [...pins], placeholders,
    ...(watched.length === 0 ? {} : { watched }) };
}

/** Rank the literal rows and retain the carve information needed to render the profile. */
export function rankPosixContainerRows(
  model: PolicyModel, backend: ContainerBackend, lookups: PosixPolicyLookups,
): PosixFilesystemGrants {
  const rule = Object.hasOwn(NESTED_GRANT_RULE, backend) ? NESTED_GRANT_RULE[backend] : undefined;
  if (rule === undefined) throw new PosixContainerPolicyError("backend-unmeasured", `Container precedence is unmeasured for ${backend}`);
  const result = rankRows(model, rule, lookups);
  return backend === "bubblewrap" ? applyBubblewrapRows(result, lookups) : result;
}

export { assertDenyOutcomes as _assertPosixDenyOutcomesForTest, rankRows as _rankPosixContainerRowsForTest };

/** Whether the volume holding `path` folds case, measured on the first ancestor name with a letter. */
export function posixPathFoldsCase(path: string): boolean {
  const device = lstatSync(path, { bigint: true }).dev;
  for (let entry = path; entry !== "/"; entry = posix.dirname(entry)) {
    const original = lstatSync(entry, { bigint: true });
    if (original.dev !== device) break;
    const name = posix.basename(entry);
    const variant = name.replace(/[a-z]/iu, letter => letter === letter.toLowerCase() ? letter.toUpperCase() : letter.toLowerCase());
    if (variant === name) continue;
    const other = lstatSync(posix.join(posix.dirname(entry), variant), { bigint: true, throwIfNoEntry: false });
    return other !== undefined && sameFileIdentity(original, other);
  }
  // Unknown volumes retain case-sensitive path keys and the extra write-floor variants.
  return false;
}

/** The Git control snapshot leaves out what a container cannot write: paths its protected rows cover. */
export function gitExclusions(grants: PosixFilesystemGrants): (path: string, includesChildren?: boolean) => boolean {
  const protectedRows = [...grants.readonly, ...grants.denied];
  const covering = (path: string, rows: readonly string[]) => Math.max(-1,
    ...rows.filter(root => atOrUnder(path, root, false)).map(root => root.length));
  return (path, includesChildren) => covering(path, grants.readwrite) <= covering(path, protectedRows)
    || (includesChildren === true && protectedRows.some(row => atOrUnder(row, path, false)));
}
