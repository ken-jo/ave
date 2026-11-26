import { lstatSync, opendirSync, realpathSync } from "node:fs";
import { posix } from "node:path";
import type { ContainerBackend } from "../shared/container-platform.js";
import { canonicalWhereItExists } from "./mxc-runtime-root.js";
import { mxcPolicyRows, type MxcFilesystemGrants, type MxcPolicyRows } from "./mxc-windows.js";
import { userDenyCoversPierce, type PolicyModel } from "./policy-model.js";

type NestedGrantRule = "deny-wins" | "most-specific";

const NESTED_GRANT_RULE: Readonly<Partial<Record<ContainerBackend, NestedGrantRule>>> = Object.freeze({
  seatbelt: "deny-wins",
});

export interface PosixPolicyLookups {
  /** Whether the path exists, without following a final link. */
  exists(path: string): boolean;
  /** Resolve the deepest existing ancestor and keep the missing suffix. */
  canonical(path: string): string;
  /** List child names without following links, up to the requested bound. */
  children(path: string, limit: number): readonly string[];
  readonly home: string;
  readonly foldsCase: boolean;
}

export type PosixPolicyRefusal =
  | "backend-unmeasured" | "pattern-row" | "relative-row" | "nested-grant-under-deny" | "deny-without-outcome"
  | "chain-unreadable";

interface PosixFilesystemGrants extends MxcFilesystemGrants {
  readonly carvedReadLimitedAt?: readonly string[];
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

function atOrUnder(path: string, root: string, foldsCase: boolean): boolean {
  const key = pathKey(path, foldsCase);
  const parent = pathKey(root, foldsCase);
  return key === parent || key.startsWith(parent === "/" ? parent : `${parent}/`);
}

function canonicalPath(path: string, literal: boolean, lookups: PosixPolicyLookups): string {
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

function carveGrants(
  readwrite: readonly string[], readonly: readonly string[], readDenies: readonly string[],
  writeFloor: readonly string[], lookups: PosixPolicyLookups,
): PosixFilesystemGrants {
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

  const rw = readwrite.filter(path => !chain.has(key(path)));
  const ro = readonly.filter(path => !chain.has(key(path)));
  const grantKeys = new Set(grants.map(key));
  const emitted = new Set([...rw, ...ro].map(key));
  // Write-floor stamps also occupy read-only rows in the request.
  const reserved = new Set(writeFloor.filter(path => readwrite.some(root => covers(root, path))).map(key));
  const limited: string[] = [];
  let remainingEntries = MAX_CARVE_ENTRIES;
  const chainFolders = [...chain.values()].sort((left, right) => left.length - right.length);
  for (const folder of chainFolders) {
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
        if (activeDenies.some(deny => covers(resolved, deny) || covers(deny, resolved))) continue;
        if (resolvedKey !== key(child)
          && (chainFolders.some(path => covers(resolved, path))
            || grants.some(path => covers(resolved, path) || covers(path, resolved)))) continue;
        candidates.set(resolvedKey, resolved);
      }
    } catch {
      throw new PosixContainerPolicyError("chain-unreadable", `Container cannot read chain folder: ${folder}`);
    }

    if (new Set([...emitted, ...reserved, ...candidates.keys()]).size > MAX_CARVE_GRANTS) {
      limited.push(folder);
      continue;
    }
    const canWrite = readwrite.some(root => key(root) === key(enclosing));
    for (const [id, path] of candidates) {
      const output = canWrite && !writeFloor.some(floor => covers(floor, path)) ? rw : ro;
      output.push(path);
      emitted.add(id);
    }
  }
  return {
    readwrite: rw, readonly: ro, denied: readDenies.filter(deny => !carvedDenies.has(deny)),
    ...(limited.length > 0 ? { carvedReadLimitedAt: limited } : {}),
  };
}

function rankRows(model: PolicyModel, nestedRule: NestedGrantRule, lookups: PosixPolicyLookups): PosixFilesystemGrants {
  const canonicalRows = { ...model, rows: model.rows.map((row) => ({ ...row, path: canonicalPath(row.path, row.literal, lookups) })) };
  const rows: MxcPolicyRows = mxcPolicyRows(canonicalRows);
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
  const carved = nestedRule === "deny-wins" ? carveGrants(
    writableGrants, readonlyGrants, readDenies, writeFloorRows, lookups,
  ) : { readwrite: writableGrants, readonly: readonlyGrants, denied: readDenies };
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
    ...requestedReadonly, ...writeFloor.filter((path) => !coveredBy(path, denied)),
  ]).filter((path) => !writableKeys.has(key(path)));

  const result = { ...carved, readonly, denied };
  assertDenyOutcomes(readDenies, writeFloorRows, result, lookups.foldsCase, nestedRule);
  return result;
}

/** Policy rows in, the three container lists out. No launch calls it yet. */
export function rankPosixContainerRows(
  model: PolicyModel, backend: ContainerBackend, lookups: PosixPolicyLookups,
): PosixFilesystemGrants {
  const rule = Object.hasOwn(NESTED_GRANT_RULE, backend) ? NESTED_GRANT_RULE[backend] : undefined;
  if (rule === undefined) throw new PosixContainerPolicyError("backend-unmeasured", `Container precedence is unmeasured for ${backend}`);
  return rankRows(model, rule, lookups);
}

export { assertDenyOutcomes as _assertPosixDenyOutcomesForTest, rankRows as _rankPosixContainerRowsForTest };
