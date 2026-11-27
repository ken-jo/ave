import { posix } from "node:path";
import { GIT_METADATA_RULES, MAX_SEATBELT_STRING_BYTES, macWriteRootLinkedNameRules, macWriteRootNameRules } from "./macos-sandbox-wrap.js";
import { atOrUnder, canonicalPath, type PosixFilesystemGrants, type PosixPolicyLookups } from "./mxc-posix.js";
import { isPolicyFloorRow, type PolicyFloorRow, type PolicyModel } from "./policy-model.js";

interface SuffixLookups {
  readonly home: string;
  readonly foldsCase: boolean;
  canonical(path: string): string;
}

const PATTERN_SPELLING = /[*?[\]{}]/u;
const CONTROL_CHARACTER = /[\p{Cc}\p{Cs}]/u;

class SeatbeltDenyError extends Error {
  constructor(readonly code: "pattern-row" | "pattern-undecidable" | "relative-row"
    | "profile-control-character" | "profile-string-too-long" | "profile-reserved-name" | "proxy-invalid", detail: string) {
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
  if (Buffer.byteLength(regex) > MAX_SEATBELT_STRING_BYTES) undecidable(regex);
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

const SHELL_BASELINE = `(version 1)
(deny default)
(allow process-fork)
(allow process-exec)
(allow signal (target same-sandbox))
(allow sysctl-read)
(allow mach-lookup
    (global-name "com.apple.system.notification_center")
    (global-name "com.apple.system.logger")
    (global-name "com.apple.distributed_notifications@Uv3")
    (global-name "com.apple.CoreServices.coreservicesd")
    (global-name "com.apple.FSEvents"))
(allow file-read-metadata)
(allow file-read-data (literal "/"))
(allow file-read*
    (subpath "/bin") (subpath "/sbin") (subpath "/usr/bin") (subpath "/usr/sbin")
    (subpath "/usr/lib") (subpath "/usr/libexec") (subpath "/usr/share") (subpath "/System")
    (subpath "/Library") (subpath "/private/var/db/timezone") (subpath "/private/var/db/dyld")
    (subpath "/private/var/select") (subpath "/private/etc"))
(allow file-read* file-write* (literal "/dev/null") (literal "/dev/zero") (literal "/dev/random") (literal "/dev/urandom"))
(allow file-read* (subpath "/dev/fd"))`;

const FILE_WRITE_DENY = "file-write* file-write-create file-write-unlink";
const WRITE_DENY = FILE_WRITE_DENY + " network-bind network-outbound";
const READ_DENY = "file-read* file-read-metadata " + WRITE_DENY;
const MOVE_DENY = "file-write-unlink file-write-create";
const RESERVED_PROFILE_TEXT = "com.microsoft.mxc.run.";

function checkProfileString(value: string): void {
  if (CONTROL_CHARACTER.test(value)) {
    throw new SeatbeltDenyError("profile-control-character", "Container profile string contains a control character");
  }
  if (Buffer.byteLength(value) > MAX_SEATBELT_STRING_BYTES) {
    throw new SeatbeltDenyError("profile-string-too-long", "Container profile string exceeds the limit: " + value);
  }
  if (value.includes(RESERVED_PROFILE_TEXT)) {
    throw new SeatbeltDenyError("profile-reserved-name", "Container profile string uses a reserved name: " + value);
  }
}

function pathFilter(operation: "literal" | "subpath", path: string): string {
  checkProfileString(path);
  if (!posix.isAbsolute(path)) throw new SeatbeltDenyError("relative-row", "Invalid container profile path: " + path);
  return "(" + operation + " " + JSON.stringify(path) + ")";
}

function addDeny(forms: string[], operations: string, filters: readonly string[]): void {
  if (filters.length > 0) forms.push("(deny " + operations + " " + filters.join(" ") + ")");
}

function patternBase(path: string, lookups: SuffixLookups): string | undefined {
  if (!posix.isAbsolute(path) && !path.startsWith("~/")) return undefined;
  const firstPattern = path.search(PATTERN_SPELLING);
  const prefix = path.slice(0, path.lastIndexOf("/", firstPattern === -1 ? path.length : firstPattern) + 1);
  return lookups.canonical(prefix.startsWith("~/") ? lookups.home + prefix.slice(1) : prefix);
}

function caseVariantFilter(path: string, root: string): string {
  const tail = path.slice(root.length).replace(/[a-z]|[^a-z]+/giu, part => /^[a-z]$/iu.test(part)
    ? "[" + part.toLowerCase() + part.toUpperCase() + "]" : escapeRegex(part));
  return regexFilter("^" + escapeRegex(root) + tail + "(/.*)?$");
}

export function buildSeatbeltShellProfile(input: {
  readonly model: PolicyModel;
  readonly grants: PosixFilesystemGrants;
  readonly lookups: PosixPolicyLookups;
  readonly unixSocketRoots: readonly string[];
  readonly proxyPort: number;
}): string {
  const { model, grants, lookups, unixSocketRoots, proxyPort } = input;
  if (!Number.isInteger(proxyPort) || proxyPort < 1 || proxyPort > 65535) {
    throw new SeatbeltDenyError("proxy-invalid", "Container profile requires a valid loopback proxy port");
  }
  for (const row of model.rows) checkProfileString(row.path);
  const { literalModel, patternRows } = splitSeatbeltPolicyRows(model);
  const { readwrite, readonly, denied, chainFolders, ungrantedDenies } = grants;
  const subpath = (path: string) => pathFilter("subpath", path);
  const literal = (path: string) => pathFilter("literal", path);
  const atOrBelow = (path: string, root: string) => atOrUnder(path, root, lookups.foldsCase);

  const rows = [...readwrite, ...readonly].toSorted((a, b) => a.split("/").length - b.split("/").length);
  const writable = new Set(readwrite);
  const forms = [SHELL_BASELINE, ...rows.map(path =>
    "(allow file-read*" + (writable.has(path) ? " file-write*" : "") + " " + subpath(path) + ")")];
  for (const root of unixSocketRoots) {
    forms.push("(allow network-bind (local unix-socket " + subpath(root) + "))");
    forms.push("(allow network-outbound (remote unix-socket " + subpath(root) + "))");
  }
  forms.push('(allow network-outbound (remote ip "localhost:' + proxyPort + '"))');

  const strips = readonly.filter(path => readwrite.some(root => atOrBelow(path, root)));
  addDeny(forms, WRITE_DENY, strips.map(subpath));
  if (!lookups.foldsCase) {
    for (const path of strips) {
      const root = readwrite.filter(root => atOrBelow(path, root)).sort((a, b) => b.length - a.length)[0]!;
      addDeny(forms, WRITE_DENY, [caseVariantFilter(path, root)]);
    }
  }
  addDeny(forms, READ_DENY, denied.map(subpath));
  const plainDenies: string[] = [];
  for (const path of ungrantedDenies) {
    const filter = subpath(path);
    const exceptions = [
      ...rows.filter(root => root !== path && atOrBelow(root, path)).map(subpath),
      ...chainFolders.filter(folder => atOrBelow(folder, path)).map(literal),
    ];
    if (exceptions.length === 0) plainDenies.push(filter);
    else addDeny(forms, READ_DENY, ["(require-all " + filter + " " +
      exceptions.map(exception => "(require-not " + exception + ")").join(" ") + ")"]);
  }
  addDeny(forms, READ_DENY, plainDenies);

  forms.push(macWriteRootNameRules(readwrite), macWriteRootLinkedNameRules(readwrite), GIT_METADATA_RULES);
  const pins = new Set<string>();
  for (const path of [...strips, ...denied, ...literalModel.rows.filter(row => row.access === "ro" && isPolicyFloorRow(row))
    .map(row => canonicalPath(row.path, row.literal, lookups))]) {
    for (let parent = posix.dirname(path); parent !== "/"; parent = posix.dirname(parent)) pins.add(parent);
  }
  for (const row of patternRows) {
    addDeny(forms, row.access === "ro" ? FILE_WRITE_DENY : READ_DENY,
      [regexFilter(seatbeltDenyGlob(row.path, row.reason === "protected-name", lookups))]);
    const base = patternBase(row.path, lookups);
    if (base !== undefined) {
      if (!posix.isAbsolute(base)) throw new SeatbeltDenyError("relative-row", "Invalid container pattern base: " + base);
      for (let parent = posix.normalize(base).replace(/\/+$/u, "") || "/"; parent !== "/"; parent = posix.dirname(parent)) pins.add(parent);
    }
  }
  addDeny(forms, MOVE_DENY, [...pins].map(literal));
  const profile = forms.filter(Boolean).join("\n") + "\n";
  if (profile.includes(RESERVED_PROFILE_TEXT)) {
    throw new SeatbeltDenyError("profile-reserved-name", "Container profile uses a reserved name");
  }
  return profile;
}

export { seatbeltDenyGlob as _seatbeltDenyGlobForTest };
