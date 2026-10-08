/**
 * Version ranges for `policy/revocations.json` (design §10.4).
 *
 *   range      := alternative ("||" alternative)*
 *   alternative:= "*" | comparator (" " comparator)*
 *   comparator := (">=" | ">" | "<=" | "<" | "=")? semver
 *
 * Comparators in one alternative must all hold; any alternative may match.
 * Precedence is the host's `compareSemver`, so a pre-release sorts below its
 * release exactly as it does everywhere else.
 */
import { compareSemver, isSemver } from "../../shared/semver-compare.js";

type Operator = ">=" | ">" | "<=" | "<" | "=";

interface Comparator {
  op: Operator;
  version: string;
}

export type VersionRange = ReadonlyArray<ReadonlyArray<Comparator>>;

/** Parse a range, or throw with the reason. `*` is an alternative with no comparators. */
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
