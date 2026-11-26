import { posix } from "node:path";
import { isPolicyFloorRow, type PolicyFloorRow, type PolicyModel } from "./policy-model.js";

interface SuffixLookups {
  readonly home: string;
  readonly foldsCase: boolean;
  canonical(path: string): string;
}

const PATTERN_SPELLING = /[*?[\]{}]/u;
const CONTROL_CHARACTER = /[\p{Cc}\p{Cs}]/u;
const MAX_SEATBELT_REGEX_BYTES = 1_000;

class SeatbeltDenyError extends Error {
  constructor(readonly code: "pattern-row" | "pattern-undecidable" | "relative-row", detail: string) {
    super(detail);
    this.name = "SeatbeltDenyError";
  }
}

export function splitSeatbeltPolicyRows(model: PolicyModel): {
  literalModel: PolicyModel;
  patternRows: PolicyFloorRow[];
} {
  const literalRows: PolicyModel["rows"][number][] = [];
  const patternRows: PolicyFloorRow[] = [];
  for (const row of model.rows) {
    const unanchored = !posix.isAbsolute(row.path) && row.path !== "~" && !row.path.startsWith("~/");
    if (row.literal || !(unanchored || PATTERN_SPELLING.test(row.path))) {
      literalRows.push(row);
    } else if (isPolicyFloorRow(row)) {
      patternRows.push(row);
    } else {
      throw new SeatbeltDenyError("pattern-row", `Container grant is a pattern: ${row.path}`);
    }
  }
  return { literalModel: { ...model, rows: literalRows }, patternRows };
}

function escapeRegex(text: string): string {
  return text.replace(/[\\^$.+()|[\]{}*?"]/gu, "\\$&");
}

function undecidable(pattern: string): never {
  throw new SeatbeltDenyError("pattern-undecidable", `Cannot determine what container deny pattern covers: ${pattern}`);
}

function globBody(pattern: string, trustedClasses: boolean): string {
  let output = "";
  const tokens = /\*+\/?|\?|\[[^\]]*\]|\[|\]|[^*?[\]]+/gu;
  for (const [token] of pattern.matchAll(tokens)) {
    if (token.startsWith("*")) {
      const slash = token.endsWith("/");
      const count = token.length - Number(slash);
      if (!slash) output += count === 1 ? "[^/]*" : ".*";
      else if (count === 1) output += "[^/]*/";
      else if (count === 2) output += "(.*/)?";
      else output += count === 3 ? "[^/]*(.*/)?" : ".*";
    } else if (token === "?") {
      output += "[^/]";
    } else if (token.startsWith("[") || token === "]") {
      // Only host-generated ASCII case pairs have a known interpretation here.
      if (!trustedClasses || !/^\[[a-z][A-Z]\]$/u.test(token) || token[1]?.toUpperCase() !== token[2]) {
        undecidable(pattern);
      }
      output += token;
    } else {
      output += escapeRegex(token);
    }
  }
  return output;
}

function seatbeltDenyGlob(pattern: string, trustedClasses: boolean, lookups?: SuffixLookups): string {
  if (pattern === "" || CONTROL_CHARACTER.test(pattern)) undecidable(pattern);
  const glob = pattern.replace(/(?:\/\*\*)+$/u, "") || "/";
  if (glob === "/") return "^/.*$";
  // Resolve the literal directory prefix without interpreting metacharacters in its canonical spelling.
  const firstPattern = glob.search(PATTERN_SPELLING);
  const staticEnd = glob.lastIndexOf("/", firstPattern === -1 ? glob.length : firstPattern);
  const absolute = posix.isAbsolute(glob) || glob.startsWith("~/");
  if (lookups === undefined) return `^${globBody(glob, trustedClasses)}(/.*)?$`;
  if (!absolute) return `^/(.*/)?${globBody(glob.replace(/^\*\*\//u, ""), trustedClasses)}(/.*)?$`;
  const prefix = glob.slice(0, staticEnd + 1);
  const canonicalPrefix = lookups.canonical(prefix.startsWith("~/") ? lookups.home + prefix.slice(1) : prefix);
  if (CONTROL_CHARACTER.test(canonicalPrefix) || !posix.isAbsolute(canonicalPrefix)) undecidable(pattern);
  const tail = glob.slice(staticEnd + 1);
  return `^${escapeRegex(canonicalPrefix.replace(/\/+$/u, ""))}/${globBody(tail, trustedClasses)}(/.*)?$`;
}

function regexFilter(regex: string): string {
  if (Buffer.byteLength(regex) > MAX_SEATBELT_REGEX_BYTES) undecidable(regex);
  return `(regex #"${regex}")`;
}

function literalFilter(path: string): string {
  if (!posix.isAbsolute(path) || CONTROL_CHARACTER.test(path)) {
    throw new SeatbeltDenyError("relative-row", `Invalid container profile path: ${path}`);
  }
  return `(literal ${JSON.stringify(path)})`;
}

function pathSpelling(path: string, foldsCase: boolean): string {
  return foldsCase ? path.normalize("NFC").toLowerCase() : path;
}

function covers(root: string, path: string, foldsCase: boolean): boolean {
  const base = pathSpelling(root, foldsCase);
  const candidate = pathSpelling(path, foldsCase);
  return candidate === base || candidate.startsWith(base === "/" ? "/" : `${base}/`);
}

export function buildSeatbeltDenySuffix(input: {
  literals: readonly PolicyFloorRow[];
  patterns: readonly PolicyFloorRow[];
  writeRoots: readonly string[];
  lookups: SuffixLookups;
}): string {
  const { literals, patterns, writeRoots, lookups } = input;
  const pins = new Set<string>();
  const variantDenies: string[] = [];
  for (const row of literals) {
    const containing = writeRoots.filter(root => covers(root, row.path, lookups.foldsCase));
    if (containing.length === 0) continue;
    for (let ancestor = posix.dirname(row.path); ancestor !== "/" && ancestor !== "."; ancestor = posix.dirname(ancestor)) {
      pins.add(ancestor);
    }
    if (!lookups.foldsCase && row.access === "ro") {
      const root = containing.reduce((left, right) => left.length >= right.length ? left : right);
      const tail = row.path.slice(root.length).replace(/[a-z]|[^a-z]+/giu, part => /^[a-z]$/iu.test(part)
        ? `[${part.toLowerCase()}${part.toUpperCase()}]` : escapeRegex(part));
      variantDenies.push(`(deny file-write* ${regexFilter(`^${escapeRegex(root)}${tail}(/.*)?$`)})`);
    }
  }
  const forms = [
    ...(pins.size === 0 ? [] : [`(deny file-write-unlink file-write-create ${[...pins].map(literalFilter).join(" ")})`]),
    "(deny network-outbound (remote unix-socket))",
    "(deny network-bind (local unix-socket))",
    ...variantDenies,
    ...patterns.map((row) => {
      const regex = seatbeltDenyGlob(row.path, row.reason === "protected-name", lookups);
      const operation = row.access === "ro" ? "file-write*" : "file-read* file-read-metadata";
      return `(deny ${operation} ${regexFilter(regex)})`;
    }),
  ];
  return `${[...new Set(forms)].join("\n")}\n`;
}

export { seatbeltDenyGlob as _seatbeltDenyGlobForTest };
