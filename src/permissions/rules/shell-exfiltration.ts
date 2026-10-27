import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { aveHome } from "../../shared/ave-home.js";
import { expandShellTildePaths } from "../../shared/home-tilde.js";
import { analyzeShell, type ShellCommand, type ShellRedirect, type ShellStatement, type ShellWord } from "../../shared/shell-analysis.js";
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
const DYNAMIC_REASON = "Shell command requires runtime evaluation";

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
export function sensitivePathInArgumentText(text: string, cwd: string | undefined, context = new ShellFloorContext()): string | null {
  context.visits.staticChars += text.length;
  if (!/[\/\\~.@=$*?[\]{}]/.test(text)
    && !SENSITIVE_PATH_ENTRIES.some((entry) => entry.segments.includes(text.replace(/["']/g, "")))) return null;
  const homes = /(?:^|[^\\])~(?=\/|$)|\$\{HOME\}|\$HOME\b/.test(text)
    ? [homedir(), ...expandShellTildePaths("~")] : [""];
  for (const home of homes) for (const candidate of pathCandidates(normalizeVisiblePath(text, home))) {
    const absolute = isAbsolute(candidate) ? candidate : resolve(cwd ?? "/", candidate);
    if (!/[*?[\]]/.test(absolute)) {
      const hit = context.matchPath(caseFoldForMatch(context.canonicalize(absolute, true))); if (hit) return hit;
      continue;
    }
    const segments = foldCanonicalPathSeparators(absolute).split("/");
    let anchoredSegments = segments;
    const first = segments.findIndex((segment) => /[*?[\]]/.test(segment));
    if (first > 0) {
      let literalPrefix = segments.slice(0, first).join("/");
      if (process.platform === "win32" && /^[A-Za-z]:$/.test(literalPrefix)) literalPrefix += "/";
      const prefix = context.canonicalize(literalPrefix || "/", true);
      const hit = context.matchPath(caseFoldForMatch(prefix)); if (hit) return hit;
      anchoredSegments = [...prefix.replace(/\/$/, "").split("/"), ...segments.slice(first)];
    }
    // Sensitive entries have fixed, short segment lists. Compare those lists
    // directly with each source segment instead of rebuilding every path
    // suffix for every possible match.
    for (const entry of SENSITIVE_PATH_ENTRIES) {
      const sourceSegments = entry.anchor === "ave-home" ? anchoredSegments : segments;
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
          // Match the same namespace as the host-path projection, including a
          // relocated home. A common basename alone cannot identify this store.
          return namespaceMatches ? `**/.ave/${entry.segments.join("/")}${entry.kind === "dir" ? "/**" : ""}`
            : `ave-home:${entry.segments.join("/")}`;
        }
        return `**/${entry.segments.join("/")}${entry.kind === "dir" ? "/**" : ""}`;
      }
    }
    for (const segment of segments) for (const name of SENSITIVE_PATTERN_NAMES) {
      if (segmentCouldMatch(segment, name)) return `**/${name}**`;
    }
  }
  return null;
}

export function sensitivePathInLiteralArgumentText(text: string, cwd: string | undefined, context = new ShellFloorContext()): string | null {
  context.visits.staticChars += text.length;
  if (!/[\/\\.@=]/.test(text) && !SENSITIVE_PATH_ENTRIES.some((entry) => entry.segments.includes(text))) return null;
  for (const candidate of pathCandidates(text)) {
    if (/(?:^|[=:])(?:\\\\|\/\/)(?:\?\\UNC\\)?[^\\/]+[\\/][^\\/]+/i.test(candidate)) return "visible UNC path";
    const absolute = isAbsolute(candidate) ? candidate : resolve(cwd ?? "/", candidate);
    const hit = context.matchPath(caseFoldForMatch(context.canonicalize(absolute, true)));
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
export interface LiteralShellArgvFacts { sensitive: string | null; exfiltration: string | null; network: boolean; readsPath: boolean }
export function inspectLiteralShellArgvFacts(argv: readonly (string | undefined)[], cwd: string | undefined, context = new ShellFloorContext(), payloadIndexes: ReadonlySet<number> = new Set(), evaluation?: NativeArgvBoundary): LiteralShellArgvFacts {
  let sensitive: string | null = null, exfiltration: string | null = null;
  let curl = false, wget = false, scp = false, rsync = false, scripted = false, socat = false, network = false, reader = false, readsPath = false;
  let transferOperands = 0, transferDestinationRemote = false;
  let pendingCurlFile: "data" | "form" | "upload" | "header" | undefined;
  const heads = evaluation ?? literalNativeBoundary(argv, context);
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
    sensitive ??= sensitivePathInLiteralArgumentText(token, cwd, context);
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
  return { sensitive, exfiltration, network, readsPath };
}
export function inspectLiteralShellArgv(argv: readonly (string | undefined)[], cwd: string | undefined, context = new ShellFloorContext(), payloadIndexes: ReadonlySet<number> = new Set()): { sensitive: string | null; exfiltration: string | null } {
  const { sensitive, exfiltration } = inspectLiteralShellArgvFacts(argv, cwd, context, payloadIndexes);
  return { sensitive, exfiltration };
}

interface StaticPass { sensitive: string | null; exfiltration: string | null; network: boolean; readsPath: boolean; commandCount: number; changesState?: true; unproven?: string; exactLiteralEvaluation?: true }
function merge(into: StaticPass, value: StaticPass): void { into.sensitive ??= value.sensitive; into.exfiltration ??= value.exfiltration; into.network ||= value.network; into.readsPath ||= value.readsPath; into.commandCount += value.commandCount; into.changesState ||= value.changesState; into.unproven ??= value.unproven; }
interface IndexRange { from: number; to: number }
interface NativeArgvBoundary { headIndexes: ReadonlySet<number>; headRange?: IndexRange; headNames?: ReadonlyMap<number, string>; ambiguous?: true }
function inRange(range: IndexRange | undefined, index: number): boolean {
  return range !== undefined && index >= range.from && index < range.to;
}
const argvBoundaries = new WeakMap<ShellFloorContext, WeakMap<readonly (string | undefined)[], NativeArgvBoundary>>();
function literalNativeBoundary(argv: readonly (string | undefined)[], context: ShellFloorContext): NativeArgvBoundary {
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
  const literal = knownLiteral === null ? literalShellWord(word) : knownLiteral; if (literal === undefined) pass.unproven ??= DYNAMIC_REASON;
  if (scanPath) pass.sensitive ??= literal === undefined
    ? sensitivePathInArgumentText(word.source.raw, cwd, context) : sensitivePathInLiteralArgumentText(literal, cwd, context);
  if (word.parts.some((part) => part.kind !== "literal" && part.kind !== "unicode-escaped")) pass.unproven ??= DYNAMIC_REASON;
  return literal;
}
function inspectRedirect(redirect: ShellRedirect, cwd: string | undefined, context: ShellFloorContext, pass: StaticPass): void {
  if (redirect.target) inspectWord(redirect.target, cwd, context, pass);
  // Heredoc bodies are data. Quoted bodies are opaque slices; an unquoted
  // body's expansions make the command runtime-dependent, but its literal
  // text is never reinterpreted as a filesystem argument.
  if (redirect.data && !redirect.heredocQuoted && !isShellFloorLiteralData(redirect.data)
    && redirect.data.parts.some((part) => part.kind !== "literal" && part.kind !== "unicode-escaped")) {
    pass.unproven ??= DYNAMIC_REASON;
  }
  if (redirect.effect === "read" && redirect.target !== undefined) pass.readsPath = true;
  if (redirect.effect === "write") pass.changesState = true;
}
function inspectCommand(command: ShellCommand, cwd: string | undefined, context: ShellFloorContext, singleOuter: boolean): StaticPass {
  const pass: StaticPass = { sensitive: null, exfiltration: null, network: false, readsPath: false, commandCount: 1 };
  const argv = command.words.map((word) => literalShellWord(word));
  const raw = command.words.map((word) => word.source.raw);
  if (argv.some((word) => word === undefined)) pass.unproven = DYNAMIC_REASON;
  for (const assignment of command.assignments) { inspectWord(assignment.value, cwd, context, pass); for (const element of assignment.elements ?? []) inspectWord(element, cwd, context, pass); pass.unproven ??= DYNAMIC_REASON; }
  for (const redirect of command.redirects) inspectRedirect(redirect, cwd, context, pass);
  const proof = verifiedArgvProof(command) ?? proveStaticArgv(argv, "bash", raw, context.visits);
  const evaluation = literalNativeBoundary(argv, context);
  const eligibleLiteralEvaluation = pass.unproven === undefined && command.assignments.length === 0 && command.redirects.length === 0;
  const payload = proof.kind === "literal-evaluation" ? new Set(proof.payloadIndexes) : undefined;
  if (proof.kind === "unproven") pass.unproven ??= DYNAMIC_REASON;
  else if (proof.kind === "static-complete" && proof.changesState) pass.changesState = true;
  else if (proof.kind === "literal-evaluation") {
    pass.unproven = DYNAMIC_REASON;
    if (singleOuter && eligibleLiteralEvaluation) pass.exactLiteralEvaluation = true;
  }
  for (let index = 0; index < command.words.length; index += 1) if (!payload?.has(index) && argv[index] === undefined) {
    inspectWord(command.words[index]!, cwd, context, pass, true, argv[index]);
  }
  const native = inspectLiteralShellArgvFacts(argv, cwd, context, payload, evaluation); pass.sensitive ??= native.sensitive; pass.exfiltration ??= native.exfiltration;
  pass.network = native.network; pass.readsPath ||= native.readsPath;
  if (pass.network && pass.readsPath) pass.exfiltration ??= "network command reads a file";
  return pass;
}
function inspectStatement(statement: ShellStatement, cwd: string | undefined, context: ShellFloorContext, singleOuter = false): StaticPass {
  context.visits.staticNodes += 1;
  if (statement.kind === "command") return inspectCommand(statement, cwd, context, singleOuter);
  const pass: StaticPass = { sensitive: null, exfiltration: null, network: false, readsPath: false, commandCount: 0 }, child = (value: ShellStatement): void => merge(pass, inspectStatement(value, cwd, context));
  switch (statement.kind) {
    case "sequence":
      for (const value of statement.statements) child(value);
      break;
    case "pipeline": { let read = false; for (const value of statement.statements) { const stage = inspectStatement(value, cwd, context); if (read && stage.network) stage.exfiltration ??= "network command fed from a file"; merge(pass, stage); read ||= stage.readsPath; } break; }
    case "and": case "or":
      child(statement.left); child(statement.right);
      break;
    case "subshell": case "background": child(statement.body); pass.unproven ??= DYNAMIC_REASON; break;
    case "negate": child(statement.body); break;
    case "redirected": for (const redirect of statement.redirects) inspectRedirect(redirect, cwd, context, pass); child(statement.body); break;
    case "for": for (const value of statement.values ?? []) inspectWord(value, cwd, context, pass); child(statement.body); pass.unproven ??= DYNAMIC_REASON; break;
    case "while": child(statement.condition); child(statement.body); pass.unproven ??= DYNAMIC_REASON; break;
    case "if": child(statement.condition); child(statement.consequent); child(statement.alternate); pass.unproven ??= DYNAMIC_REASON; break;
    case "function": child(statement.body); pass.unproven ??= DYNAMIC_REASON; break;
    case "unsupported": pass.unproven ??= statement.reason; break;
  }
  return pass;
}

const floorContexts = new WeakMap<ParsedShellCommand, ShellFloorContext>();
export function parseShellFloorCommand(input: ShellCommandInput, maxInputLength = 8_000): ParsedShellCommand {
  if ((typeof input === "string" ? input : input.command).length > maxInputLength && shellFloorInputExceeded(input)) throw new ShellFloorLimitError(SHELL_FLOOR_BUDGET_REASON);
  if (typeof input !== "string" && (input.analysis.ok || input.analysis.reason !== "literal command length limit exceeded")) {
    if (input.analysis.ok && input.analysis.totalTokens !== undefined && input.analysis.totalTokens > MAX_SHELL_ANALYSIS_TOKENS) throw new ShellFloorLimitError(SHELL_FLOOR_BUDGET_REASON);
    return input;
  }
  const command = typeof input === "string" ? input : input.command;
  try { const analysis = analyzeShell(command, "bash", { totalTokens: MAX_SHELL_ANALYSIS_TOKENS }); return !analysis.ok && shellFloorFallbackInputExceeded(command) ? { command, analysis: { ok: false, reason: "Shell analysis total token limit exceeded" }, facts: new Map() } : { command, analysis, facts: new Map() }; }
  catch (parserError) { return { command, analysis: { ok: false, reason: "shell parser failed" }, parserError, facts: new Map() }; }
}
function parsedWithContext(input: ShellCommandInput, context: ShellFloorContext): ParsedShellCommand {
  if (typeof input !== "string") { floorContexts.set(input, context); return input; }
  const key = `bash-parse\0${input}`; let parsed = context.facts.get(key) as ParsedShellCommand | undefined;
  if (!parsed) { context.visits.lexes += 1; parsed = parseShellFloorCommand(input); context.facts.set(key, parsed); }
  floorContexts.set(parsed, context); return parsed;
}
export function inspectShellCommand(input: ShellCommandInput, cwd?: string, supplied?: ShellFloorContext): ShellFloorSignals {
  if (shellFloorInputExceeded(input)) return shellFloorBudgetSignals();
  const context = supplied ?? (typeof input === "string" ? new ShellFloorContext() : floorContexts.get(input) ?? new ShellFloorContext());
  try {
    const parsed = parsedWithContext(input, context);
    return shellFact(parsed, `static-floor\0${cwd ?? ""}`, () => {
      if (!parsed.analysis.ok) {
        if (shellFloorParserBudgetExceeded(parsed.analysis.reason)) return shellFloorBudgetSignals();
        const sensitive = sensitivePathInArgumentText(parsed.command, cwd, context), exfiltration = UNPARSED_UPLOAD.test(parsed.command) ? "curl/wget body from a file (unparsed)" : null;
        return { outcome: sensitive || exfiltration ? "visible-floor" : "unproven", sensitive, exfiltration, ordinaryAsk: parsed.analysis.reason };
      }
      const root = parsed.analysis.program, single = root.kind === "command" || (root.kind === "sequence" && root.statements.length === 1 && root.statements[0]?.kind === "command");
      const statement = root.kind === "sequence" && root.statements.length === 1 ? root.statements[0]! : root;
      const pass = inspectStatement(statement, cwd, context, single);
      const encodedReason = encodedPowerShellExecutionReason([parsed.command]);
      if (encodedReason !== null) { pass.unproven = encodedReason; pass.exactLiteralEvaluation = undefined; }
      if (pass.commandCount > 1 && pass.changesState) pass.unproven ??= DYNAMIC_REASON;
      if (pass.sensitive && pass.network) pass.exfiltration ??= `sensitive path (${pass.sensitive}) with a network transport`;
      const visible = pass.sensitive !== null || pass.exfiltration !== null;
      return { outcome: visible ? "visible-floor" : pass.unproven ? "unproven" : "static-complete", sensitive: pass.sensitive, exfiltration: pass.exfiltration, ...(pass.unproven ? { ordinaryAsk: pass.unproven } : {}), ...(pass.exactLiteralEvaluation ? { exactLiteralEvaluation: true as const } : {}) };
    });
  } catch (error) { if (error instanceof ShellFloorLimitError) return shellFloorBudgetSignals(); throw error; }
}
export function shellExfiltrationSignal(input: ShellCommandInput | readonly (string | undefined)[], cwd?: string, context?: ShellFloorContext): string | null { return Array.isArray(input) ? inspectLiteralShellArgv(input, cwd, context).exfiltration : inspectShellCommand(input as ShellCommandInput, cwd, context).exfiltration; }
export function shellSensitivePathSignal(input: ShellCommandInput, cwd?: string): string | null { return inspectShellCommand(input, cwd).sensitive; }
export function shellScanProofBlocker(input: ShellCommandInput, cwd?: string): string | null { const result = inspectShellCommand(input, cwd); return result.analysisLimited ? result.ordinaryAsk ?? SHELL_FLOOR_BUDGET_REASON : result.exactLiteralEvaluation ? null : result.outcome === "unproven" ? result.ordinaryAsk ?? DYNAMIC_REASON : null; }
export function shellScanOrdinaryAsk(input: ShellCommandInput, cwd?: string): string | null { const result = inspectShellCommand(input, cwd); return result.outcome === "unproven" ? result.ordinaryAsk ?? DYNAMIC_REASON : null; }
export function _inspectShellForTest(input: ShellCommandInput, cwd?: string) { const context = new ShellFloorContext(); context.visits.frames += 1; return { ...inspectShellCommand(input, cwd, context), visits: { ...context.visits } }; }
