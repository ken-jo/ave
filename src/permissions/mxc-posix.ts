import { posix } from "node:path";
import type { ContainerBackend } from "../shared/container-platform.js";
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
  readonly home: string;
  readonly foldsCase: boolean;
}

export type PosixPolicyRefusal =
  | "backend-unmeasured" | "pattern-row" | "relative-row" | "nested-grant-under-deny" | "deny-without-outcome";

export class PosixContainerPolicyError extends Error {
  constructor(readonly code: PosixPolicyRefusal, detail: string) {
    super(detail);
    this.name = "PosixContainerPolicyError";
  }
}

function pathKey(path: string, foldsCase: boolean): string {
  return foldsCase ? path.toLowerCase() : path;
}

function atOrUnder(path: string, root: string, foldsCase: boolean): boolean {
  const key = pathKey(path, foldsCase);
  const parent = pathKey(root, foldsCase);
  return key === parent || key.startsWith(parent === "/" ? parent : `${parent}/`);
}

function canonicalPath(path: string, lookups: PosixPolicyLookups): string {
  const expanded = path === "~" ? lookups.home : path.startsWith("~/") ? lookups.home + path.slice(1) : path;
  if (!posix.isAbsolute(expanded)) throw new PosixContainerPolicyError("relative-row", `Container row is relative: ${path}`);
  if (/[*?[\]{}]/u.test(expanded)) throw new PosixContainerPolicyError("pattern-row", `Container row is a pattern: ${path}`);
  const canonical = lookups.canonical(expanded);
  if (!posix.isAbsolute(canonical)) throw new PosixContainerPolicyError("relative-row", `Canonical container row is relative: ${canonical}`);
  return posix.normalize(canonical).replace(/\/+$/u, "") || "/";
}

function assertDenyOutcomes(
  readDenies: readonly string[], writeFloor: readonly string[], result: MxcFilesystemGrants, foldsCase: boolean,
): void {
  const readGrants = [...result.readwrite, ...result.readonly];
  for (const [rows, grants, stamps] of [
    [readDenies, readGrants, result.denied],
    [writeFloor, result.readwrite, [...result.denied, ...result.readonly]],
  ]) {
    for (const row of rows) {
      if (grants.some((grant) => atOrUnder(row, grant, foldsCase))
          && !stamps.some((stamp) => atOrUnder(row, stamp, foldsCase))) {
        throw new PosixContainerPolicyError("deny-without-outcome", `Container deny has no outcome: ${row}`);
      }
    }
  }
}

function rankRows(model: PolicyModel, nestedRule: NestedGrantRule, lookups: PosixPolicyLookups): MxcFilesystemGrants {
  const canonicalRows = { ...model, rows: model.rows.map((row) => ({ ...row, path: canonicalPath(row.path, lookups) })) };
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
  const readwrite = writable.filter(writeSurvives);
  const requestedReadonly = [
    ...dedupe(rows.readGrants).filter(readSurvives), ...writable.filter((path) => !writeSurvives(path)),
  ];
  const requestedGrants = [...readwrite, ...requestedReadonly];
  const reachedDenies = readDenies.filter((deny) => requestedGrants.some((grant) => strictlyCovers(grant, deny)));
  const denied = reachedDenies.filter((deny) => !reachedDenies.some((parent) => strictlyCovers(parent, deny)));

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

  const result = { readwrite, readonly, denied };
  assertDenyOutcomes(readDenies, writeFloorRows, result, lookups.foldsCase);
  return result;
}

/** Policy rows in, the three container lists out. No launch calls it yet. */
export function rankPosixContainerRows(
  model: PolicyModel, backend: ContainerBackend, lookups: PosixPolicyLookups,
): MxcFilesystemGrants {
  const rule = Object.hasOwn(NESTED_GRANT_RULE, backend) ? NESTED_GRANT_RULE[backend] : undefined;
  if (rule === undefined) throw new PosixContainerPolicyError("backend-unmeasured", `Container precedence is unmeasured for ${backend}`);
  return rankRows(model, rule, lookups);
}

export { assertDenyOutcomes as _assertPosixDenyOutcomesForTest, rankRows as _rankPosixContainerRowsForTest };
