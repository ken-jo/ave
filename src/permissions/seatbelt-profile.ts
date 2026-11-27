import { posix } from "node:path";
import { GIT_METADATA_RULES, MAX_SEATBELT_STRING_BYTES, macWriteRootLinkedNameRules, macWriteRootNameRules } from "./macos-sandbox-wrap.js";
import { atOrUnder, canonicalPath, type PosixFilesystemGrants, type PosixPolicyLookups } from "./mxc-posix.js";
import { isPolicyFloorRow, isPolicyGrantRow, type PolicyFloorRow, type PolicyModel } from "./policy-model.js";

interface SuffixLookups {
  readonly home: string;
  readonly foldsCase: boolean;
  canonical(path: string): string;
}

const PATTERN_SPELLING = /[*?[\]{}]/u;
const CONTROL_CHARACTER = /[\p{Cc}\p{Cs}]/u;

class SeatbeltDenyError extends Error {
  constructor(readonly code: "unknown-row" | "pattern-row" | "pattern-undecidable" | "relative-row"
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
    // The kind is checked before anything reads the row: past this boundary a row that is not a floor is a grant.
    if (!isPolicyFloorRow(row) && !isPolicyGrantRow(row)) {
      throw new SeatbeltDenyError("unknown-row", `Container row has an unknown reason: ${String((row as { reason: unknown }).reason)}`);
    }
    checkProfileString(row.path);
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
const WRITE_DENY = `${FILE_WRITE_DENY} network-bind network-outbound`;
const READ_DENY = `file-read* file-read-metadata ${WRITE_DENY}`;
const MOVE_DENY = "file-write-unlink file-write-create";
// The SDK's run-cleanup names, and Ave's holder labels: only their own builders write rules for them.
const RESERVED_PROFILE_TEXT = ["com.microsoft.mxc.run.", "dev.ave.holder."] as const;
const HOLDER_LABEL_PREFIX = "dev.ave.holder.";
const HOLDER_LABEL = /^dev\.ave\.holder\.[a-z0-9.]{1,96}$/u;
/** A holder profile, label included, larger than this is refused before anything is spawned. */
export const SEATBELT_HOLDER_PROFILE_MAX_BYTES = 512 * 1024;

function checkProfileString(value: string): void {
  if (CONTROL_CHARACTER.test(value)) {
    throw new SeatbeltDenyError("profile-control-character", "Container profile string contains a control character");
  }
  if (Buffer.byteLength(value) > MAX_SEATBELT_STRING_BYTES) {
    throw new SeatbeltDenyError("profile-string-too-long", `Container profile string exceeds the limit: ${value}`);
  }
  if (RESERVED_PROFILE_TEXT.some(reserved => value.includes(reserved))) {
    throw new SeatbeltDenyError("profile-reserved-name", `Container profile string uses a reserved name: ${value}`);
  }
}

function pathFilter(operation: "literal" | "subpath", path: string): string {
  checkProfileString(path);
  if (!posix.isAbsolute(path)) throw new SeatbeltDenyError("relative-row", `Invalid container profile path: ${path}`);
  return `(${operation} ${JSON.stringify(path)})`;
}

function addDeny(forms: string[], operations: string, filters: readonly string[]): void {
  if (filters.length > 0) forms.push(`(deny ${operations} ${filters.join(" ")})`);
}

function patternBase(path: string, lookups: SuffixLookups): string | undefined {
  if (!posix.isAbsolute(path) && !path.startsWith("~/")) return undefined;
  const firstPattern = path.search(PATTERN_SPELLING);
  const prefix = path.slice(0, path.lastIndexOf("/", firstPattern === -1 ? path.length : firstPattern) + 1);
  return lookups.canonical(prefix.startsWith("~/") ? lookups.home + prefix.slice(1) : prefix);
}

function caseVariantFilter(path: string, root: string): string {
  const tail = path.slice(root.length).replace(/[a-z]|[^a-z]+/giu, part => /^[a-z]$/iu.test(part)
    ? `[${part.toLowerCase()}${part.toUpperCase()}]` : escapeRegex(part));
  return regexFilter(`^${escapeRegex(root)}${tail}(/.*)?$`);
}

/** The profile's one IP egress rule: outbound to the invocation proxy's loopback port, nothing else. */
function seatbeltProxyEgressAllow(proxyPort: number): string {
  return `(allow network-outbound (remote ip "localhost:${proxyPort}"))`;
}

type SeatbeltForm = string | readonly SeatbeltForm[];

/** The profile's top-level forms, with string and regex literals kept whole; undefined if it does not parse. */
function parseSeatbeltForms(profile: string): readonly SeatbeltForm[] | undefined {
  const stack: SeatbeltForm[][] = [[]];
  for (let index = 0; index < profile.length;) {
    const character = profile[index] as string;
    if (/\s/u.test(character)) {
      index += 1;
    } else if (character === ";") {
      const end = profile.indexOf("\n", index);
      index = end === -1 ? profile.length : end + 1;
    } else if (character === "(") {
      stack.push([]);
      index += 1;
    } else if (character === ")") {
      const form = stack.pop();
      const parent = stack.at(-1);
      if (form === undefined || parent === undefined) return undefined;
      parent.push(form);
      index += 1;
    } else if (character === "\"" || profile.startsWith("#\"", index)) {
      let end = index + (character === "#" ? 2 : 1);
      while (end < profile.length && profile[end] !== "\"") end += profile[end] === "\\" ? 2 : 1;
      if (end >= profile.length) return undefined;
      (stack.at(-1) as SeatbeltForm[]).push(profile.slice(index, end + 1));
      index = end + 1;
    } else {
      const atom = /^[^\s()";]+/u.exec(profile.slice(index))?.[0];
      if (atom === undefined) return undefined;
      (stack.at(-1) as SeatbeltForm[]).push(atom);
      index += atom.length;
    }
  }
  return stack.length === 1 ? stack[0] : undefined;
}

const sameForm = (left: SeatbeltForm, right: SeatbeltForm): boolean => typeof left === "string" || typeof right === "string"
  ? left === right : left.length === right.length && left.every((item, index) => sameForm(item, right[index] as SeatbeltForm));

/**
 * Structural IPv6 evidence: the profile, as staged, denies by default and its only IP egress allow is exactly the rule
 * the builder emits for the proxy port. Judged on the parsed rules, not on lines: an allow that names any network
 * operation (or `default`) passes only with Unix-socket filters or that one proxy filter, and an allow with no filter
 * at all opens every address. The rule is compared with what `buildSeatbeltShellProfile` itself writes.
 */
/** True when a rule could hide below the top level: an `allow` or `import` inside another form. */
function hidesNestedRule(form: SeatbeltForm, depth: number): boolean {
  if (typeof form === "string") return false;
  if (depth > 0 && (form[0] === "allow" || form[0] === "import")) return true;
  return form.some(item => hidesNestedRule(item, depth + 1));
}

/** A Unix-socket filter exactly as the builder writes it: `(local|remote unix-socket (subpath|literal|regex <literal>))`. */
function isUnixSocketFilter(filter: SeatbeltForm): boolean {
  if (typeof filter === "string" || filter.length !== 3) return false;
  const [side, kind, path] = filter;
  return (side === "local" || side === "remote") && kind === "unix-socket" && typeof path !== "string" && path !== undefined
    && path.length === 2 && (path[0] === "subpath" || path[0] === "literal" || path[0] === "regex")
    && typeof path[1] === "string" && (path[1].startsWith("\"") || path[1].startsWith("#\""));
}

export function seatbeltProfileAllowsOnlyProxyIpEgress(profile: string, proxyPort: number): boolean {
  const forms = parseSeatbeltForms(profile);
  const proxyAllow = parseSeatbeltForms(seatbeltProxyEgressAllow(proxyPort))?.[0];
  if (forms === undefined || proxyAllow === undefined || typeof proxyAllow === "string") return false;
  // The check reads top-level rules only, so anything that could carry a rule elsewhere fails it.
  if (forms.some(form => typeof form === "string" || form[0] === "import" || hidesNestedRule(form, 0))) return false;
  if (!forms.some(form => sameForm(form, ["deny", "default"]))) return false;
  let proxyAllows = 0;
  for (const form of forms) {
    if (typeof form === "string" || form[0] !== "allow") continue;
    const operations = form.slice(1).filter((item): item is string => typeof item === "string");
    if (!operations.some(operation => operation === "default" || operation.startsWith("network"))) continue;
    if (sameForm(form, proxyAllow)) {
      proxyAllows += 1;
      continue;
    }
    const filters = form.slice(1).filter(item => typeof item !== "string");
    const unixSocketOnly = filters.length > 0 && filters.every(isUnixSocketFilter);
    if (!unixSocketOnly) return false;
  }
  return proxyAllows === 1;
}

interface SeatbeltProfileInput {
  readonly model: PolicyModel;
  readonly grants: PosixFilesystemGrants;
  readonly lookups: PosixPolicyLookups;
  readonly unixSocketRoots: readonly string[];
}

export function buildSeatbeltShellProfile(input: SeatbeltProfileInput & { readonly proxyPort: number }): string {
  return buildSeatbeltProfile(input, input.proxyPort);
}

/** One holder start's label names (`holder-label-sweep.ts`): its own, its app run's, and its instance's. */
export interface SeatbeltHolderLabels {
  readonly holder: string;
  readonly boot: string;
  readonly instance: string;
}

/**
 * A holder's profile: the shell's profile for the same rows, then the label lines, always last. The label is how the
 * stop finds every process the holder started (`native/macos-holder-sweep/README.md`); no row may render a rule for it.
 * An offline holder (`proxyPort: null`) has no network allow at all.
 */
export function buildSeatbeltHolderProfile(input: SeatbeltProfileInput & {
  readonly proxyPort: number | null;
  readonly labels: SeatbeltHolderLabels;
}): string {
  const { labels } = input;
  const names = [labels.holder, labels.boot, labels.instance];
  if (!names.every(name => HOLDER_LABEL.test(name)) || new Set(names).size !== names.length) {
    throw new SeatbeltDenyError("profile-reserved-name", "Container holder labels are malformed");
  }
  const profile = buildSeatbeltProfile(input, input.proxyPort);
  const withLabels = `${profile}(deny mach-lookup (global-name-prefix ${JSON.stringify(HOLDER_LABEL_PREFIX)}))
(allow mach-lookup ${names.map(name => `(global-name ${JSON.stringify(name)})`).join(" ")})
`;
  if (Buffer.byteLength(withLabels) > SEATBELT_HOLDER_PROFILE_MAX_BYTES) {
    throw new SeatbeltDenyError("profile-string-too-long", "Container holder profile exceeds the size limit");
  }
  return withLabels;
}

function buildSeatbeltProfile(input: SeatbeltProfileInput, proxyPort: number | null): string {
  const { model, grants, lookups, unixSocketRoots } = input;
  if (proxyPort !== null && (!Number.isInteger(proxyPort) || proxyPort < 1 || proxyPort > 65535)) {
    throw new SeatbeltDenyError("proxy-invalid", "Container profile requires a valid loopback proxy port");
  }
  const { literalModel, patternRows } = splitSeatbeltPolicyRows(model);
  const { readwrite, readonly, denied, chainFolders, ungrantedDenies } = grants;
  const subpath = (path: string) => pathFilter("subpath", path);
  const literal = (path: string) => pathFilter("literal", path);
  const atOrBelow = (path: string, root: string) => atOrUnder(path, root, lookups.foldsCase);

  const rows = [...readwrite, ...readonly].toSorted((a, b) => a.split("/").length - b.split("/").length);
  const writable = new Set(readwrite);
  const forms = [SHELL_BASELINE, ...rows.map(path =>
    `(allow file-read*${writable.has(path) ? " file-write*" : ""} ${subpath(path)})`)];
  for (const root of unixSocketRoots) {
    forms.push(`(allow network-bind (local unix-socket ${subpath(root)}))`);
    forms.push(`(allow network-outbound (remote unix-socket ${subpath(root)}))`);
  }
  if (proxyPort !== null) forms.push(seatbeltProxyEgressAllow(proxyPort));

  const strips = readonly.flatMap(path => {
    const root = readwrite.filter(parent => atOrBelow(path, parent)).sort((a, b) => b.length - a.length)[0];
    return root === undefined ? [] : [{ path, root }];
  });
  addDeny(forms, WRITE_DENY, strips.map(({ path }) => subpath(path)));
  if (!lookups.foldsCase) {
    for (const { path, root } of strips) {
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
      exceptions.map(exception => `(require-not ${exception})`).join(" ") + ")"]);
  }
  addDeny(forms, READ_DENY, plainDenies);

  forms.push(macWriteRootNameRules(readwrite), macWriteRootLinkedNameRules(readwrite), GIT_METADATA_RULES);
  const pins = new Set<string>();
  for (const path of [...strips.map(strip => strip.path), ...denied, ...literalModel.rows.filter(row => row.access === "ro" && isPolicyFloorRow(row))
    .map(row => canonicalPath(row.path, row.literal, lookups))]) {
    for (let parent = posix.dirname(path); parent !== "/"; parent = posix.dirname(parent)) pins.add(parent);
  }
  for (const row of patternRows) {
    addDeny(forms, row.access === "ro" ? FILE_WRITE_DENY : READ_DENY,
      [regexFilter(seatbeltDenyGlob(row.path, row.reason === "protected-name", lookups))]);
    const base = patternBase(row.path, lookups);
    if (base !== undefined) {
      if (!posix.isAbsolute(base)) throw new SeatbeltDenyError("relative-row", `Invalid container pattern base: ${base}`);
      for (let parent = posix.normalize(base).replace(/\/+$/u, "") || "/"; parent !== "/"; parent = posix.dirname(parent)) pins.add(parent);
    }
  }
  addDeny(forms, MOVE_DENY, [...pins].map(literal));
  const profile = `${forms.filter(Boolean).join("\n")}\n`;
  if (RESERVED_PROFILE_TEXT.some(reserved => profile.includes(reserved))) {
    throw new SeatbeltDenyError("profile-reserved-name", "Container profile uses a reserved name");
  }
  return profile;
}

export { seatbeltDenyGlob as _seatbeltDenyGlobForTest };
