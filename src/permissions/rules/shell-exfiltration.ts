import { bindShellSyntaxSnapshot, shellSyntaxObservation } from "../../shared/shell-syntax-cache.js";
import { shellExecutableBodySlots } from "../../tools/shell-path-policy.js";
import { effectiveShellWords } from "../../shared/shell-effective-command.js";
import { literalShellBodies, shellLiteralFragments, literalShellFlow, recordLiteralShellFlow, type LiteralBodyBudget } from "../../shared/shell-literal-bodies.js";
import { homedir } from "node:os";
import { posix, sep } from "node:path";
import { modelShellPath } from "../../shared/shell-native-path.js";
import { physicalParentReading } from "../../shared/shell-filesystem-path.js";
import { aveHome } from "../../shared/ave-home.js";
import { expandShellTildePaths } from "../../shared/home-tilde.js";
import { staticShellWord, type ShellCommand, type ShellRedirect, type ShellStatement, type ShellWord } from "../../shared/shell-analysis.js";
import { MAX_SHELL_ANALYSIS_TOKENS } from "../../shared/shell-analysis-limits.js";
import { caseFoldForMatch, foldCanonicalPathSeparators, SENSITIVE_PATH_ENTRIES, SENSITIVE_PATH_PATTERNS } from "../sensitive-paths.js";
import { literalRuleWord } from "./rule-specifier.js";
import { verifiedArgvProof } from "./verified-argv-authority.js";
import { proveStaticArgv } from "./shell-argument-grammar.js";
import { encodedPowerShellExecutionReason } from "./powershell-encoded-command.js";
import { SHELL_FLOOR_BUDGET_REASON, ShellFloorContext, ShellFloorLimitError, isShellFloorLiteralData, shellFloorBudgetSignals, shellFloorFallbackInputExceeded, shellFloorInputExceeded, shellFloorParserBudgetExceeded, type ShellFloorSignals } from "./shell-floor-policy.js";
import { shellFact, wrapperCommand, type ParsedShellCommand, type ShellCommandInput } from "./shell-prefix-policy.js";
import { RUNNER_COMMAND_PREFIXES, literalCommandAfterPrefix, programName as policyProgramName, runnerHasPrefix, runnerName } from "./shell-prefix-values.js";

export const SHELL_EXFIL_VERDICT_REASON = "shell possible credential exfiltration";
const PATH_READERS = new Set(["cat", "tac", "base64", "base32", "tar", "gzip", "bzip2", "xz", "zstd", "zip", "xxd", "od", "hexdump", "openssl", "gpg", "head", "tail", "dd", "less", "more", "strings", "cut", "sed", "awk", "jq"]);
const NETWORK_PROGRAMS = new Set(["curl", "wget", "ssh", "scp", "sftp", "rsync", "nc", "ncat", "netcat", "socat", "telnet", "ftp", "lftp", "tftp", "nslookup", "dig", "host", "http", "https", "aws", "gcloud", "az", "gh", "glab"]);
const CURL_DATA = /^(?:-d|--data(?:-ascii|-binary|-raw|-urlencode)?|--json)(?:=|$)/;
const CURL_FORM = /^(?:-F|--form)(?:=|$)/;
const CURL_UPLOAD = /^(?:-T|--upload-file|-K|--config)(?:=|$)/;
const WGET_UPLOAD = /^(?:--post-file|--body-file)(?:=|$)/;
const CURL_FILE_OPTIONS = Object.freeze(["--data", "--data-ascii", "--data-binary", "--data-raw", "--data-urlencode", "--json", "--form", "--header", "--proxy-header", "--upload-file", "--config"]);
const NON_FILE_URL = /^(?!file:)[a-z][a-z0-9+.-]*:\/\//i;
const UNPARSED_UPLOAD = /\b(?:curl|wget)\b[^\n;&|]*\s(?:-[A-Za-z]*[dF]|--data(?:-binary|-raw|-urlencode|-ascii)?|--json|--form|-T|-K|--upload-file|--config|--post-file|--body-file)(?:=|\s+)?["']?[^\s"']*@?/;
export const SHELL_RUNTIME_EVALUATION_REASON = "Shell command requires runtime evaluation";

function fileTransferOption(token: string): string {
  const flag = token.split("=", 1)[0]!;
  if (!flag.startsWith("--") || flag.length < 8) return token;
  const matches = CURL_FILE_OPTIONS.filter((name) => name.startsWith(flag));
  return matches.length === 1 ? matches[0]! + token.slice(flag.length) : token;
}

function wgetFileSetting(token: string): boolean {
  return /^(?:post|body)_?file[\t ]*=/i.test(token);
}

function programName(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return (value.split(/[\\/]/).pop() ?? value).replace(/\.exe$/i, "").toLowerCase().replace(/^(python[23]?)\.\d+$/, "$1");
}
const literalWords = new WeakMap<ShellWord, string | undefined>();
export function literalShellWord(word: ShellWord): string | undefined {
  if (!literalWords.has(word)) literalWords.set(word, literalRuleWord(word.source.raw, "bash"));
  return literalWords.get(word);
}
// Dynamic programming keeps wildcard work proportional to token length times
// the fixed sensitive-name catalogue; it never enumerates input expansions.
function segmentCouldMatch(pattern: string, value: string, anchored = false): boolean {
  if (/[*?[\]]/.test(pattern)) {
    if (value.startsWith(".") && !pattern.startsWith(".")) return false;
    const evidence = pattern.replace(/\\(.)/g, "$1").split(/[*?[\]]/, 1)[0]!.replace(/[^A-Za-z0-9._-]/g, "");
    // A proven application anchor supplies evidence for its child wildcards.
    if (evidence.length < 2 && !anchored) return false;
  }
  let states = new Uint8Array(value.length + 1); states[0] = 1;
  for (let offset = 0; offset < pattern.length; offset += 1) {
    const char = pattern[offset]!;
    if (char === "\\" && offset + 1 < pattern.length) {
      const literal = pattern[++offset]!, next = new Uint8Array(value.length + 1);
      for (let index = 0; index < value.length; index += 1) if (states[index] && value[index] === literal) next[index + 1] = 1;
      states = next;
    } else if (char === "*") {
      for (let index = 1; index <= value.length; index += 1) if (states[index - 1]) states[index] = 1;
    } else if (char === "?") {
      const next = new Uint8Array(value.length + 1);
      for (let index = 0; index < value.length; index += 1) if (states[index]) next[index + 1] = 1;
      states = next;
    } else if (char === "[") {
      const close = pattern.indexOf("]", offset + 2); if (close < 0) return true;
      let matches: RegExp; try { matches = new RegExp(`^[${pattern.slice(offset + 1, close).replace(/^!/, "^").replace(/[\\\]]/g, "\\$&")}]$`); } catch { return true; }
      const next = new Uint8Array(value.length + 1);
      for (let index = 0; index < value.length; index += 1) if (states[index] && matches.test(value[index]!)) next[index + 1] = 1;
      states = next; offset = close;
    } else {
      const next = new Uint8Array(value.length + 1);
      for (let index = 0; index < value.length; index += 1) if (states[index] && value[index] === char) next[index + 1] = 1;
      states = next;
    }
  }
  return states[value.length] === 1;
}
const SENSITIVE_PATTERN_NAMES = [...new Set(SENSITIVE_PATH_PATTERNS.flatMap((pattern) => {
  const basename = /^\*\*\/([^/]+)$/.exec(pattern)?.[1];
  return basename === undefined ? [] : [basename.replace(/\*+$/g, "")];
})
  .filter((segment) => segment.length > 1))];

function pathCandidates(text: string): string[] {
  const binding = text.indexOf("=");
  if (NON_FILE_URL.test(text.replace(/^-[A-Za-z]/, ""))
    || (binding >= 0 && NON_FILE_URL.test(text.slice(binding + 1)))) return [];
  const values = [text], equals = text.indexOf("="), at = text.indexOf("@");
  if (equals >= 0) values.push(text.slice(equals + 1));
  if (at >= 0) values.push(text.slice(at + 1));
  if (/^-[A-Za-z](?=[~./\\]|[A-Za-z]:[\\/])/.test(text)) values.push(text.slice(2));
  return values.map((value) => value.replace(/^(?:<|(?:FILE|OPEN|GOPEN):)/i, "").replace(/^file:\/\//i, ""))
    .filter((value) => value.length > 0 && value !== "-" && (!value.startsWith("-") || value.includes("=") || value.includes("@")))
    .flatMap((value) => {
      const separator = value.indexOf(":", /^[A-Za-z]:[\\/]/.test(value) ? 2 : 0);
      const source = separator > 0 ? value.slice(0, separator) : "";
      return separator > 0 && /[\\/]|^[.~]/.test(source) ? [value, source] : [value];
    });
}
function normalizeVisiblePath(text: string, home: string): string {
  return text.replace(/["']/g, "").replace(/^~(?=\/|$)/, home).replace(/\$\{HOME\}|\$HOME\b/g, home)
    .replace(/\{([^{}]+)\}/g, (_match, choices: string) => choices.includes(",") || choices.includes("..") ? "*" : choices);
}
// Lexical floor views of an operand; they never establish its filesystem identity.
function lexicalFloorPaths(native: string, normalizedPath: string, floorPaths: readonly string[]): string[] {
  const paths = [normalizedPath, ...floorPaths];
  // A POSIX backslash is a name byte, but a Windows-reading tool treats it as a separator.
  if (sep === "/" && native.includes("\\")) paths.push(posix.normalize(native.replaceAll("\\", "/")));
  return paths;
}
function nativePathProbe(candidate: string, cwd: string | undefined, context: ShellFloorContext): { hit: string | null; sessionRead: boolean } {
  const modeled = modelShellPath(candidate, { dialect: context.pathDialect, location: cwd ?? process.cwd() });
  let sessionRead = false;
  const native = modeled.nativePath;
  if (native !== undefined) {
    // Canonicalize before folding "..": a link's parent is its target's parent.
    const canonical = caseFoldForMatch(context.canonicalize(native, true));
    const hit = context.matchPath(canonical);
    if (hit) return { hit, sessionRead: false };
    sessionRead = context.isSessionReadPath(canonical);
    if (sep === "\\" && /(?:^|[\\/])\.\.(?:[\\/]|$)/.test(native)) {
      let physical: string | undefined;
      try { physical = physicalParentReading(native); } catch { context.unresolvedPath = true; }
      const physicalHit = physical === undefined ? null : context.matchPath(caseFoldForMatch(context.canonicalize(physical, true)));
      if (physicalHit) return { hit: physicalHit, sessionRead: false };
    }
  } else context.unresolvedPath = true;
  // Canonical containment and all its exclusions precede any extra floor view.
  if (!sessionRead) for (const path of lexicalFloorPaths(native ?? modeled.normalizedPath, modeled.normalizedPath, modeled.floorPaths)) {
    const hit = context.matchPath(caseFoldForMatch(path));
    if (hit) return { hit, sessionRead };
  }
  return { hit: null, sessionRead };
}
// Literal prefixes anchor on their canonical identity; a win32 ".." prefix also anchors on its link-following reading.
function globPathFloor(segments: readonly string[], sessionRead: boolean, context: ShellFloorContext): string | null {
  const anchored: (readonly string[])[] = [];
  const firstGlob = segments.findIndex((segment) => /[*?[\]]/.test(segment));
  if (firstGlob > 0) {
    let literalPrefix = segments.slice(0, firstGlob).join("/");
    if (/^[A-Za-z]:$/.test(literalPrefix)) literalPrefix += "/";
    const prefixes = [literalPrefix || "/"];
    if (sep === "\\" && segments.slice(0, firstGlob).includes("..")) {
      try { prefixes.push(physicalParentReading(literalPrefix)); } catch { context.unresolvedPath = true; }
    }
    for (const literal of prefixes) {
      const prefix = context.canonicalize(literal, true);
      const hit = context.matchPath(caseFoldForMatch(prefix)); if (hit) return hit;
      anchored.push([...prefix.replace(/\/$/, "").split("/"), ...segments.slice(firstGlob)]);
    }
  }
  const views = [segments, ...anchored];
  // Sensitive entries have fixed, short segment lists. Compare those lists
  // directly with each source segment instead of rebuilding every path
  // suffix for every possible match.
  for (const entry of SENSITIVE_PATH_ENTRIES) {
    if (sessionRead && entry.access === "read-only") continue;
    // A common basename alone cannot identify the application store: it anchors on canonical prefixes only.
    for (const sourceSegments of entry.anchor === "ave-home" && anchored.length > 0 ? anchored : views) {
      for (let start = 0; start + entry.segments.length <= sourceSegments.length; start += 1) {
        const prefix = sourceSegments.slice(0, start);
        const namespaceMatches = entry.anchor === "ave-home" && prefix.length > 0
          && segmentCouldMatch(caseFoldForMatch(prefix.at(-1)!), ".ave");
        const root = entry.anchor === "ave-home" ? caseFoldForMatch(context.canonicalize(aveHome())).split("/") : [];
        const rootMatches = entry.anchor === "ave-home" && prefix.length === root.length
          && prefix.every((segment, index) => segmentCouldMatch(caseFoldForMatch(segment), root[index]!));
        if (entry.anchor === "ave-home" && !namespaceMatches && !rootMatches) continue;
        let matches = true;
        for (let offset = 0; offset < entry.segments.length; offset += 1) {
          const segment = entry.anchor === "ave-home" ? caseFoldForMatch(sourceSegments[start + offset]!) : sourceSegments[start + offset]!;
          if (!segmentCouldMatch(segment, entry.segments[offset]!, namespaceMatches || rootMatches)) { matches = false; break; }
        }
        if (!matches) continue;
        if (entry.anchor === "ave-home") {
          // Match the same namespace as the host-path projection, including a relocated home.
          return namespaceMatches ? `**/.ave/${entry.segments.join("/")}${entry.kind === "dir" ? "/**" : ""}`
            : `ave-home:${entry.segments.join("/")}`;
        }
        return `**/${entry.segments.join("/")}${entry.kind === "dir" ? "/**" : ""}`;
      }
    }
  }
  for (const view of views) for (const segment of view) for (const name of SENSITIVE_PATTERN_NAMES) {
    if (segmentCouldMatch(segment, name)) return `**/${name}**`;
  }
  return null;
}
export function sensitivePathInArgumentText(text: string, cwd: string | undefined, context = new ShellFloorContext()): string | null {
  context.visits.staticChars += text.length;
  if (!/[\/\\~.@=$*?[\]{}]/.test(text)
    && !SENSITIVE_PATH_ENTRIES.some((entry) => entry.segments.includes(text.replace(/["']/g, "")))) return null;
  const homes = /(?:^|[^\\])~(?=\/|$)|\$\{HOME\}|\$HOME\b/.test(text)
    ? [homedir(), ...expandShellTildePaths("~")] : [""];
  for (const home of homes) for (const candidate of pathCandidates(normalizeVisiblePath(text, home))) {
    const globSource = candidate.replace(/^[\\/]{1,2}\?[\\/](?:UNC[\\/])?/i, prefix => /UNC/i.test(prefix) ? "//" : "");
    if (!/[*?[\]]/.test(globSource)) {
      const { hit } = nativePathProbe(candidate, cwd, context); if (hit) return hit;
      continue;
    }
    const modeled = modelShellPath(candidate, { dialect: context.pathDialect, location: cwd ?? process.cwd() });
    if (modeled.nativePath === undefined) context.unresolvedPath = true;
    // Anchor on the unfolded absolute operand so a link prefix resolves before its "..".
    const absolute = modeled.nativePath ?? modeled.normalizedPath;
    const originalSegments = foldCanonicalPathSeparators(globSource).split("/"), first = originalSegments.findIndex((segment) => /[*?[\]]/.test(segment));
    if (first > 0) {
      let literal = originalSegments.slice(0, first).join("/");
      if (/^[A-Za-z]:$/.test(literal)) literal += "/";
      const { hit } = nativePathProbe(literal || "/", cwd, context); if (hit) return hit;
    }
    const sessionRead = modeled.nativePath !== undefined && context.isSessionReadPath(caseFoldForMatch(context.canonicalize(modeled.nativePath, true)));
    for (const path of new Set([absolute, ...lexicalFloorPaths(absolute, modeled.normalizedPath, modeled.floorPaths)])) {
      const hit = globPathFloor(foldCanonicalPathSeparators(path).split("/"), sessionRead, context); if (hit) return hit;
    }
  }
  return null;
}

export function sensitivePathInLiteralArgumentText(text: string, cwd: string | undefined, context = new ShellFloorContext()): string | null {
  context.visits.staticChars += text.length;
  if (!/[\/\\.@=]/.test(text) && !SENSITIVE_PATH_ENTRIES.some((entry) => entry.segments.includes(text))) return null;
  for (const candidate of pathCandidates(text)) {
    if (/(?:^|[=:])(?:\\\\|\/\/)(?:\?\\UNC\\)?[^\\/]+[\\/][^\\/]+/i.test(candidate)) return "visible UNC path";
    const { hit } = nativePathProbe(candidate, cwd, context);
    if (hit) return hit;
  }
  return null;
}

function optionValue(argv: readonly (string | undefined)[], index: number): string | undefined {
  const token = argv[index]; if (token === undefined) return undefined;
  const equals = token.indexOf("="); return equals >= 0 ? token.slice(equals + 1) : argv[index + 1];
}
function curlShortFileOption(token: string): { kind: "data" | "form" | "upload" | "header"; attached: string } | null {
  if (!/^-[^-]/.test(token)) return null;
  const booleans = "sSfLkviIlnNqgGjJORZpaBM0123456789";
  for (let index = 1; index < token.length; index += 1) {
    const flag = token[index]!;
    const kind = flag === "d" ? "data" : flag === "F" ? "form" : flag === "H" ? "header"
      : flag === "T" || flag === "K" ? "upload" : undefined;
    if (kind) return { kind, attached: token.slice(index + 1) };
    if (!booleans.includes(flag)) return null;
  }
  return null;
}
export interface LiteralShellArgvFacts { sensitive: string | null; exfiltration: string | null; network: boolean; readsPath: boolean; deferredSensitive?: () => string | null }
export function inspectLiteralShellArgvFacts(argv: readonly (string | undefined)[], cwd: string | undefined, context = new ShellFloorContext(), payloadIndexes: ReadonlySet<number> = new Set(), evaluation?: NativeArgvBoundary, sensitiveForNetworkOnly = false): LiteralShellArgvFacts {
  let sensitive: string | null = null, exfiltration: string | null = null;
  let curl = false, wget = false, scp = false, rsync = false, scripted = false, socat = false, network = false, reader = false, readsPath = false;
  let transferOperands = 0, transferDestinationRemote = false;
  let pendingCurlFile: "data" | "form" | "upload" | "header" | undefined;
  const heads = evaluation ?? literalNativeBoundary(argv, context);
  const inspectSensitive = !sensitiveForNetworkOnly || argv.some((token, index) => {
    const name = heads.headNames?.get(index) ?? programName(token);
    return (heads.headIndexes.has(index) || inRange(heads.headRange, index)) && name !== undefined && NETWORK_PROGRAMS.has(name);
  });
  context.visits.staticViews += 1;
  for (let index = 0; index < argv.length; index += 1) {
    context.visits.staticTokens += 1;
    if (payloadIndexes.has(index)) continue;
    const originalToken = argv[index]; if (originalToken === undefined) continue;
    const token: string = curl ? fileTransferOption(originalToken) : originalToken;
    context.visits.staticArguments += 1; context.visits.staticChars += token.length;
    const name: string | undefined = heads.headNames?.get(index) ?? programName(token);
    const isHead = heads.headIndexes.has(index) || inRange(heads.headRange, index);
    curl ||= isHead && name === "curl"; wget ||= isHead && name === "wget"; scp ||= isHead && name === "scp"; rsync ||= isHead && name === "rsync"; scripted ||= isHead && (name === "sftp" || name === "ftp" || name === "lftp" || name === "tftp"); socat ||= isHead && name === "socat";
    network ||= isHead && name !== undefined && NETWORK_PROGRAMS.has(name);
    if (isHead && name !== undefined && PATH_READERS.has(name)) reader = true;
    else if (reader && !token.startsWith("-")) readsPath = true;
    if (inspectSensitive) sensitive ??= sensitivePathInLiteralArgumentText(token, cwd, context);
    if (pendingCurlFile !== undefined) {
      if (pendingCurlFile === "upload") exfiltration ??= "curl upload of a file";
      else if (/^@/.test(token) || (pendingCurlFile === "form" && /(?:^|=)[@<]/.test(token))) exfiltration ??= `curl ${pendingCurlFile} from a file`;
      pendingCurlFile = undefined;
    }
    const short = curl ? curlShortFileOption(token) : null;
    if (curl && (CURL_UPLOAD.test(token) || /^--upload-f/.test(token))) {
      const value = optionValue(argv, index); if (token.includes("=") || /^-T.+/.test(token)) exfiltration ??= "curl upload of a file"; else if (value !== undefined) pendingCurlFile = "upload";
    }
    else if (curl && CURL_DATA.test(token)) { const value = optionValue(argv, index); if (/^@/.test(value ?? "") || (/^--data-urlencode/.test(token) && /@/.test(value ?? ""))) exfiltration ??= "curl body from a file"; else if (!token.includes("=")) pendingCurlFile = "data"; }
    else if (curl && CURL_FORM.test(token)) { const value = optionValue(argv, index); if (/(?:^|=)[@<]/.test(value ?? "")) exfiltration ??= "curl form from a file"; else if (!token.includes("=")) pendingCurlFile = "form"; }
    else if (curl && /^--(?:header|proxy-header)(?:=|$)/.test(token)) { const value = optionValue(argv, index); if (/^@/.test(value ?? "")) exfiltration ??= "curl header from a file"; else if (!token.includes("=")) pendingCurlFile = "header"; }
    else if (short?.kind === "upload") { if (short.attached) exfiltration ??= "curl upload of a file"; else pendingCurlFile = "upload"; }
    else if (short?.kind === "data") { if (/^@/.test(short.attached)) exfiltration ??= "curl body from a file"; else if (!short.attached) pendingCurlFile = "data"; }
    else if (short?.kind === "form") { if (/(?:^|=)[@<]/.test(short.attached)) exfiltration ??= "curl form from a file"; else if (!short.attached) pendingCurlFile = "form"; }
    else if (short?.kind === "header") { if (/^@/.test(short.attached)) exfiltration ??= "curl header from a file"; else if (!short.attached) pendingCurlFile = "header"; }
    else if (wget && (WGET_UPLOAD.test(token) || /^--(?:post-f|body-f)/.test(token))) exfiltration ??= "wget body from a file";
    else if (wget && ((token.startsWith("-e") && wgetFileSetting(token.slice(2)))
      || (token.startsWith("--execute=") && wgetFileSetting(token.slice(10)))
      || ((token === "-e" || token === "--execute") && wgetFileSetting(argv[index + 1] ?? "")))) exfiltration ??= "wget body from a file";
    else if (scripted && /^(?:-b|--batch-file|--input-file)(?:=|$)/.test(token)) exfiltration ??= "scripted transfer from a file";
    else if (socat && /^(?:FILE|OPEN|GOPEN):/i.test(token)) exfiltration ??= "socat reads a file";
    if ((scp || rsync) && name !== "scp" && name !== "rsync" && !token.startsWith("-")) {
      transferOperands += 1;
      transferDestinationRemote = /^(?:[^@\s]+@)?[^:\s]+:/.test(token);
    }
  }
  if (transferOperands >= 2 && transferDestinationRemote) exfiltration ??= `${scp ? "scp" : "rsync"} to a remote target`;
  if (sensitive && (curl || wget || scp || rsync || scripted)) exfiltration ??= `sensitive path argument (${sensitive})`;
  const deferredSensitive = sensitiveForNetworkOnly && !inspectSensitive ? () => {
    for (let index = 0; index < argv.length; index++) {
      if (payloadIndexes.has(index) || argv[index] === undefined) continue;
      const hit = sensitivePathInLiteralArgumentText(argv[index]!, cwd, context);
      if (hit !== null) return hit;
    }
    return null;
  } : undefined;
  return { sensitive, exfiltration, network, readsPath, ...(deferredSensitive ? { deferredSensitive } : {}) };
}
export function inspectLiteralShellArgv(argv: readonly (string | undefined)[], cwd: string | undefined, context = new ShellFloorContext(), payloadIndexes: ReadonlySet<number> = new Set()): { sensitive: string | null; exfiltration: string | null } {
  const { sensitive, exfiltration } = inspectLiteralShellArgvFacts(argv, cwd, context, payloadIndexes);
  return { sensitive, exfiltration };
}

interface StaticPass { deferredSensitive?: (() => string | null)[]; sensitive: string | null; exfiltration: string | null; network: boolean; readsPath: boolean; commandCount: number; socketWrite?: true; changesState?: true; unproven?: string; exactLiteralEvaluation?: true }
function merge(into: StaticPass, value: StaticPass): void { if (value.deferredSensitive) (into.deferredSensitive ??= []).push(...value.deferredSensitive); into.sensitive ??= value.sensitive; into.exfiltration ??= value.exfiltration; into.network ||= value.network; into.socketWrite ||= value.socketWrite; into.readsPath ||= value.readsPath; into.commandCount += value.commandCount; into.changesState ||= value.changesState; into.unproven ??= value.unproven; }
interface IndexRange { from: number; to: number }
export interface NativeArgvBoundary { headIndexes: ReadonlySet<number>; headRange?: IndexRange; headNames?: ReadonlyMap<number, string>; ambiguous?: true }
function inRange(range: IndexRange | undefined, index: number): boolean {
  return range !== undefined && index >= range.from && index < range.to;
}
const argvBoundaries = new WeakMap<ShellFloorContext, WeakMap<readonly (string | undefined)[], NativeArgvBoundary>>();
export function literalNativeBoundary(argv: readonly (string | undefined)[], context: ShellFloorContext): NativeArgvBoundary {
  let boundaries = argvBoundaries.get(context);
  if (boundaries === undefined) { boundaries = new WeakMap(); argvBoundaries.set(context, boundaries); }
  const cached = boundaries.get(argv);
  if (cached !== undefined) return cached;
  const result = inspectNativeBoundary(argv, context);
  boundaries.set(argv, result);
  return result;
}
function inspectNativeBoundary(argv: readonly (string | undefined)[], context: ShellFloorContext): NativeArgvBoundary {
  const read = (index: number): string | undefined => { context.visits.staticTokens += 1; return argv[index]; };
  const wrapped = wrapperCommand(argv);
  context.visits.staticTokens += Math.max(1, wrapped.index + 1);
  if (wrapped.runtimeArgv) return { headIndexes: new Set(wrapped.index < argv.length ? [wrapped.index] : []), ambiguous: true };
  if (wrapped.nestedDialect) return { headIndexes: new Set([0]) };
  if (wrapped.ordinaryAsk || wrapped.candidateRange) return { headIndexes: new Set(), ...(wrapped.candidateRange ? { headRange: wrapped.candidateRange } : {}), ambiguous: true };
  if (wrapped.code) return wrapped.index < argv.length ? { headIndexes: new Set([0]) } : { headIndexes: new Set(), ambiguous: true };
  let programIndex = wrapped.index;
  let forcedInterpreter: string | undefined;
  let packageBoundary = false;
  // Package-runner grammars provide a monotonic sequence of actual command
  // boundaries. Each iteration advances past the previous head; operands that
  // merely spell a launcher never become candidates.
  for (let guard = 0; guard <= argv.length && programIndex < argv.length; guard += 1) {
    const nested = wrapperCommand(argv, 16, programIndex);
    context.visits.staticTokens += Math.max(1, nested.index - programIndex + 1);
    if (nested.runtimeArgv) return { headIndexes: new Set(nested.index < argv.length ? [nested.index] : []), ambiguous: true };
    if (nested.nestedDialect) return { headIndexes: new Set([programIndex]) };
    if (nested.ordinaryAsk || nested.candidateRange) return { headIndexes: new Set(), ...(nested.candidateRange ? { headRange: nested.candidateRange } : {}), ambiguous: true };
    if (nested.code) return nested.index < argv.length
      ? { headIndexes: new Set([programIndex]) }
      : { headIndexes: new Set(), ambiguous: true };
    programIndex = nested.index;
    const head = read(programIndex);
    if (head === undefined) return { headIndexes: new Set(), ambiguous: true };
    const prefixes = RUNNER_COMMAND_PREFIXES[runnerName(head)];
    if (prefixes === undefined) break;
    let first: number | undefined;
    if (prefixes === true) {
      let cursor = programIndex + 1;
      while (cursor < argv.length) {
        const token = read(cursor);
        if (token === undefined) return { headIndexes: new Set(), ambiguous: true };
        if (token === "--") { cursor += 1; break; }
        if (token === "-c" || token === "--call") return cursor + 1 < argv.length
          ? { headIndexes: new Set([programIndex]) }
          : { headIndexes: new Set(), ambiguous: true };
        if (/^(?:-c|--call)=/.test(token)) return { headIndexes: new Set([programIndex]) };
        if (token === "-p" || token === "--package") { cursor += 2; continue; }
        if (/^(?:-p|--package)=/.test(token) || ["-y", "--yes", "--quiet", "--no-install", "--ignore-existing"].includes(token)) { cursor += 1; continue; }
        // Unknown literal runner options do not prove a command boundary.
        // Keep every later literal operand visible as a conservative native
        // candidate, and refuse shell-shaped strings whose binding could be
        // a code payload.
        if (token.startsWith("-")) {
          return { headIndexes: new Set([programIndex]), headRange: { from: cursor + 1, to: argv.length }, ambiguous: true };
        }
        break;
      }
      first = cursor < argv.length ? cursor : undefined;
    } else {
      first = literalCommandAfterPrefix(argv, programIndex + 1);
    }
    if (first === undefined) return { headIndexes: new Set(), ambiguous: true };
    context.visits.staticTokens += Math.max(1, first - programIndex);
    if (prefixes !== true) {
      const prefix = read(first);
      if (!runnerHasPrefix(prefixes, prefix)) return { headIndexes: new Set([programIndex]) };
      const interpreter = prefixes.find((value) => typeof value !== "string" && value[0] === prefix);
      if (interpreter !== undefined) {
        if (prefix === "eval") return first + 1 < argv.length
          ? { headIndexes: new Set([programIndex]) } : { headIndexes: new Set(), ambiguous: true };
        forcedInterpreter = interpreter[1];
        programIndex = first;
        break;
      }
      const command = literalCommandAfterPrefix(argv, first + 1);
      if (command === undefined) return { headIndexes: new Set(), ambiguous: true };
      context.visits.staticTokens += Math.max(1, command - first);
      programIndex = command;
    } else {
      programIndex = first;
    }
    packageBoundary = true;
  }
  // `find` actions invoke a callback with runtime-selected path arguments.
  // Keep their literal tail visible to native floors, but never prove an
  // exact execution identity for the callback.
  if (policyProgramName(read(programIndex) ?? "") === "find") {
    let delegated: number | undefined;
    for (let index = programIndex + 1; index < argv.length; index += 1) {
      const token = read(index);
      if (!["-exec", "-execdir", "-ok", "-okdir"].includes(token ?? "")) continue;
      if (delegated !== undefined || index + 1 >= argv.length || read(index + 1) === undefined) {
        return { headIndexes: new Set([programIndex]), ...(delegated === undefined ? {} : { headRange: { from: delegated, to: argv.length } }), ambiguous: true };
      }
      delegated = index + 1;
    }
    if (delegated !== undefined) return { headIndexes: new Set([programIndex]), headRange: { from: delegated, to: argv.length }, ambiguous: true };
  }
  const rawHead = read(programIndex);
  const name = forcedInterpreter ?? programName(packageBoundary && rawHead !== undefined ? runnerName(rawHead) : rawHead);
  const headIndexes = new Set([programIndex]);
  const headNames = packageBoundary && name !== undefined ? new Map([[programIndex, name]]) : undefined;
  if (name === undefined) return { headIndexes: new Set(), ambiguous: true };

  return { headIndexes, ...(headNames ? { headNames } : {}) };
}
function inspectWord(word: ShellWord, cwd: string | undefined, context: ShellFloorContext, pass: StaticPass, scanPath = true, knownLiteral: string | undefined | null = null): string | undefined {
  const literal = knownLiteral === null ? literalShellWord(word) : knownLiteral; if (literal === undefined) pass.unproven ??= SHELL_RUNTIME_EVALUATION_REASON;
  if (scanPath) pass.sensitive ??= literal === undefined
    ? sensitivePathInArgumentText(word.source.raw, cwd, context) : sensitivePathInLiteralArgumentText(literal, cwd, context);
  if (word.parts.some((part) => part.kind !== "literal" && part.kind !== "unicode-escaped")) pass.unproven ??= SHELL_RUNTIME_EVALUATION_REASON;
  return literal;
}
function inspectRedirect(redirect: ShellRedirect, cwd: string | undefined, context: ShellFloorContext, pass: StaticPass): void {
  if (redirect.target) {
    const target = inspectWord(redirect.target, cwd, context, pass);
    if (redirect.effect === "write" && target !== undefined && /^\/dev\/(?:tcp|udp)\/[^/]+\/[^/]+$/.test(target)) pass.socketWrite = true;
  }
  // Heredoc bodies are data. Quoted bodies are opaque slices; an unquoted
  // body's expansions make the command runtime-dependent, but its literal
  // text is never reinterpreted as a filesystem argument.
  if (redirect.data && !redirect.heredocQuoted && !isShellFloorLiteralData(redirect.data)
    && redirect.data.parts.some((part) => part.kind !== "literal" && part.kind !== "unicode-escaped")) {
    pass.unproven ??= SHELL_RUNTIME_EVALUATION_REASON;
  }
  if (redirect.effect === "read" && redirect.target !== undefined) pass.readsPath = true;
  if (redirect.effect === "write") pass.changesState = true;
}
function inspectCommand(command: ShellCommand, cwd: string | undefined, context: ShellFloorContext, singleOuter: boolean, budget: LiteralBodyBudget, inspectPowerShellBody: PowerShellBodyInspector): StaticPass {
  const pass: StaticPass = { sensitive: null, exfiltration: null, network: false, readsPath: false, commandCount: 1 };
  const argv = command.words.map((word) => literalShellWord(word));
  const raw = command.words.map((word) => word.source.raw);
  if (argv.some((word) => word === undefined)) pass.unproven = SHELL_RUNTIME_EVALUATION_REASON;
  for (const assignment of command.assignments) { inspectWord(assignment.value, cwd, context, pass); for (const element of assignment.elements ?? []) inspectWord(element, cwd, context, pass); pass.unproven ??= SHELL_RUNTIME_EVALUATION_REASON; }
  for (const redirect of command.redirects) inspectRedirect(redirect, cwd, context, pass);
  const proof = verifiedArgvProof(command) ?? proveStaticArgv(argv, "bash", raw, context.visits);
  const evaluation = literalNativeBoundary(argv, context);
  const eligibleLiteralEvaluation = pass.unproven === undefined && command.assignments.length === 0 && command.redirects.length === 0;
  const payload = proof.kind === "literal-evaluation" ? new Set(proof.payloadIndexes) : undefined;
  if (proof.kind === "unproven") pass.unproven ??= SHELL_RUNTIME_EVALUATION_REASON;
  else if (proof.kind === "static-complete" && proof.changesState) pass.changesState = true;
  else if (proof.kind === "literal-evaluation") {
    pass.unproven = SHELL_RUNTIME_EVALUATION_REASON;
    if (singleOuter && eligibleLiteralEvaluation) pass.exactLiteralEvaluation = true;
  }
  for (let index = 0; index < command.words.length; index += 1) if (!payload?.has(index) && argv[index] === undefined) {
    inspectWord(command.words[index]!, cwd, context, pass, true, argv[index]);
  }
  const childFlow = { network: false, readsPath: false };
  const effective = effectiveShellWords(command.words);
  const bodyArgv = effective.unsupported ? argv : effective.words.map(literalShellWord);
  const bodyRaw = effective.unsupported ? raw : effective.words.map(word => word.source.raw);
  const input = command.redirects.filter(redirect => redirect.fileDescriptor === 0 || redirect.fileDescriptor === undefined && redirect.effect === "read").at(-1);
  const inputProgram = input?.data ? staticShellWord(input.data) : undefined;
  const executableBodies = bodyArgv.every((value): value is string => typeof value === "string") ? shellExecutableBodySlots(bodyArgv, inputProgram) : [];
  const bodyOffset = effective.unsupported ? 0 : command.words.indexOf(effective.words[0]!);
  for (const body of literalShellBodies(bodyArgv, bodyRaw, executableBodies.find(body => body.index === bodyArgv.length)?.text, shellLiteralFragments(effective.unsupported ? command.words : effective.words))) {
    const executed = payload?.has(body.index + bodyOffset) || executableBodies.some(candidate => candidate.index === body.index && candidate.dialect === body.dialect)
      || executableBodies.some(candidate => candidate.index === body.index && candidate.index === bodyArgv.length);
    const childBudget = { tokens: budget.tokens, depth: budget.depth + 1, literalBody: true as const, ...(!executed ? { floorOnly: true as const } : {}) };
    const unresolvedBeforeBody = context.unresolvedPath;
    const child = body.dialect === "powershell"
      ? inspectPowerShellBody(body.text, cwd, childBudget)
      : inspectPosixShellCommand(body.text, cwd, context, childBudget, inspectPowerShellBody);
    if (!executed) context.unresolvedPath = unresolvedBeforeBody;
    if (executed) pass.sensitive ??= child.sensitive;
    pass.exfiltration ??= child.exfiltration;
    const flow = literalShellFlow(child);
    if (executed) { childFlow.network ||= flow?.network === true; childFlow.readsPath ||= flow?.readsPath === true; }
    if (child.analysisLimited) throw new ShellFloorLimitError(SHELL_FLOOR_BUDGET_REASON);
  }
  const unresolvedPath = context.unresolvedPath;
  const native = inspectLiteralShellArgvFacts(argv, cwd, context, payload, evaluation, budget.floorOnly === true); pass.sensitive ??= native.sensitive; pass.exfiltration ??= native.exfiltration;
  if (native.deferredSensitive) (pass.deferredSensitive ??= []).push(native.deferredSensitive);
  if (budget.literalBody) for (let index = 1; index < argv.length && pass.exfiltration === null; index++) {
    const candidate = programName(argv[index]);
    if (candidate !== undefined && NETWORK_PROGRAMS.has(candidate)) pass.exfiltration ??= inspectLiteralShellArgvFacts(argv.slice(index), cwd, context).exfiltration;
  }
  // Literal output data can add a visible floor without requiring filesystem identity.
  if (proof.kind === "static-complete" && proof.dataOnly) context.unresolvedPath = unresolvedPath;
  pass.network ||= native.network; pass.readsPath ||= native.readsPath;
  // A proven file-reader head still consumes possible file operands when their
  // expansion is unknown; it must not lose that input flow at a socket redirect.
  if (!pass.readsPath) {
    for (const index of evaluation.headIndexes) {
      const name = evaluation.headNames?.get(index) ?? programName(argv[index]);
      if (name !== undefined && PATH_READERS.has(name)
        && command.words.some((_, operand) => {
          context.visits.staticTokens += 1;
          return operand > index && !payload?.has(operand) && argv[operand] === undefined;
        })) pass.readsPath = true;
    }
  }
  if (pass.socketWrite && pass.readsPath) pass.network = true;
  if (pass.network && pass.readsPath) pass.exfiltration ??= "network command reads a file";
  if (pass.socketWrite && childFlow.readsPath || pass.readsPath && childFlow.network) pass.exfiltration ??= "literal shell body connects file data to a network transport";
  pass.network ||= childFlow.network;
  pass.readsPath ||= childFlow.readsPath;
  return pass;
}
function inspectStatement(statement: ShellStatement, cwd: string | undefined, context: ShellFloorContext, singleOuter: boolean, budget: LiteralBodyBudget, inspectPowerShellBody: PowerShellBodyInspector): StaticPass {
  context.visits.staticNodes += 1;
  if (statement.kind === "command") return inspectCommand(statement, cwd, context, singleOuter, budget, inspectPowerShellBody);
  const pass: StaticPass = { sensitive: null, exfiltration: null, network: false, readsPath: false, commandCount: 0 }, child = (value: ShellStatement): void => merge(pass, inspectStatement(value, cwd, context, false, budget, inspectPowerShellBody));
  switch (statement.kind) {
    case "sequence":
      for (const value of statement.statements) child(value);
      break;
    case "pipeline": { let read = false; for (const value of statement.statements) { const stage = inspectStatement(value, cwd, context, false, budget, inspectPowerShellBody); if (read && (stage.network || stage.socketWrite)) stage.exfiltration ??= "network command fed from a file"; merge(pass, stage); read ||= stage.readsPath; } break; }
    case "and": case "or":
      child(statement.left); child(statement.right);
      break;
    case "subshell": case "background": child(statement.body); pass.unproven ??= SHELL_RUNTIME_EVALUATION_REASON; break;
    case "negate": child(statement.body); break;
    case "redirected":
      for (const redirect of statement.redirects) inspectRedirect(redirect, cwd, context, pass);
      child(statement.body);
      if (pass.socketWrite && pass.readsPath) pass.exfiltration ??= "network command reads a file";
      break;
    case "for": for (const value of statement.values ?? []) inspectWord(value, cwd, context, pass); child(statement.body); pass.unproven ??= SHELL_RUNTIME_EVALUATION_REASON; break;
    case "while": child(statement.condition); child(statement.body); pass.unproven ??= SHELL_RUNTIME_EVALUATION_REASON; break;
    case "if": child(statement.condition); child(statement.consequent); child(statement.alternate); pass.unproven ??= SHELL_RUNTIME_EVALUATION_REASON; break;
    case "function": child(statement.body); pass.unproven ??= SHELL_RUNTIME_EVALUATION_REASON; break;
    case "unsupported": pass.unproven ??= statement.reason; break;
  }
  return pass;
}

const floorContexts = new WeakMap<ParsedShellCommand, ShellFloorContext>();
export function parseShellFloorCommand(input: ShellCommandInput, maxInputLength = 8_000, syntaxCounter?: object): ParsedShellCommand {
  if ((typeof input === "string" ? input : input.command).length > maxInputLength && shellFloorInputExceeded(input)) throw new ShellFloorLimitError(SHELL_FLOOR_BUDGET_REASON);
  if (typeof input !== "string" && (input.analysis.ok || input.analysis.reason !== "literal command length limit exceeded")) {
    if (input.analysis.ok && input.analysis.totalTokens !== undefined && input.analysis.totalTokens > MAX_SHELL_ANALYSIS_TOKENS) throw new ShellFloorLimitError(SHELL_FLOOR_BUDGET_REASON);
    return input;
  }
  const command = typeof input === "string" ? input : input.command;
  const observation = shellSyntaxObservation(command, "bash", { totalTokens: MAX_SHELL_ANALYSIS_TOKENS }, syntaxCounter);
  return !observation.analysis.ok && !("parserError" in observation) && shellFloorFallbackInputExceeded(command)
    ? { command, analysis: { ok: false, reason: "Shell analysis total token limit exceeded" }, facts: new Map() }
    : { command, ...observation, facts: new Map() };
}
function parsedWithContext(input: ShellCommandInput, context: ShellFloorContext, syntaxCounter: object): ParsedShellCommand {
  if (typeof input !== "string") { floorContexts.set(input, context); return input; }
  const key = `bash-parse\0${input}`; let parsed = context.facts.get(key) as ParsedShellCommand | undefined;
  if (!parsed) { context.visits.lexes += 1; parsed = parseShellFloorCommand(input, 8_000, syntaxCounter); context.facts.set(key, parsed); }
  floorContexts.set(parsed, context); return parsed;
}
type PowerShellBodyInspector = (command: string, cwd: string | undefined, budget: LiteralBodyBudget) => ShellFloorSignals;

export function inspectPosixShellCommand(input: ShellCommandInput, cwd: string | undefined, supplied: ShellFloorContext | undefined, budget: LiteralBodyBudget, inspectPowerShellBody: PowerShellBodyInspector): ShellFloorSignals {
  if (budget.depth >= 16 || budget.tokens.count > MAX_SHELL_ANALYSIS_TOKENS || shellFloorInputExceeded(input)) return shellFloorBudgetSignals();
  const context = supplied ?? (typeof input === "string" ? new ShellFloorContext() : floorContexts.get(input) ?? new ShellFloorContext());
  try {
    if (budget.depth >= 16) return shellFloorBudgetSignals();
    if (typeof input !== "string") bindShellSyntaxSnapshot(input, budget.tokens);
    const parsed = parsedWithContext(input, context, budget.tokens);
    if (parsed.analysis.ok) budget.tokens.count += parsed.analysis.totalTokens ?? 0;
    if (budget.tokens.count > MAX_SHELL_ANALYSIS_TOKENS) return shellFloorBudgetSignals();
    return shellFact(parsed, `static-floor\0${budget.floorOnly === true ? "literal" : "complete"}\0${cwd ?? ""}`, () => {
      if (!parsed.analysis.ok) {
        const limited = shellFloorParserBudgetExceeded(parsed.analysis.reason);
        let sensitive: string | null = null;
        for (const match of parsed.command.matchAll(/"[^"\n]*"|'[^'\n]*'|[^\s;|&()<>]+/g)) {
          sensitive ??= sensitivePathInArgumentText(match[0], cwd, context);
        }
        const exfiltration = UNPARSED_UPLOAD.test(parsed.command) ? "curl/wget body from a file (unparsed)" : null;
        return { ...(limited ? shellFloorBudgetSignals() : {}), outcome: sensitive || exfiltration ? "visible-floor" : "unproven", sensitive, exfiltration, ordinaryAsk: limited ? SHELL_FLOOR_BUDGET_REASON : parsed.analysis.reason };
      }
      const root = parsed.analysis.program, single = root.kind === "command" || (root.kind === "sequence" && root.statements.length === 1 && root.statements[0]?.kind === "command");
      const statement = root.kind === "sequence" && root.statements.length === 1 ? root.statements[0]! : root;
      const pass = inspectStatement(statement, cwd, context, single, budget, inspectPowerShellBody);
      if (pass.network) for (const probe of pass.deferredSensitive ?? []) { pass.sensitive ??= probe(); if (pass.sensitive !== null) break; }
      if (context.unresolvedPath) {
        pass.unproven ??= "Shell path namespace is unresolved";
        pass.exactLiteralEvaluation = undefined;
      }
      const encodedReason = encodedPowerShellExecutionReason([parsed.command]);
      if (encodedReason !== null) { pass.unproven = encodedReason; pass.exactLiteralEvaluation = undefined; }
      if (pass.commandCount > 1 && pass.changesState) pass.unproven ??= SHELL_RUNTIME_EVALUATION_REASON;
      if (pass.sensitive && pass.network) pass.exfiltration ??= `sensitive path (${pass.sensitive}) with a network transport`;
      const visible = pass.sensitive !== null || pass.exfiltration !== null;
      return recordLiteralShellFlow({ outcome: visible ? "visible-floor" as const : pass.unproven ? "unproven" as const : "static-complete" as const, sensitive: pass.sensitive, exfiltration: pass.exfiltration, ...(pass.unproven ? { ordinaryAsk: pass.unproven } : {}), ...(pass.exactLiteralEvaluation ? { exactLiteralEvaluation: true as const } : {}) }, { network: pass.network, readsPath: pass.readsPath });
    });
  } catch (error) { if (error instanceof ShellFloorLimitError) return shellFloorBudgetSignals(); throw error; }
}
