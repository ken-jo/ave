/** Revocation ranges are OR alternatives of AND semver comparators; * matches all versions. */
import { compareSemver, isSemver } from "../../shared/semver-compare.js";

type Operator = ">=" | ">" | "<=" | "<" | "=";

interface Comparator {
  op: Operator;
  version: string;
}

export type VersionRange = ReadonlyArray<ReadonlyArray<Comparator>>;

export function parseVersionRange(text: string): VersionRange {
  const alternatives = text.split("||").map((part) => part.trim());
  if (alternatives.some((part) => part.length === 0)) throw new Error(`empty alternative in range "${text}"`);
  return alternatives.map((alternative) => {
    if (alternative === "*") return [];
    return alternative.split(/\s+/u).map((token): Comparator => {
      const match = /^(>=|<=|>|<|=)?(.+)$/u.exec(token);
      const version = match?.[2] ?? "";
      if (!isSemver(version)) throw new Error(`"${token}" is not a comparator in range "${text}"`);
      return { op: (match?.[1] as Operator | undefined) ?? "=", version };
    });
  });
}

function holds(version: string, comparator: Comparator): boolean {
  const order = compareSemver(version, comparator.version);
  switch (comparator.op) {
    case ">=": return order >= 0;
    case ">": return order > 0;
    case "<=": return order <= 0;
    case "<": return order < 0;
    case "=": return order === 0;
  }
}

export function rangeIncludes(range: VersionRange, version: string): boolean {
  return range.some((alternative) => alternative.every((comparator) => holds(version, comparator)));
}
