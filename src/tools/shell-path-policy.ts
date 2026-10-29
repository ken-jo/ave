import { isAbsolute, join } from "node:path";
import { homedir } from "node:os";
import { hostScriptInvocationReadPaths, isHostScriptReadPath } from "../main/host-script-runtime.js";
import { t } from "../i18n/index.js";
import { displayShellWord, shellWordHasSingleField, staticShellWord, type ShellWord } from "../shared/shell-analysis.js";
import { commandLeaf, effectiveShellWords, namesCommandPath, stripCommandPath } from "../shared/shell-effective-command.js";
import { assertStableShellEnvironmentVariable, inspectShellExecution, ShellExecutionError, type ShellExecutionFacts, type ShellCommandEvent } from "../shared/shell-execution.js";
import { validateSandboxPath } from "../sandbox/path-validator.js";
import { canonicalizePathForMatch, caseFoldForMatch, isConfiguredSessionReadPath, isAdmissionDeniedPath, createPermissionPathEvidence, type PermissionPathEvidence } from "../permissions/sensitive-paths.js";
import { inspectSedScriptFileAccess, isReadOnlyShellLeaf } from "../permissions/reviewer/host-risk-inspector.js";
import { pathEffectIsConfined, type PathEffect } from "../permissions/allowed-directories.js";
import { parseTarListing } from "../shared/shell-tar-listing.js";
import { RECURSIVE_TRAVERSAL_COMMANDS, recursiveTraversalFlag } from "../shared/shell-recursive-traversal.js";
import { resolveShellFilesystemPath } from "../shared/shell-filesystem-path.js";
import { modelShellPath } from "../shared/shell-native-path.js";
import { expandShellTildePaths } from "../shared/home-tilde.js";
import { classifySqliteArgumentSlots } from "./shell-sqlite-arguments.js";
import { CURL_OPTION_TABLE, WGET_OPTION_TABLE, WGETRC_COMMAND_TABLE, type ShellOptionTable } from "./shell-option-tables.js";
import { shellFloorParserBudgetExceeded } from "../permissions/rules/shell-floor-policy.js";
import { MAX_SHELL_ANALYSIS_TOKENS } from "../shared/shell-analysis-limits.js";

type ShellPathPolicyViolationKind =
  | "dynamic-path"
  | "invalid-path"
  | "recursive-traversal"
  | "sandbox-boundary"
  | "analysis-limit"
  | "sensitive-path";

export interface ShellPathPolicyViolation {
  kind: ShellPathPolicyViolationKind;
  reason: string;
  candidate?: string;
  path?: string;
}

// Exempt only public child standard streams; arbitrary descriptor paths can expose other files.
const SHELL_DEVICE_PATHS: ReadonlySet<string> = new Set([
  "/dev/null", "/dev/stdin", "/dev/stdout", "/dev/stderr",
]);

/** Native aliases must not evade the deny floor or acquire wider path authority. */
function windowsShellPathViolation(path: string, label: string, effect: PathEffect): ShellPathPolicyViolation | null {
  if (process.platform !== "win32") return null;
  const slashed = path.replaceAll("\\", "/");
  const namespaced = /^\/\/[?.]\//.test(slashed);
  const ordinary = slashed.replace(/^\/\/[?.]\//, "").replace(/^UNC\//i, "//");
  const components = ordinary.split("/");
  const normalized = components.map((part, index) => {
    if (part === "." || part === ".." || (index === 0 && /^[a-z]:$/i.test(part))) return part;
    return part.split(":", 1)[0]!.replace(/[. ]+$/, "");
  }).join("/");
  const modeled = modelShellPath(normalized, { dialect: "bash" });
  const canonical = modeled.nativePath === undefined ? undefined : caseFoldForMatch(canonicalizePathForMatch(modeled.nativePath));
  let sensitive = canonical === undefined ? null : isAdmissionDeniedPath(canonical, effect);
  const sessionRead = effect === "read" && canonical !== undefined && isConfiguredSessionReadPath(canonical);
  if (!sessionRead) for (const candidate of modeled.floorPaths) sensitive ??= isAdmissionDeniedPath(caseFoldForMatch(candidate), effect);
  if (sensitive) return {
    kind: "sensitive-path",
    reason: `Sensitive path: command operand ${label} matches ${sensitive}`,
    candidate: label,
    path,
  };
  // Refuse short-name-like components even if they exist; alias replacement can change identity before execution.
  // Device namespaces, streams, and trimmed components have no authority until exact identity is known.
  if (namespaced || normalized !== ordinary || components.some(part => /~\d+(?:\.|$)/.test(part))) return {
    kind: "invalid-path",
    reason: `Shell path policy: ambiguous native path is not supported: ${label}`,
    candidate: label,
    path,
  };
  // Bare DOS device names identify devices; explicit device namespaces remain refused.
  return null;
}

export function validateShellWorkingDirectory(
  cwd: string,
  sandboxRoot: string,
  extraAllowedDirectories: readonly string[],
): string | null {
  const nativeViolation = windowsShellPathViolation(cwd, cwd, "write");
  if (nativeViolation) return nativeViolation.reason;
  const sensitive = isAdmissionDeniedPath(caseFoldForMatch(canonicalizePathForMatch(cwd)));
  if (sensitive) {
    return `Sensitive path: cwd ${cwd} matches ${sensitive}`;
  }
  const check = validateSandboxPath(cwd, sandboxRoot, [...extraAllowedDirectories]);
  return check.allowed ? null : `Sandbox: ${check.reason}`;
}

export function findResolvedShellPathViolation(
  absolute: string,
  label: string,
  sandboxRoot: string,
  extraAllowedDirectories: readonly string[],
  effect: PathEffect,
  blockReadsOutsideWorkingDirectories: boolean,
): ShellPathPolicyViolation | null {
  const nativeViolation = windowsShellPathViolation(absolute, label, effect);
  if (nativeViolation) return nativeViolation;
  const canonicalPath = caseFoldForMatch(canonicalizePathForMatch(absolute));
  const sensitive = isAdmissionDeniedPath(caseFoldForMatch(absolute), effect) ?? isAdmissionDeniedPath(canonicalPath, effect);
  if (sensitive) {
    return {
      kind: "sensitive-path",
      reason: `Sensitive path: command operand ${label} matches ${sensitive}`,
      candidate: label,
      path: absolute,
    };
  }
  if (effect === "read" && isConfiguredSessionReadPath(canonicalPath)) return null;
  if (effect === "read" && isHostScriptReadPath(absolute)) return null;
  if (!pathEffectIsConfined(effect, blockReadsOutsideWorkingDirectories)) return null;
  const check = validateSandboxPath(absolute, sandboxRoot, [...extraAllowedDirectories]);
  if (!check.allowed) {
    return {
      kind: "sandbox-boundary",
      reason: `Sandbox: ${check.reason}`,
      candidate: label,
      path: absolute,
    };
  }
  return null;
}

// Recursive refusal must offer an equivalent scoped alternative or name missing capability without silently narrowing the request.
const SHELL_TRAVERSAL_GUIDANCE: Readonly<Record<string, {
  kind: "builtin" | "conditional" | "unavailable";
  messageKey: string;
}>> = {
  find: { kind: "builtin", messageKey: "be_shellPathPolicy.altFind" },
  fd: { kind: "builtin", messageKey: "be_shellPathPolicy.altFd" },
  fdfind: { kind: "builtin", messageKey: "be_shellPathPolicy.altFdfind" },
  rg: { kind: "builtin", messageKey: "be_shellPathPolicy.altRg" },
  tree: { kind: "builtin", messageKey: "be_shellPathPolicy.altTree" },
  tar: { kind: "conditional", messageKey: "be_shellPathPolicy.altTar" },
  unzip: { kind: "unavailable", messageKey: "be_shellPathPolicy.altUnzip" },
  zip: { kind: "unavailable", messageKey: "be_shellPathPolicy.altZip" },
  grep: { kind: "builtin", messageKey: "be_shellPathPolicy.altGrep" },
  egrep: { kind: "builtin", messageKey: "be_shellPathPolicy.altEgrep" },
  fgrep: { kind: "builtin", messageKey: "be_shellPathPolicy.altFgrep" },
  cp: { kind: "builtin", messageKey: "be_shellPathPolicy.altCp" },
  mv: { kind: "unavailable", messageKey: "be_shellPathPolicy.altMv" },
};

// Only exact interface roles can exempt data; unknown positionals stay file operands, including leading @ or embedded =.
interface NonPathOperandSpec {
  /** Execution uses a command language this analysis cannot inspect safely. */
  unsupportedExecution?: true;
  /** Options whose value — next token, or `--opt=value` — is code/pattern/format. */
  valueOptions?: ReadonlySet<string>;
  // Consume path-valued options without exemption so their values cannot displace the program slot and hide a file.
  pathValueOptions?: ReadonlySet<string>;
  /** Possible value-option abbreviations consume their operand without exempting it. */
  abbreviatedValueOptions?: true;
  /** Forwarding options; possible abbreviations conservatively end option roles. */
  forwardingOptions?: ReadonlySet<string>;
  /** Cluster form of a code-carrying option, e.g. perl's `-ne` / `-lpe`. */
  clusteredCodeOption?: RegExp;
  /** True when the first non-option operand is the program/pattern. */
  firstPositionalIsProgram?: true;
  /** Options that supply the program elsewhere, freeing the first positional to be a path again. */
  programSuppliedBy?: ReadonlySet<string>;
  // Re-enter shell-command option values through full policy rather than exempting executable payloads.
  nestedCommandOptions?: ReadonlySet<string>;
}

// Keep code options interpreter-specific; identical letters can mean boolean flags or config files elsewhere.
const SHELL_CODE_OPTIONS = new Set(["-c"]);
const PYTHON_CODE_OPTIONS = new Set(["-c"]);
const NODE_CODE_OPTIONS = new Set(["-e", "--eval", "-p", "--print"]);
const DENO_CODE_OPTIONS = new Set(["-e", "--eval"]);
/** php: `-r` runs code, `-B`/`-R`/`-E` are begin/each-line/end code. `-F` takes a FILE. */
const PHP_CODE_OPTIONS = new Set(["-r", "-B", "-R", "-E"]);
const EXPRESSION_CODE_OPTIONS = new Set(["-e", "--eval"]);
/** perl/ruby: `-e` and perl's feature-enabled `-E`. */
const PERL_CODE_OPTIONS = new Set(["-e", "-E"]);
/** perl/ruby cluster options ending in `e` take the program as the next word (`-ne`, `-lpe`). */
const PERL_CLUSTERED_CODE_OPTION = /^-[A-Za-z]*[eE]$/;
const OPENSSL_PASSPHRASE_OPTIONS = new Set(["-passin", "-passout", "-pass"]);
const DEBUGGER_CODE_OPTIONS = new Set([
  "-ex", "-eval-command", "--eval-command",
  "-iex", "-init-eval-command", "--init-eval-command",
  "-eiex", "-early-init-eval-command", "--early-init-eval-command",
]);
const DEBUGGER_PATH_OPTIONS = new Set([
  "-x", "-command", "--command",
  "-ix", "-init-command", "--init-command",
  "-eix", "-early-init-command", "--early-init-command",
  "-e", "-exec", "--exec", "-s", "-symbols", "--symbols", "-se", "--se",
  "-c", "-core", "--core", "-d", "-directory", "--directory",
  "-cd", "--cd", "-data-directory", "--data-directory",
  "-t", "-tty", "--tty",
]);

const NON_PATH_OPERAND_SPECS: ReadonlyMap<string, NonPathOperandSpec> = new Map<string, NonPathOperandSpec>([
  ...(["pwsh", "powershell", "cmd"] as const).map((verb) => [verb, {
    unsupportedExecution: true,
  }] as [string, NonPathOperandSpec]),
  ["ssh-keygen", { pathValueOptions: new Set(["-f"]) }],
  ["patch", { pathValueOptions: new Set(["-o", "--output"]) }],
  ["gzip", { pathValueOptions: new Set(["-S", "--suffix"]) }],
  ["gdb", {
    valueOptions: DEBUGGER_CODE_OPTIONS,
    pathValueOptions: DEBUGGER_PATH_OPTIONS,
    abbreviatedValueOptions: true,
    forwardingOptions: new Set(["--args", "--no-escape-args"]),
  }],
  // Re-enter shell -c values as command lines, not opaque code.
  ...(["sh", "bash", "zsh", "dash", "ksh"] as const).map((verb) => [verb, {
    valueOptions: SHELL_CODE_OPTIONS,
    nestedCommandOptions: SHELL_CODE_OPTIONS,
  }] as [string, NonPathOperandSpec]),
  ...(["python", "python2", "python3"] as const).map((verb) => [verb, {
    valueOptions: PYTHON_CODE_OPTIONS,
  }] as [string, NonPathOperandSpec]),
  ["node", { valueOptions: NODE_CODE_OPTIONS, }],
  ...(["deno", "bun"] as const).map((verb) => [verb, {
    valueOptions: DENO_CODE_OPTIONS,
  }] as [string, NonPathOperandSpec]),
  ["php", { valueOptions: PHP_CODE_OPTIONS, }],
  ...(["rscript", "r", "lua", "osascript"] as const).map((verb) => [verb, {
    valueOptions: EXPRESSION_CODE_OPTIONS,
  }] as [string, NonPathOperandSpec]),
  ...(["perl", "ruby"] as const).map((verb) => [verb, {
    valueOptions: PERL_CODE_OPTIONS,
    clusteredCodeOption: PERL_CLUSTERED_CODE_OPTION,
  }] as [string, NonPathOperandSpec]),
  // awk's first positional is code unless -f supplies a checked file; field separators are data.
  // Keep -v assignments checked because variables can name files opened by the program.
  ...(["awk", "gawk", "mawk", "nawk"] as const).map((verb) => [verb, {
    valueOptions: new Set(["-F", "--field-separator", "--source"]),
    pathValueOptions: new Set(["-v", "--assign", "-f", "--file"]),
    firstPositionalIsProgram: true,
    programSuppliedBy: new Set(["-f", "--file", "--source"]),
  }] as [string, NonPathOperandSpec]),
  ["sed", {
    valueOptions: new Set(["-e", "--expression"]),
    pathValueOptions: new Set(["-f", "--file"]),
    firstPositionalIsProgram: true,
    programSuppliedBy: new Set(["-e", "--expression", "-f", "--file"]),
  }],
  // grep's first positional is a pattern; include/exclude globs filter traversal rather than open operands.
  ...(["rg", "ag", "ack"] as const).map((verb) => [verb, {
    valueOptions: new Set([
      "-e", "--regexp", "-g", "--glob",
      "--include", "--exclude", "--include-dir", "--exclude-dir",
    ]),
    pathValueOptions: new Set(["-f", "--file"]),
    firstPositionalIsProgram: true,
    programSuppliedBy: new Set(["-e", "--regexp", "-f", "--file"]),
  }] as [string, NonPathOperandSpec]),
  ["sort", {
    valueOptions: new Set(["-k", "--key", "-t", "--field-separator", "-S", "--buffer-size"]),
    pathValueOptions: new Set(["-o", "--output", "-T", "--temporary-directory", "--files0-from"]),
  }],
  ...(["cp", "mv", "install", "ln"] as const).map((verb) => [verb, {
    valueOptions: new Set([
      "-S", "--suffix",
      ...(verb === "install" ? ["-m", "--mode", "-o", "--owner", "-g", "--group"] : []),
    ]),
    pathValueOptions: new Set(["-t", "--target-directory"]),
  }] as [string, NonPathOperandSpec]),
  ["tee", {}],
  ["shuf", { pathValueOptions: new Set(["-o", "--output"]) }],
  ["make", { pathValueOptions: new Set(["-C", "--directory", "-f", "--file"]) }],
  ["tar", {
    valueOptions: new Set(["-b", "--blocking-factor", "-H", "--format"]),
    pathValueOptions: new Set(["-f", "--file", "-C", "--directory", "-T", "--files-from", "-X", "--exclude-from"]),
  }],
  // Passphrase option values are data except their documented file: source.
  ["openssl", { valueOptions: new Set(["-subj", ...OPENSSL_PASSPHRASE_OPTIONS]) }],
  // Data-only builtin arguments do not exempt executed substitutions or downstream consumers.
  ["printf", { firstPositionalIsProgram: true, }],
  // Format escapes can look like Windows paths but remain data.
  ["stat", { valueOptions: new Set(["-c", "--format", "--printf"]) }],
  ["dpkg-query", { valueOptions: new Set(["-f", "--showformat"]) }],
  ...(["identify", "convert", "magick"] as const).map((verb) => [verb, {
    valueOptions: new Set(["-format"]),
  }] as [string, NonPathOperandSpec]),
]);

interface ShellPathCandidate {
  value: string;
  index: number;
  effect?: PathEffect;
  refuseAfterCheck?: boolean;
}

interface OperandSlotClassification {
  nonPathIndices: ReadonlySet<number>;
  /** Program roles that require exact expansion even when they contain no literal file effect. */
  programIndices?: ReadonlySet<number>;
  /** Fixed child command boundary owned by an execution wrapper. */
  childCommandIndex?: number;
  /** Proven option position disables automatic transfer configuration. */
  defaultConfigDisabled?: boolean;
  // Recover file spans inside sed program operands; ordinary argv scanning cannot see them.
  extraCandidates: readonly ShellPathCandidate[];
  // Re-enter sed e COMMAND payloads through the full shell policy.
  nestedCommands: readonly { value: string; index: number }[];
  // Refuse operands that execute text unavailable to static inspection.
  dynamicExecution: string | null;
}

const COMPILER_COMMANDS = new Set(["cc", "c++", "gcc", "g++", "clang", "clang++"]);

const GIT_COMMIT_MESSAGE_OPTIONS = new Set(["-m", "--message"]);
const GIT_COMMIT_FILE_OPTIONS = new Set(["-F", "--file", "-t", "--template", "--pathspec-from-file"]);
const GIT_COMMIT_VALUE_OPTIONS = new Set([
  ...GIT_COMMIT_MESSAGE_OPTIONS, ...GIT_COMMIT_FILE_OPTIONS,
  "-C", "--reuse-message", "-c", "--reedit-message", "--author", "--date",
  "--cleanup", "--fixup", "--squash", "--trailer",
]);
const GIT_COMMIT_SWITCHES = new Set([
  "-a", "--all", "-p", "--patch", "--interactive", "-s", "--signoff",
  "-v", "--verbose", "-q", "--quiet", "-n", "--no-verify", "--amend",
  "-e", "--edit", "--no-edit", "--reset-author", "--allow-empty",
  "--allow-empty-message", "--dry-run", "-i", "--include", "-o", "--only",
  "--pathspec-file-nul",
]);

/** Only proven commit message values are text; other commands keep their roles. */
function classifyGitCommitOperandSlots(argv: readonly string[]): OperandSlotClassification {
  const unclassified: OperandSlotClassification = {
    nonPathIndices: new Set(), extraCandidates: [], nestedCommands: [], dynamicExecution: null,
  };
  const nonPathIndices = new Set<number>();
  const extraCandidates: { value: string; index: number }[] = [];
  let i = 1;
  // Recognize only this global option's arity. Its directory remains a path.
  while (argv[i]?.startsWith("-C")) {
    const token = argv[i]!;
    nonPathIndices.add(i);
    const value = token === "-C" ? argv[++i] : token.slice(2);
    if (value === undefined) return unclassified;
    nonPathIndices.add(i);
    extraCandidates.push({ value, index: i });
    i += 1;
  }
  if (argv[i] !== "commit") return unclassified;
  for (i += 1; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (token === "--") break;
    if (!token.startsWith("-") || token === "-") continue;
    const long = token.startsWith("--");
    const equals = token.indexOf("=");
    const options = long
      ? [equals < 0 ? token : token.slice(0, equals)]
      : token.slice(1).split("").map((flag) => `-${flag}`);
    for (let j = 0; j < options.length; j += 1) {
      const option = options[j]!;
      if (!GIT_COMMIT_VALUE_OPTIONS.has(option)) {
        // Unknown arity may consume -- as data; never guess a separator.
        if (!GIT_COMMIT_SWITCHES.has(option) || (long && equals >= 0)) {
          return { ...unclassified, dynamicExecution: "unsupported git commit option arity" };
        }
        continue;
      }
      const attached = long ? equals >= 0 : j + 2 < token.length;
      const value = attached ? token.slice(long ? equals + 1 : j + 2) : argv[i + 1];
      if (value === undefined) return unclassified;
      const message = GIT_COMMIT_MESSAGE_OPTIONS.has(option);
      const file = GIT_COMMIT_FILE_OPTIONS.has(option);
      if (message || file) nonPathIndices.add(i);
      if (!attached) i += 1;
      if (message || file) nonPathIndices.add(i);
      if (file) extraCandidates.push({ value, index: i });
      // A value consumes the rest of a short cluster, including any 'm'.
      break;
    }
  }
  return { nonPathIndices, extraCandidates, nestedCommands: [], dynamicExecution: null };
}

// Named options precede any shorter option prefix that could claim their value.
const COMPILER_PATH_OPTIONS = [
  "-include-pch", "-idirafter", "-isysroot", "-isystem", "-iquote", "-include", "-imacros",
  "-MF", "-I", "-L", "-B", "-o",
];

function classifyCompilerOperandSlots(argv: readonly string[], verbIndex: number): OperandSlotClassification {
  const nonPathIndices = new Set<number>();
  const extraCandidates: { value: string; index: number }[] = [];
  for (let i = verbIndex + 1; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (token === "--") break;
    const option = COMPILER_PATH_OPTIONS.find((prefix) => token.startsWith(prefix));
    if (!option) continue;
    const value = token === option ? argv[++i] : token.slice(option.length);
    // Sysroot-relative values require interpretation; retain conservative scanning instead of treating = as directory data.
    if (!value || value.startsWith("=")) continue;
    nonPathIndices.add(i);
    extraCandidates.push({ value, index: i });
  }
  return { nonPathIndices, extraCandidates, nestedCommands: [], dynamicExecution: null };
}

const GREP_LITERAL_OPTIONS = new Set([
  "-e", "--regexp", "-A", "--after-context", "-B", "--before-context",
  "-C", "--context", "-m", "--max-count", "-d", "--directories",
  "-D", "--devices", "--binary-files", "--label", "--include", "--exclude",
  "--exclude-dir", "--group-separator",
]);
const GREP_FILE_OPTIONS = new Set(["-f", "--file", "--exclude-from"]);
const GREP_SWITCHES = new Set([
  ..."abcEFGHIhiLlnoPqRrsUuVvwxyZz".split("").map((flag) => `-${flag}`),
  "--basic-regexp", "--extended-regexp", "--fixed-strings", "--perl-regexp",
  "--ignore-case", "--no-ignore-case", "--invert-match", "--word-regexp",
  "--line-regexp", "--count", "--files-without-match", "--files-with-matches",
  "--only-matching", "--quiet", "--silent", "--no-messages", "--byte-offset",
  "--with-filename", "--no-filename", "--line-number", "--initial-tab",
  "--null", "--recursive", "--dereference-recursive", "--text", "--binary",
  "--unix-byte-offsets", "--null-data", "--no-group-separator", "--help", "--version",
]);

const PROCESS_PATTERN_FILE_OPTIONS = new Set(["-F", "--pidfile"]);
const PROCESS_PATTERN_LITERAL_OPTIONS = new Set([
  "-d", "--delimiter", "-g", "--pgroup", "-G", "--group", "-O", "--older",
  "-p", "--pid", "-P", "--parent", "-s", "--session", "--signal", "-t", "--terminal",
  "-u", "--euid", "-U", "--uid", "-r", "--runstates", "--cgroup", "--ns", "--nslist", "--env",
]);
const PROCESS_PATTERN_SWITCHES = new Set([
  "-a", "--list-full", "-l", "--list-name", "--quiet", "-v", "--inverse",
  "-w", "--lightweight", "-c", "--count", "-f", "--full", "-i", "--ignore-case",
  "-n", "--newest", "-o", "--oldest", "-x", "--exact", "-L", "--logpidfile",
  "-A", "--ignore-ancestors", "-Q", "--shell-quote", "-h", "--help", "-V", "--version",
]);

/** Process selection patterns are text; pidfile options still open files. */
function classifyProcessPatternOperandSlots(argv: readonly string[], verbIndex: number): OperandSlotClassification {
  const nonPathIndices = new Set<number>();
  const extraCandidates: { value: string; index: number }[] = [];
  const positionals: number[] = [];
  const unclassified: OperandSlotClassification = {
    nonPathIndices: new Set(), extraCandidates: [], nestedCommands: [], dynamicExecution: null,
  };
  let optionsEnded = false;
  for (let i = verbIndex + 1; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (!optionsEnded && token === "--") {
      optionsEnded = true;
      continue;
    }
    if (optionsEnded || !token.startsWith("-") || token === "-") {
      positionals.push(i);
      continue;
    }
    const long = token.startsWith("--");
    const equals = token.indexOf("=");
    const options = long
      ? [equals < 0 ? token : token.slice(0, equals)]
      : token.slice(1).split("").map((flag) => `-${flag}`);
    for (let j = 0; j < options.length; j += 1) {
      const option = options[j]!;
      const fileValue = PROCESS_PATTERN_FILE_OPTIONS.has(option);
      if (!fileValue && !PROCESS_PATTERN_LITERAL_OPTIONS.has(option)) {
        if (!PROCESS_PATTERN_SWITCHES.has(option) || (long && equals >= 0)) return unclassified;
        continue;
      }
      const attached = long ? equals >= 0 : j + 2 < token.length;
      const value = attached ? token.slice(long ? equals + 1 : j + 2) : argv[i + 1];
      if (value === undefined) return unclassified;
      nonPathIndices.add(i);
      if (!attached) nonPathIndices.add(++i);
      if (fileValue) extraCandidates.push({ value, index: i });
      break;
    }
  }
  // Unknown options or extra positionals prevent proving the pattern slot; grant no text exemption.
  if (positionals.length > 1) return unclassified;
  if (positionals[0] !== undefined) nonPathIndices.add(positionals[0]);
  return { nonPathIndices, extraCandidates, nestedCommands: [], dynamicExecution: null };
}

/** Pattern text never opens a file; -f and later positionals do. */
function classifyGrepOperandSlots(argv: readonly string[], verbIndex: number): OperandSlotClassification {
  const nonPathIndices = new Set<number>();
  const extraCandidates: { value: string; index: number }[] = [];
  const positionals: number[] = [];
  const unclassified: OperandSlotClassification = {
    nonPathIndices: new Set(), extraCandidates: [], nestedCommands: [], dynamicExecution: null,
  };
  let suppliedPattern = false;
  let optionsEnded = false;
  for (let i = verbIndex + 1; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (!optionsEnded && token === "--") {
      optionsEnded = true;
      continue;
    }
    if (optionsEnded || !token.startsWith("-") || token === "-") {
      positionals.push(i);
      continue;
    }
    if (/^-\d+$/.test(token)) continue;
    const long = token.startsWith("--");
    const equals = token.indexOf("=");
    const options = long
      ? [equals < 0 ? token : token.slice(0, equals)]
      : token.slice(1).split("").map((flag) => `-${flag}`);
    for (let j = 0; j < options.length; j += 1) {
      const option = options[j]!;
      if (option === "--color" || option === "--colour") {
        nonPathIndices.add(i);
        continue;
      }
      const fileValue = GREP_FILE_OPTIONS.has(option);
      if (!fileValue && !GREP_LITERAL_OPTIONS.has(option)) {
        // Unknown options may consume a following word. Do not guess its role.
        if (!GREP_SWITCHES.has(option) || (long && equals >= 0)) return unclassified;
        continue;
      }
      const attached = long ? equals >= 0 : j + 2 < token.length;
      const value = attached ? token.slice(long ? equals + 1 : j + 2) : argv[i + 1];
      if (value === undefined) return unclassified;
      nonPathIndices.add(i);
      if (!attached) nonPathIndices.add(++i);
      if (fileValue) extraCandidates.push({ value, index: i });
      if (["-e", "--regexp", "-f", "--file"].includes(option)) suppliedPattern = true;
      // A short option's attached remainder is its value, never more flags.
      break;
    }
  }
  if (!suppliedPattern && positionals[0] !== undefined) nonPathIndices.add(positionals[0]);
  return { nonPathIndices, extraCandidates, nestedCommands: [], dynamicExecution: null };
}

type FindOperandRole = "literal" | "path";

// Consume find predicate values before primaries so primary-like data cannot alter roles; unknown syntax stays checked.
const FIND_PRIMARY_OPERANDS: ReadonlyMap<string, readonly FindOperandRole[]> = new Map([
  ...[
    "-name", "-iname", "-path", "-ipath", "-wholename", "-iwholename",
    "-lname", "-ilname", "-regex", "-iregex", "-printf", "-context",
    "-amin", "-atime", "-cmin", "-ctime", "-mmin", "-mtime", "-used",
    "-inum", "-links", "-size", "-uid", "-gid", "-user", "-group",
    "-perm", "-type", "-xtype", "-fstype", "-maxdepth", "-mindepth", "-regextype",
  ].map((primary): [string, readonly FindOperandRole[]] => [primary, ["literal"]]),
  ...[
    "-newer", "-anewer", "-cnewer", "-samefile", "-fprint", "-fprint0",
    "-fls", "-files0-from",
  ].map((primary): [string, readonly FindOperandRole[]] => [primary, ["path"]]),
  ["-fprintf", ["path", "literal"]],
  ...[
    "-true", "-false", "-empty", "-readable", "-writable", "-executable",
    "-nouser", "-nogroup", "-print", "-print0", "-ls", "-quit", "-prune",
    "-delete", "-depth", "-daystart", "-follow", "-mount", "-xdev", "-noleaf",
    "-ignore_readdir_race", "-noignore_readdir_race", "-warn", "-nowarn",
    "!", "-not", "-a", "-and", "-o", "-or", ",",
  ].map((primary): [string, readonly FindOperandRole[]] => [primary, []]),
]);

function classifyFindOperandSlots(argv: readonly string[], verbIndex: number): OperandSlotClassification {
  const nonPathIndices = new Set<number>();
  const unclassified: OperandSlotClassification = {
    nonPathIndices: new Set(), extraCandidates: [], nestedCommands: [], dynamicExecution: null,
  };
  let i = verbIndex + 1;
  // Global find options do not consume roots; debugging categories consume a separate literal.
  while (i < argv.length) {
    const token = argv[i]!;
    if (["-H", "-L", "-P", "--"].includes(token) || /^-O[0-3]$/.test(token)) { i += 1; continue; }
    if (token !== "-D") break;
    if (argv[i + 1] === undefined) return unclassified;
    nonPathIndices.add(i + 1);
    i += 2;
  }
  // Starting points end at the first primary/operator; every root remains a path.
  while (i < argv.length && !argv[i]!.startsWith("-")
    && !["!", "(", "\\(", ")", "\\)", ","].includes(argv[i]!)) i += 1;
  let groups = 0;
  for (; i < argv.length; i += 1) {
    const primary = argv[i]!;
    if (primary === "(" || primary === "\\(") { groups += 1; continue; }
    if (primary === ")" || primary === "\\)") {
      if (--groups < 0) return unclassified;
      continue;
    }
    // -newerXY uses a reference file unless Y=t selects a timestamp.
    const roles = /^-newer[acmB][acmBt]$/.test(primary)
      ? [primary.endsWith("t") ? "literal" : "path"] as const
      : FIND_PRIMARY_OPERANDS.get(primary);
    // -exec, -execdir, and -ok carry variable child argv; never reinterpret them as find primaries.
    if (roles === undefined || i + roles.length >= argv.length) return unclassified;
    for (const role of roles) {
      i += 1;
      if (role === "literal") nonPathIndices.add(i);
    }
  }
  if (groups !== 0) return unclassified;
  return { nonPathIndices, extraCandidates: [], nestedCommands: [], dynamicExecution: null };
}

// Accept only proven uv run [--] child boundaries; unmodelled options fail closed instead of granting guessed roles.
function classifyUvRunOperandSlots(argv: readonly string[]): OperandSlotClassification | null {
  if (argv[1] !== "run") return null;

  const nonPathIndices = new Set<number>([1]);
  const extraCandidates: { value: string; index: number }[] = [];
  const nestedCommands: { value: string; index: number }[] = [];
  let childIndex = 2;
  if (argv[childIndex] === "--") {
    nonPathIndices.add(childIndex);
    childIndex += 1;
  } else if (argv[childIndex]?.startsWith("-")) {
    return {
      nonPathIndices,
      extraCandidates,
      nestedCommands,
      dynamicExecution: "unsupported uv run option before child command",
    };
  }

  const childHead = argv[childIndex];
  if (childHead === undefined || childHead.length === 0 || childHead.startsWith("-")) {
    return {
      nonPathIndices,
      extraCandidates,
      nestedCommands,
      dynamicExecution: "missing or unsupported uv run child command",
      programIndices: new Set([childIndex]),
    };
  }

  const childArgv = argv.slice(childIndex);
  const childVerb = transferCommandVerb(childHead) ?? stripCommandPath(childHead).toLowerCase();
  const childSlots = classifyOperandSlots(childArgv);
  const programIndices = new Set<number>([childIndex]);

  // Bare executables use PATH; explicit executable paths remain checked.
  nonPathIndices.add(childIndex);
  if (namesCommandPath(childHead)) extraCandidates.push({ value: childHead, index: childIndex });

  for (const index of childSlots.nonPathIndices) nonPathIndices.add(childIndex + index);
  for (const index of childSlots.programIndices ?? []) programIndices.add(childIndex + index);
  extraCandidates.push(...childSlots.extraCandidates.map((candidate) => ({
    ...candidate,
    index: childIndex + candidate.index,
  })));

  // Apply child-verb roles before exempting outer wrapper operands so direct and wrapped file authority stays identical.
  let optionsEnded = false;
  for (let index = 1; index < childArgv.length; index += 1) {
    const absoluteIndex = childIndex + index;
    const argument = childArgv[index]!;
    if (childSlots.nonPathIndices.has(index)) continue;
    if (!optionsEnded && argument === "--") {
      optionsEnded = true;
      nonPathIndices.add(absoluteIndex);
      continue;
    }
    nonPathIndices.add(absoluteIndex);
    extraCandidates.push(...operandPaths(argument, !optionsEnded, childVerb)
      .map((value) => ({ value, index: absoluteIndex })));
  }

  return {
    nonPathIndices,
    programIndices,
    childCommandIndex: childIndex,
    extraCandidates,
    nestedCommands,
    dynamicExecution: childSlots.dynamicExecution,
  };
}

function transferCommandVerb(head: string): "curl" | "wget" | null {
  const leaf = stripCommandPath(head).toLowerCase();
  const verb = process.platform === "win32" ? leaf.replace(/\.exe$/, "") : leaf;
  return verb === "curl" || verb === "wget" ? verb : null;
}

function ambiguousTransferPath(): never {
  throw new PathPolicyError({
    kind: "invalid-path",
    reason: "Shell path policy: ambiguous structured option path is not supported",
  });
}

/** Split form delimiters without splitting quoted filenames or display names. */
function splitFormValue(value: string, delimiter: string): string[] {
  const parts: string[] = [];
  let quoted = false;
  let start = 0;
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    if (quoted && char === "\\" && /["\\]/.test(value[i + 1] ?? "")) {
      i += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (!quoted && char === delimiter) {
      parts.push(value.slice(start, i));
      start = i + 1;
    }
  }
  if (quoted) ambiguousTransferPath();
  parts.push(value.slice(start));
  return parts;
}

function decodeFormValue(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.includes('"')) return trimmed;
  if (!/^"(?:[^"\\]|\\.)*"$/.test(trimmed)) ambiguousTransferPath();
  return trimmed.slice(1, -1).replace(/\\(["\\])/g, "$1");
}

/** Percent escapes are consumed left to right; escaped percent signs are data. */
function writeOutPaths(value: string): string[] {
  const paths: string[] = [];
  for (let i = 0; i < value.length; i += 1) {
    if (value[i] !== "%") continue;
    if (value[i + 1] === "%") {
      i += 1;
      continue;
    }
    const output = value.startsWith("%output", i);
    if (!output && value[i + 1] !== "{") continue;
    const open = i + (output ? 7 : 1);
    if (value[open] !== "{") ambiguousTransferPath();
    const close = value.indexOf("}", open + 1);
    if (close < 0) ambiguousTransferPath();
    const body = value.slice(open + 1, close);
    if (!body || body.includes("{")) ambiguousTransferPath();
    if (output) {
      const path = body.startsWith(">>") ? body.slice(2) : body;
      if (!path) ambiguousTransferPath();
      paths.push(path);
    }
    i = close;
  }
  return paths;
}

function readWgetrcCommand(value: string): { name: string; value: string } {
  const match = /^\s*([a-z0-9_-]+)\s*=\s*(.*?)\s*$/i.exec(value);
  if (!match) ambiguousTransferPath();
  return { name: match[1]!.replace(/[-_]/g, "").toLowerCase(), value: match[2]! };
}

/** Return only actual local references, never a display filename or payload. */
function transferStructuredPaths(verb: string, option: string, value: string): string[] {
  if (/[\0\r\n]/.test(value)) ambiguousTransferPath();
  const file = (path: string): string[] => {
    if (path.length === 0) ambiguousTransferPath();
    return path === "-" ? [] : [path];
  };
  if (verb === "wget" && (option === "-e" || option === "--execute")) {
    const command = readWgetrcCommand(value);
    const name = command.name;
    const normalize = (command: string): string => command.replaceAll("_", "");
    if (WGETRC_COMMAND_TABLE.path.some(command => normalize(command) === name)) return file(command.value);
    if (WGETRC_COMMAND_TABLE.data.some(command => normalize(command) === name)) return [];
    if (WGETRC_COMMAND_TABLE.structured.some(command => normalize(command) === name)) {
      return transferStructuredPaths(verb, "--pinnedpubkey", command.value);
    }
    return ambiguousTransferPath();
  }
  if (["--pinnedpubkey", "--proxy-pinnedpubkey"].includes(option)) {
    return value.startsWith("sha256//") ? [] : file(value);
  }
  if (option === "--url") return value.startsWith("@") ? file(value.slice(1)) : operandPaths(value, false, verb);
  if (["-w", "--write-out"].includes(option)) return writeOutPaths(value);
  if (["-F", "--form"].includes(option)) {
    const equals = value.indexOf("=");
    if (equals < 0) ambiguousTransferPath();
    const parts = splitFormValue(value.slice(equals + 1), ";");
    const content = parts[0]!;
    // Nested multipart grammars are unsupported until their file roles are known.
    if (/^[()]/.test(content)) ambiguousTransferPath();
    const paths: string[] = [];
    const fileContent = /^[<@]/.test(content);
    if (fileContent) {
      const files = content.startsWith("@") ? splitFormValue(content.slice(1), ",") : [content.slice(1)];
      for (const path of files) paths.push(...file(decodeFormValue(path)));
    }
    for (const attribute of parts.slice(1)) {
      // A comma after upload attributes may start another file; refuse unsupported multipart grammar.
      if (fileContent && splitFormValue(attribute, ",").length !== 1) ambiguousTransferPath();
      const match = /^(type|filename|headers|encoder)=(.*)$/.exec(attribute.trim());
      if (!match) ambiguousTransferPath();
      const attributeValue = decodeFormValue(match[2]!);
      if (match[1] === "headers" && attributeValue.startsWith("@")) paths.push(...file(attributeValue.slice(1)));
    }
    return paths;
  }
  if (["-b", "--cookie"].includes(option)) return value === "" || value.includes("=") ? [] : file(value);
  if (["-E", "--cert", "--proxy-cert"].includes(option)) {
    let path = "";
    for (let i = 0; i < value.length; i += 1) {
      const char = value[i]!;
      if (char === "\\" && /[:"\\]/.test(value[i + 1] ?? "")) {
        path += value[++i]!;
      } else if (char === ":" && !(i === 1 && /^[a-z]:/i.test(value))) {
        break;
      } else {
        path += char;
      }
    }
    return file(path);
  }
  if (["-z", "--time-cond"].includes(option)) return file(value.replace(/^-/, ""));
  if (option === "--variable") {
    // These grammars can resolve files or environment values at runtime.
    return ambiguousTransferPath();
  }
  if (option === "--url-query" && value.startsWith("+")) return [];
  if (["--data-urlencode", "--url-query"].includes(option)) {
    const at = value.indexOf("@");
    const equals = value.indexOf("=");
    return at >= 0 && (equals < 0 || at < equals) ? file(value.slice(at + 1)) : [];
  }
  if (["-d", "--data", "--data-ascii", "--data-binary", "--json", "-H", "--header", "--proxy-header"].includes(option)) {
    return value.startsWith("@") ? file(value.slice(1)) : [];
  }
  return ambiguousTransferPath();
}

function classifyTransferOperandSlots(argv: readonly string[], verb: string, table: ShellOptionTable): OperandSlotClassification {
  const nonPathIndices = new Set<number>();
  const programIndices = new Set<number>();
  const extraCandidates: ShellPathCandidate[] = [];
  let optionsEnded = false;
  let defaultConfigDisabled = verb === "curl" && (argv[1] === "-q" || argv[1] === "--disable");
  type OptionRole = keyof ShellOptionTable;
  const roles = new Map<string, OptionRole>();
  for (const role of ["flag", "data", "optionalData", "path", "config", "structured"] as const) {
    for (const option of table[role]) {
      roles.set(option, role);
      if (role === "flag" && option.startsWith("--")) {
        roles.set(option.startsWith("--no-") ? `--${option.slice(5)}` : `--no-${option.slice(2)}`, role);
      }
    }
  }
  for (let i = 1; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (!optionsEnded && token === "--") {
      optionsEnded = true;
      continue;
    }
    if (optionsEnded || !token.startsWith("-") || token === "-") continue;
    const long = token.startsWith("--");
    const equals = long ? token.indexOf("=") : -1;
    const name = equals >= 0 ? token.slice(0, equals) : token;
    // Runtime-expanded option values cannot inherit literal data exemptions.
    if (verb === "curl" && name.startsWith("--expand-")) ambiguousTransferPath();
    let options = long || roles.has(token) ? [name] : [...token.slice(1)].map(letter => `-${letter}`);
    if (long && !roles.has(name) && verb === "wget") {
      // Long abbreviations have the same file authority as the full option.
      const matches = [...roles.keys()].filter(option => option.startsWith(name));
      if (matches.length === 1) options = matches;
      else if (matches.length > 1) ambiguousTransferPath();
    }
    for (let j = 0; j < options.length; j += 1) {
      const option = options[j]!;
      const role = roles.get(option);
      // Advance clusters only for proven flags; unknown arity keeps every possible value suffix path-checked.
      if (role === undefined) break;
      if (role === "flag") {
        if (equals >= 0 && (verb !== "wget" || !/^(on|off|yes|no|0|1)$/i.test(token.slice(equals + 1)))) ambiguousTransferPath();
        if (verb === "wget" && option === "--no-config" && (equals < 0 || /^(on|yes|1)$/i.test(token.slice(equals + 1)))) defaultConfigDisabled = true;
        if (j === options.length - 1) nonPathIndices.add(i);
        continue;
      }
      const attached = long ? (equals >= 0 ? token.slice(equals + 1) : undefined) : token.slice(j + 2) || undefined;
      const valueIndex = attached === undefined ? i + 1 : i;
      const value = attached ?? argv[valueIndex];
      if (role === "optionalData" && attached === undefined && (value === undefined || value.startsWith("-"))) {
        nonPathIndices.add(i);
        break;
      }
      if (value === undefined) ambiguousTransferPath();
      // Process-side upload globbing occurs after shell expansion and cannot provide exact file authority.
      if (verb === "curl" && ["-T", "--upload-file"].includes(option) && /[\[\]{}]/.test(value)) ambiguousTransferPath();
      const writeOut = verb === "curl" && ["-w", "--write-out"].includes(option);
      const fileFormat = writeOut && value.startsWith("@");
      if (fileFormat && (value === "@" || value === "@-" || /[\0\r\n]/.test(value))) ambiguousTransferPath();
      const rcCommand = verb === "wget" && ["-e", "--execute"].includes(option) ? readWgetrcCommand(value) : undefined;
      const config = role === "config" || (rcCommand !== undefined
        && WGETRC_COMMAND_TABLE.config.some(command => command.replaceAll("_", "") === rcCommand.name));
      const configPath = rcCommand?.value ?? value;
      if (config && (configPath === "" || configPath === "-" || /[\0\r\n]/.test(configPath))) ambiguousTransferPath();
      const paths = config ? [configPath] : fileFormat ? [value.slice(1)] : role === "path" ? [value] : role === "structured" ? transferStructuredPaths(verb, option, value) : [];
      nonPathIndices.add(i);
      nonPathIndices.add(valueIndex);
      if (role === "structured") programIndices.add(valueIndex);
      extraCandidates.push(...paths.map(path => ({
        value: path, index: valueIndex,
        ...(config || fileFormat ? { effect: "read" as const, refuseAfterCheck: true } : writeOut ? { effect: "write" as const } : {}),
      })));
      i = valueIndex;
      // The first value option owns the entire suffix, even if it spells flags.
      break;
    }
  }
  return { nonPathIndices, programIndices, extraCandidates, nestedCommands: [], dynamicExecution: null, defaultConfigDisabled };
}

// Classify non-path argv slots and embedded file references; -- ends options.
function classifyOperandSlots(argv: readonly string[]): OperandSlotClassification {
  const skip = new Set<number>();
  const extraCandidates: { value: string; index: number }[] = [];
  const nestedCommands: { value: string; index: number }[] = [];
  const programIndices = new Set<number>();
  let dynamicExecution: string | null = null;
  const empty = { nonPathIndices: skip, programIndices, extraCandidates, nestedCommands, dynamicExecution };
  const verbIndex = 0;
  const head = argv[verbIndex];
  if (head === undefined) return empty;
  const verb = transferCommandVerb(head) ?? stripCommandPath(head).toLowerCase();
  // A short filename alias cannot prove which executable's grammar applies.
  if (process.platform === "win32" && /~[0-9]/.test(verb)) {
    return { ...empty, dynamicExecution: "unresolved short command name" };
  }
  if (verb === "curl") return classifyTransferOperandSlots(argv, verb, CURL_OPTION_TABLE);
  if (verb === "wget") return classifyTransferOperandSlots(argv, verb, WGET_OPTION_TABLE);
  if (verb === "uv") {
    const uvRun = classifyUvRunOperandSlots(argv);
    if (uvRun) return uvRun;
  }
  if (verb === "git") return classifyGitCommitOperandSlots(argv);
  if (verb === "sqlite3") return classifySqliteArgumentSlots(argv);
  if (verb === "find") return classifyFindOperandSlots(argv, verbIndex);
  if (["grep", "egrep", "fgrep"].includes(verb)) return classifyGrepOperandSlots(argv, verbIndex);
  if (verb === "pgrep") return classifyProcessPatternOperandSlots(argv, verbIndex);
  if (verb === "kill") {
    // Signals and PIDs are data; substitutions and redirects retain independent checks.
    for (let i = verbIndex + 1; i < argv.length; i += 1) skip.add(i);
    return empty;
  }
  if (COMPILER_COMMANDS.has(verb)) return classifyCompilerOperandSlots(argv, verbIndex);
  if (verb === "tar") {
    const listing = parseTarListing(argv.slice(verbIndex));
    if (listing) {
      for (let i = verbIndex + 1; i < argv.length; i += 1) skip.add(i);
      extraCandidates.push(...listing.archivePaths.map((value, index) => ({ value, index: listing.archiveArgIndices[index]! })));
      return empty;
    }
  }
  const spec = NON_PATH_OPERAND_SPECS.get(verb);
  if (!spec) return empty;
  if (spec.unsupportedExecution) return { ...empty, dynamicExecution: "nested shell dialect is not supported" };
  const valueOptions = new Set([...spec.valueOptions ?? [], ...spec.pathValueOptions ?? []]);
  const isSed = verb === "sed";

  // A normally data-only slot stays path-checked when its value opens or executes content.
  const exempts = (value: string, index: number, option?: string): boolean => {
    if (verb === "openssl" && option && OPENSSL_PASSPHRASE_OPTIONS.has(option) && value.startsWith("file:")) {
      extraCandidates.push({ value: value.slice(5), index });
      return true;
    }
    // The host sed scanner supplies file and execution spans, including filenames attached directly to command letters.
    // Never split those spans on whitespace: w/tmp/x and w /tmp/x address the same outside file.
    if (isSed) {
      programIndices.add(index);
      const sedAccess = inspectSedScriptFileAccess(value);
      // Re-enter sed e COMMAND just like a shell -c payload.
      nestedCommands.push(...sedAccess.execCommands.map((value) => ({ value, index })));
      if (sedAccess.hasDynamicExec && dynamicExecution === null) {
        dynamicExecution =
          `Dynamic path: \`sed\` script \`${value}\` executes text that only exists while sed runs ` +
          "(`s///e`, or `e` with no command, run the pattern space), so the paths it uses cannot be " +
          "checked beforehand. Put the command in the shell call itself instead.";
      }
      if (sedAccess.hasWriteOrExec) {
        extraCandidates.push(...sedAccess.fileOperands.map((value) => ({ value, index })));
        return true;
      }
    }
    return true;
  };

  let programTaken = spec.firstPositionalIsProgram !== true;
  let optionsEnded = false;
  for (let i = verbIndex + 1; i < argv.length; i += 1) {
    const token = argv[i]!;
    // Forwarding abbreviations cannot grant debugger roles to child arguments; normalize only the option prefix.
    const optionName = token.replace(/^--?/, "--");
    const mayForward = token.startsWith("-") && optionName.length > 2
      && spec.forwardingOptions !== undefined
      && [...spec.forwardingOptions].some((option) => option.startsWith(optionName));
    if (!optionsEnded && (token === "--" || mayForward)) {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && token.startsWith("-") && token.length > 1) {
      // The numeric key-size form is data; other algorithm operands can load files.
      if (verb === "openssl" && token === "-newkey" && /^rsa:\d+$/.test(argv[i + 1] ?? "")) {
        skip.add(++i);
        continue;
      }
      // Value-taking short options own the remaining token; preserve leading - and = as path bytes.
      const carried = readOptionValue(argv, i, valueOptions);
      if (carried) {
        const index = carried.consumedNext ? i + 1 : i;
        if (spec.programSuppliedBy?.has(carried.option)) programTaken = true;
        if (spec.pathValueOptions?.has(carried.option)) {
          skip.add(i);
          skip.add(index);
          const values = ["awk", "gawk", "mawk", "nawk"].includes(verb)
            ? operandPaths(carried.value, false, verb) : [carried.value];
          extraCandidates.push(...values.map(value => ({ value, index })));
        } else {
          if (isSed || spec.nestedCommandOptions?.has(carried.option)) programIndices.add(index);
          if (exempts(carried.value, index, carried.option)) {
            skip.add(i);
            skip.add(index);
          }
        }
        if (carried.consumedNext) i += 1;
        continue;
      }
      const equals = token.indexOf("=");
      const name = equals > 0 ? token.slice(0, equals) : token;
      const carriedPath = spec.valueOptions?.has(name) ? null
        : spec.pathValueOptions && readOptionValue(argv, i, spec.pathValueOptions);
      if (carriedPath) {
        if (spec.programSuppliedBy?.has(carriedPath.option)) programTaken = true;
        const index = carriedPath.consumedNext ? i + 1 : i;
        // A value beginning with '-' is still a path, not another option.
        if (carriedPath.value.startsWith("-")) extraCandidates.push({ value: carriedPath.value, index });
        if (carriedPath.consumedNext) i += 1;
        continue;
      }
      if (spec.programSuppliedBy?.has(name)) programTaken = true;
      const normalizedName = name.replace(/^--?/, "--");
      const mayConsumeValue = spec.abbreviatedValueOptions === true
        && spec.valueOptions?.has(name) !== true
        && [...spec.pathValueOptions ?? [], ...spec.valueOptions ?? []]
          .some((option) => option.replace(/^--?/, "--").startsWith(normalizedName));
      if (spec.pathValueOptions?.has(name) === true || mayConsumeValue) {
        // Consume path-valued options without exempting their values.
        if (equals < 0) i += 1;
        continue;
      }
      const carriesCode = spec.valueOptions?.has(name) === true
        || spec.clusteredCodeOption?.test(token) === true;
      if (!carriesCode) continue;
      if (equals > 0) {
        if (exempts(token.slice(equals + 1), i, name)) skip.add(i);
        continue;
      }
      if (i + 1 < argv.length) {
        if (exempts(argv[i + 1]!, i + 1, name)) skip.add(i + 1);
        i += 1;
      }
      continue;
    }
    if (!programTaken) {
      if (exempts(token, i)) skip.add(i);
      programTaken = true;
    }
  }
  return { nonPathIndices: skip, programIndices, extraCandidates, nestedCommands, dynamicExecution };
}

interface CommandPolicyView {
  argv: readonly (string | undefined)[];
  words: readonly ShellWord[];
  knownArgv: readonly string[];
  slots: OperandSlotClassification;
  offset: number;
  executableHeads: readonly { value: string; word: ShellWord; cwd: string | null }[];
  wrapperPaths: readonly { value: string; word: ShellWord; cwd: string | null }[];
  wrapperCwds: readonly { value: string; word: ShellWord; cwd: string | null }[];
  environment: Readonly<Record<string, string | undefined>>;
  unsetVariables: readonly string[];
  cwd: string | null;
  unsupported?: { reason: string; word?: ShellWord };
}

/** Follow only wrapper boundaries whose complete child position is proven. */
function projectCommandPolicyView(
  event: ShellCommandEvent,
  initialSlots?: OperandSlotClassification,
): CommandPolicyView {
  let projectedArgv = event.argv;
  let projectedWords = event.effective.words;
  let offset = 0;
  const executableHeads: { value: string; word: ShellWord; cwd: string | null }[] = [];
  const wrapperPaths: { value: string; word: ShellWord; cwd: string | null }[] = [];
  const wrapperCwds: { value: string; word: ShellWord; cwd: string | null }[] = [];
  // Crossing a process wrapper preserves only exported variables before applying canonical env changes.
  let environment: Record<string, string | undefined> = { ...event.exportedEnvironment };
  const unsetVariables = new Set(event.unsetVariables);
  let cwd = event.cwd;
  let unsupported: { reason: string; word?: ShellWord } | undefined;
  const captureExecutableHead = (): void => {
    const head = projectedArgv[0];
    const word = projectedWords[0];
    if (head !== undefined && namesCommandPath(head) && word) executableHeads.push({ value: head, word, cwd });
  };
  let knownArgv: readonly string[] = [];
  let slots = initialSlots ?? classifyOperandSlots([]);
  for (;;) {
    const effective = effectiveShellWords(projectedWords);
    for (const path of effective.wrapperPaths) {
      const value = staticShellWord(path);
      if (value === undefined) {
        unsupported = { reason: "unresolved projected wrapper path", word: path };
        break;
      }
      wrapperPaths.push({ value, word: path, cwd });
    }
    if (unsupported) break;
    for (const transition of effective.environmentTransitions) {
      if (transition.kind === "reset") {
        environment = {};
        unsetVariables.clear();
      } else if (transition.kind === "unset") {
        delete environment[transition.name];
        unsetVariables.add(transition.name);
      } else if (transition.kind === "set") {
        const assignment = transition.assignment;
        assertStableShellEnvironmentVariable(assignment.name, assignment.value, "environment");
        environment[assignment.name] = staticShellWord(assignment.value);
        unsetVariables.delete(assignment.name);
      } else {
        const value = staticShellWord(transition.path);
        if (value === undefined) {
          unsupported = { reason: "unresolved projected wrapper working directory", word: transition.path };
          break;
        }
        wrapperCwds.push({ value, word: transition.path, cwd });
        try { cwd = cwd === null ? null : resolveShellFilesystemPath(value, cwd, { dialect: "bash" }); }
        catch (error) {
          if (!(error instanceof Error) || !("code" in error)) throw error;
          unsupported = { reason: "cannot resolve projected wrapper working directory", word: transition.path };
          break;
        }
      }
    }
    if (unsupported) break;
    projectedWords = effective.words;
    projectedArgv = projectedWords.map((word) => staticShellWord(word));
    if (effective.unsupported) {
      unsupported = { reason: effective.unsupported, word: projectedWords[0] };
      break;
    }
    captureExecutableHead();
    knownArgv = projectedArgv.map((argument, index) =>
      argument ?? displayShellWord(projectedWords[index]!));
    slots = offset === 0 && initialSlots ? initialSlots : classifyOperandSlots(knownArgv);
    if (slots.childCommandIndex === undefined) break;
    const childIndex = slots.childCommandIndex;
    offset += childIndex;
    projectedArgv = projectedArgv.slice(childIndex);
    projectedWords = projectedWords.slice(childIndex);
  }
  return {
    argv: projectedArgv, words: projectedWords, knownArgv, slots, offset,
    executableHeads, wrapperPaths, wrapperCwds, environment, unsetVariables: [...unsetVariables], cwd,
    ...(unsupported ? { unsupported } : {}),
  };
}

export interface ProjectedShellCommand {
  argv: readonly (string | undefined)[];
  words: readonly ShellWord[];
  environment: Readonly<Record<string, string | undefined>>;
  unsetVariables: readonly string[];
  cwd: string | null;
}

/** Structural consumers apply command-head rules to the same proven child. */
export function projectFixedChildShellCommand(event: ShellCommandEvent): ProjectedShellCommand {
  const view = projectCommandPolicyView(event);
  return {
    argv: view.argv,
    words: view.words,
    environment: view.environment,
    unsetVariables: view.unsetVariables,
    cwd: view.cwd,
  };
}

function readOptionValue(
  argv: readonly string[],
  index: number,
  options: ReadonlySet<string>,
  otherValueOptions?: ReadonlySet<string>,
): { option: string; value: string; consumedNext: boolean } | null {
  const token = argv[index]!;
  const equals = token.indexOf("=");
  // A short option consumes the entire suffix, including a leading equals sign.
  if (equals > 2 && options.has(token.slice(0, equals))) {
    return { option: token.slice(0, equals), value: token.slice(equals + 1), consumedNext: false };
  }
  const takeNext = (option: string): { option: string; value: string; consumedNext: boolean } | null => {
    const next = argv[index + 1];
    return next === undefined ? null : { option, value: next, consumedNext: true };
  };
  if (options.has(token)) return takeNext(token);
  // Only short options cluster; exclude long options and --.
  if (!token.startsWith("-") || token.startsWith("--")) return null;
  for (let i = 1; i < token.length; i += 1) {
    const option = `-${token[i]!}`;
    // A different value-taking option owns the entire remaining suffix.
    if (otherValueOptions?.has(option)) return null;
    if (!options.has(option)) continue;
    const attached = token.slice(i + 1);
    return attached.length > 0 ? { option, value: attached, consumedNext: false } : takeNext(option);
  }
  return null;
}

function buildRecursiveBlockMessage(
  commandToken: string,
  commandName: string,
  flag?: string,
): string {
  const head = flag
    ? `Sandbox: recursive shell filesystem traversal is not allowed: ${commandToken} ${flag}`
    : `Sandbox: recursive shell filesystem traversal is not allowed: ${commandToken}`;
  const capability = SHELL_TRAVERSAL_GUIDANCE[commandName];
  if (!capability) return `${head} ${t("be_shellPathPolicy.guidanceNoAlt")}`;
  const guidanceKey = capability.kind === "builtin"
    ? "be_shellPathPolicy.guidanceWithAlt"
    : capability.kind === "conditional"
      ? "be_shellPathPolicy.guidanceConditional"
      : "be_shellPathPolicy.guidanceUnavailable";
  return `${head} ${t(guidanceKey, { alt: t(capability.messageKey) })}`;
}

export type { ShellExecutionFacts } from "../shared/shell-execution.js";
class PathPolicyError extends Error {
  constructor(readonly violation: ShellPathPolicyViolation) { super(violation.reason); }
}
function decline(reason: string, word?: ShellWord): never {
  throw new ShellExecutionError(reason, word?.source.raw);
}

// Unknown bytes get data roles only when expansion cannot erase or split the word; state expansion handles known arrays and empty scalars.
function assertProjectedOperandCardinality(
  argv: readonly (string | undefined)[],
  words: readonly ShellWord[],
): void {
  const unknown = argv.findIndex((argument, index) => argument === undefined
    && !shellWordHasSingleField(words[index]!));
  if (unknown >= 0) decline("unresolved command argument count", words[unknown]);
}

// These commands mutate control files without naming those files as operands.
const IMPLICIT_GIT_WRITE_TARGETS: Readonly<Record<string, string>> = Object.freeze({
  config: "config", clone: "config", remote: "config", "update-ref": "refs", "symbolic-ref": "HEAD",
  init: "hooks", add: "index", commit: "HEAD", checkout: "HEAD", switch: "HEAD",
  reset: "HEAD", restore: "index", merge: "HEAD", rebase: "HEAD",
  "cherry-pick": "HEAD", revert: "HEAD", fetch: "refs", pull: "refs", push: "refs",
  branch: "refs/heads", tag: "refs/tags", stash: "refs/stash", "update-index": "index",
  "read-tree": "index", repack: "objects", "pack-refs": "packed-refs", gc: "objects",
  prune: "objects", worktree: "worktrees", submodule: "config", reflog: "logs",
  notes: "refs/notes", replace: "refs/replace", bisect: "BISECT_LOG",
});
const GIT_CONFIG_READ_OPTIONS = new Set(["--get", "--get-all", "--get-regexp", "--get-urlmatch", "--list", "-l", "--get-color", "--get-colorbool"]);
const GIT_CONFIG_WRITE_OPTIONS = new Set(["--add", "--replace-all", "--unset", "--unset-all", "--rename-section", "--remove-section", "--edit", "-e"]);
const SHELL_OUTPUT_PATH_OPTIONS = new Set(["-o", "--output", "--output-file", "--output-document", "-out", "--out", "-MF", "-MJ", "--dependency-file", "--serialize-diagnostics"]);
const DIRECT_PATH_MUTATORS = new Set(["tee", "mv", "touch", "mkdir", "mkfifo", "mknod", "rm", "rmdir", "unlink", "truncate", "chmod", "chown", "chgrp", "ln", "install"]);
const SHELL_DATA_ONLY_COMMANDS = new Set(["echo", "printf", "tr", "true", "false", ":", "pwd"]);
const NON_OUTPUT_COMMANDS = new Set(["ls", "cat", "head", "tail", "grep", "egrep", "fgrep", "rg", "ag", "ack", "find", "ssh", "git", "test", "["]);

function isUnknownWriteTarget(verb: string, index: number, argv: readonly (string | undefined)[], knownArgv: readonly string[], slots: OperandSlotClassification, word?: ShellWord): boolean {
  let prefix = "";
  for (const part of word?.parts ?? []) {
    if (part.kind !== "literal") break;
    prefix += part.value;
  }
  const raw = prefix || knownArgv[index] || "";
  const previous = argv[index - 1];
  if (SHELL_DATA_ONLY_COMMANDS.has(verb)) return false;
  if (slots.programIndices?.has(index)) return false;
  if (slots.extraCandidates.some((candidate) => candidate.index === index && candidate.effect === "write")) return true;
  if (slots.nonPathIndices.has(index) && !slots.extraCandidates.some((candidate) => candidate.index === index)) return false;
  if (!NON_OUTPUT_COMMANDS.has(verb) && (previous !== undefined && SHELL_OUTPUT_PATH_OPTIONS.has(previous)
    || /^(?:--output(?:-file|-document)?|--out)=/u.test(raw)
    || /^-o[^-]/u.test(raw) || raw === "-o" && argv[index] === undefined)) return true;
  if (["cp", "mv", "install", "ln"].includes(verb) && (previous === "-t" || previous === "--target-directory"
    || raw.startsWith("--target-directory=") || /^-t[^-]/u.test(raw) || raw === "-t" && argv[index] === undefined)) return true;
  if (verb === "dd") return raw.startsWith("of=");
  if (verb === "tar") {
    if (parseTarListing(knownArgv)) return false;
    const creates = knownArgv.some((arg) => ["--create", "--append", "--update", "--concatenate"].includes(arg) || /^-[^-]*[cruA]/u.test(arg));
    if (previous === "-C" || previous === "--directory" || raw.startsWith("--directory=")) return true;
    if (previous === "-f" || previous === "--file" || /^-[^-]*f$/u.test(previous ?? "")) return creates;
    if (raw.startsWith("--file=") || /^-[^-]*f/u.test(raw)) return creates;
    const separator = argv.indexOf("--");
    return separator < 0 || index < separator;
  }
  if (["unzip", "7z", "7za", "7zz"].includes(verb)) {
    const separator = argv.indexOf("--");
    return previous === "-d" || raw.startsWith("-o") || separator < 0 || index < separator;
  }
  if (slots.nonPathIndices.has(index)) return false;
  if (COMPILER_COMMANDS.has(verb)) {
    const separator = argv.indexOf("--");
    return argv[index] === undefined && (separator < 0 || index < separator);
  }
  if (verb === "cp" || verb === "install" || verb === "rsync") {
    const targetDirectory = knownArgv.findIndex((value) => value === "-t" || value === "--target-directory" || value.startsWith("--target-directory=") || /^-[^-]*t/.test(value));
    const separator = argv.indexOf("--");
    const nonOptionSource = prefix.length > 0 && !prefix.startsWith("-") || word?.source.raw.startsWith("~/") === true;
    if (argv[index] === undefined && (separator < 0 || index < separator) && !nonOptionSource) return true;
    return targetDirectory >= 0 ? index === targetDirectory + 1 || index === targetDirectory : index === argv.length - 1;
  }
  if (DIRECT_PATH_MUTATORS.has(verb)) return !raw.startsWith("-");
  return verb === "sed" && knownArgv.some((arg) => arg === "-i" || arg.startsWith("--in-place"));
}

/** Native adapters preserve unknown argument positions and reuse these operand roles. */
export function inspectUnknownNativeWriteArguments(argv: readonly (string | undefined)[], rawWords: readonly string[] = []): string | undefined {
  const head = argv[0];
  if (head === undefined) return undefined;
  const knownArgv = argv.map((value, index) => value ?? rawWords[index] ?? "");
  const verb = transferCommandVerb(head) ?? stripCommandPath(head).replace(/\.exe$/iu, "").toLowerCase();
  knownArgv[0] = verb;
  const slots = classifyOperandSlots(knownArgv);
  for (let index = 1; index < argv.length; index++) {
    if (argv[index] === undefined && isUnknownWriteTarget(verb, index, argv, knownArgv, slots)) {
      return "The native command's write target is unresolved and may be protected.";
    }
  }
  return undefined;
}

/** A native adapter with an unknown cwd must retain relative write targets as unresolved. */
export function inspectUnknownNativeWriteLocation(argv: readonly (string | undefined)[], rawWords: readonly string[] = []): string | undefined {
  const head = argv[0];
  if (head === undefined) return undefined;
  const verb = transferCommandVerb(head) ?? stripCommandPath(head).replace(/\.exe$/iu, "").toLowerCase();
  const knownArgv = argv.map((value, index) => value ?? rawWords[index] ?? "");
  knownArgv[0] = verb;
  const slots = classifyOperandSlots(knownArgv);
  for (let index = 1; index < argv.length; index++) {
    const value = argv[index];
    if (value === undefined || !isUnknownWriteTarget(verb, index, argv, knownArgv, slots)) continue;
    const candidates = slots.extraCandidates.filter((candidate) => candidate.index === index).map((candidate) => candidate.value);
    for (const target of candidates.length > 0 ? candidates : operandPaths(value, true, verb)) {
      if (!isAbsolute(target) && !/^(?:[a-z]:[\\/]|\\\\)/iu.test(target)) return "The native write target depends on an unresolved working directory.";
    }
  }
  return undefined;
}

function gitActionOperand(args: readonly (string | undefined)[], valueOptions: readonly string[] = []): string | undefined {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--") return args[index + 1];
    if (arg === undefined) return undefined;
    if (valueOptions.includes(arg)) { index++; continue; }
    if (!arg.startsWith("-")) return arg;
  }
  return undefined;
}

/** Implicit targets feed the same path collector as explicit shell operands. */
export function inspectImplicitGitWriteTargets(
  argv: readonly (string | undefined)[], cwd: string | null,
  environment: Readonly<Record<string, string | undefined>>,
  checkPath: (path: string, label: string, cwd: string | null, effect: PathEffect) => void,
  onCommand?: (verb: string) => void,
): string | undefined {
  if (argv[0] === undefined || stripCommandPath(argv[0]).toLowerCase().replace(/\.exe$/u, "") !== "git") return undefined;
  let index = 1;
  let directory = cwd;
  let gitDirectory: string | undefined = environment.GIT_DIR;
  let unknownGitDirectory = false;
  let bare = false;
  while (index < argv.length) {
    const arg = argv[index];
    if (["--help", "-h", "--version"].includes(arg ?? "")) return undefined;
    if (arg === "--bare") { bare = true; index++; continue; }
    if (arg === "-C") {
      const value = argv[++index];
      if (value === undefined || directory === null) directory = null;
      else directory = resolveShellFilesystemPath(value, directory);
      index++; continue;
    }
    if (arg?.startsWith("-C") && arg.length > 2) {
      directory = directory === null ? null : resolveShellFilesystemPath(arg.slice(2), directory);
      index++; continue;
    }
    if (arg === "--git-dir" || arg?.startsWith("--git-dir=")) {
      gitDirectory = arg === "--git-dir" ? argv[++index] : arg.slice("--git-dir=".length);
      if (gitDirectory === undefined) unknownGitDirectory = true;
      index++; continue;
    }
    if (arg === "-c" || arg === "--work-tree" || arg === "--namespace" || arg === "--config-env") { index += 2; continue; }
    if (arg?.startsWith("-")) { index++; continue; }
    break;
  }
  const verb = argv[index];
  if (verb === undefined || IMPLICIT_GIT_WRITE_TARGETS[verb] === undefined) return undefined;
  let metadataTarget = IMPLICIT_GIT_WRITE_TARGETS[verb]!;
  onCommand?.(verb);
  const args = argv.slice(index + 1);
  const separator = args.indexOf("--");
  const options = separator < 0 ? args : args.slice(0, separator);
  if (options.includes("--help") || options.includes("-h")) return undefined;
  if (verb === "config") {
    const operands: Array<string | undefined> = [];
    for (let cursor = 0; cursor < args.length; cursor++) {
      const arg = args[cursor];
      if (arg === "--") { operands.push(...args.slice(cursor + 1)); break; }
      if (["--file", "-f", "--type", "--blob", "--default"].includes(arg ?? "")) { cursor++; continue; }
      if (arg === undefined || !arg.startsWith("-")) operands.push(arg);
    }
    const explicitWrite = options.some((arg) => arg !== undefined && GIT_CONFIG_WRITE_OPTIONS.has(arg))
      || ["set", "unset", "rename-section", "remove-section", "edit"].includes(args[0] ?? "");
    const query = options.some((arg) => arg !== undefined && GIT_CONFIG_READ_OPTIONS.has(arg))
      || ["get", "list"].includes(args[0] ?? "") || !explicitWrite && operands.length < 2 && !args.includes(undefined);
    const effect: PathEffect = query ? "read" : "write";
    const fileIndex = options.findIndex((arg) => arg === "--file" || arg === "-f" || arg?.startsWith("--file="));
    if (fileIndex >= 0) {
      const option = args[fileIndex]!;
      const file = option.startsWith("--file=") ? option.slice(7) : args[fileIndex + 1];
      if (file === undefined) return query ? undefined : "The configuration write target is unresolved.";
      checkPath(file, "repository configuration", directory, effect);
      return undefined;
    }
    if (options.includes("--global")) {
      const home = environment.HOME ?? environment.USERPROFILE ?? homedir();
      checkPath(environment.GIT_CONFIG_GLOBAL ?? join(home, ".gitconfig"), "global repository configuration", directory, effect);
      return query ? undefined : "The command mutates protected global repository configuration.";
    }
    if (options.includes("--system")) {
      checkPath(environment.GIT_CONFIG_SYSTEM ?? "/etc/gitconfig", "system repository configuration", directory, effect);
      return undefined;
    }
    if (directory === null || unknownGitDirectory) return query ? undefined : "The implicit repository write target is unresolved.";
    const base = gitDirectory === undefined ? join(directory, ".git") : resolveShellFilesystemPath(gitDirectory, directory);
    checkPath(join(base, "config"), "repository configuration", directory, effect);
    return query ? undefined : "The command mutates protected repository configuration.";
  }
  if (verb === "clone") return "The command creates protected repository control metadata.";
  if (verb === "remote") {
    const action = args.find((arg) => arg === undefined || !["-v", "--verbose", "--no-verbose", "--"].includes(arg));
    if (action === undefined && args.includes(undefined)) return "The repository configuration mutation is unresolved.";
    if (!["add", "set-url", "remove", "rm", "rename", "set-head", "set-branches", "update", "prune"].includes(action ?? "")) return undefined;
  }
  if (verb === "symbolic-ref" && !args.includes("--delete") && !args.includes("-d") && args.filter((arg) => arg !== undefined && !arg.startsWith("-")).length < 2) return undefined;
  if (verb === "push") {
    if (options.includes("--dry-run") || options.includes("-n")) return undefined;
    const upstream = options.includes("--set-upstream") || options.includes("-u");
    if (upstream) metadataTarget = "config";
    const repositoryFlag = options.find((arg) => arg?.startsWith("--repo="));
    const repositoryIndex = options.indexOf("--repo");
    const remote = repositoryFlag?.slice(7) ?? (repositoryIndex >= 0 ? options[repositoryIndex + 1]
      : gitActionOperand(args, ["--receive-pack", "--exec", "-o", "--push-option"]));
    if (!upstream && remote !== undefined && (/^[a-z][a-z0-9+.-]*:\/\//iu.test(remote) || /^(?:[^/\s]+@)?[^/:\s]+:.+/u.test(remote) || /^(?:[/.~]|[a-z]:[\\/])/iu.test(remote))) return undefined;
  }
  if (verb === "branch" || verb === "tag") {
    const mutationFlags = verb === "branch"
      ? ["-d", "-D", "--delete", "-m", "-M", "--move", "-c", "-C", "--copy", "--edit-description", "--unset-upstream"]
      : ["-d", "--delete", "-a", "--annotate", "-s", "--sign", "-f", "--force", "-m", "--message", "-F", "--file"];
    const mutation = options.some((arg) => arg !== undefined && (mutationFlags.includes(arg) || arg.startsWith("--set-upstream-to")));
    const listing = options.some((arg) => arg !== undefined && ["-l", "--list", "-a", "--all", "-r", "--remotes", "--show-current", "--contains", "--no-contains", "--merged", "--no-merged", "--points-at", "-v", "--verify"].includes(arg));
    const name = gitActionOperand(args, ["--sort", "--format", "--color", "--column"]);
    if (!mutation && (args.length === 0 || listing || name === undefined && !args.includes(undefined))) return undefined;
  }
  const action = gitActionOperand(args, ["--ref", "--git-dir", "--work-tree"]);
  if (verb === "stash" && ["list", "show"].includes(action ?? "")) return undefined;
  if (verb === "reflog" && !["expire", "delete", "drop", "write"].includes(action ?? "") && !args.includes(undefined)) return undefined;
  if (verb === "worktree" && !["add", "move", "remove", "lock", "unlock", "prune", "repair"].includes(action ?? "") && !args.includes(undefined)) return undefined;
  if (verb === "submodule" && !["add", "init", "deinit", "update", "set-branch", "set-url", "sync", "absorbgitdirs"].includes(action ?? "") && !args.includes(undefined)) return undefined;
  if (verb === "notes" && !["add", "append", "copy", "edit", "merge", "prune", "remove"].includes(action ?? "") && !args.includes(undefined)) return undefined;
  if (verb === "replace" && (args.length === 0 || options.includes("-l") || options.includes("--list"))) return undefined;
  if (verb === "bisect" && ["log", "terms", "visualize", "view"].includes(args[0] ?? "")) return undefined;
  if (directory === null || unknownGitDirectory) return "The implicit repository write target is unresolved.";
  if (verb === "init") {
    let destination = directory;
    for (let cursor = 0; cursor < args.length; cursor++) {
      const arg = args[cursor];
      if (arg === undefined) return "The new repository write target is unresolved.";
      if (arg === "--bare") { bare = true; continue; }
      if (arg === "--separate-git-dir") {
        gitDirectory = args[++cursor];
        if (gitDirectory === undefined) return "The new repository control directory is unresolved.";
        continue;
      }
      if (arg.startsWith("--separate-git-dir=")) { gitDirectory = arg.slice(19); continue; }
      if (["--template", "--initial-branch", "-b", "--object-format", "--ref-format"].includes(arg)) { cursor++; continue; }
      if (!arg.startsWith("-") && arg !== "--") destination = resolveShellFilesystemPath(arg, directory);
    }
    const base = gitDirectory === undefined ? bare ? destination : join(destination, ".git") : resolveShellFilesystemPath(gitDirectory, directory);
    checkPath(join(base, "hooks"), "implicit repository hooks write", directory, "write");
    return "The command mutates protected repository control metadata.";
  }
  const base = gitDirectory === undefined ? join(directory, ".git") : resolveShellFilesystemPath(gitDirectory, directory);
  checkPath(join(base, metadataTarget), "implicit repository control write", directory, "write");
  return "The command mutates protected repository control metadata.";
}

interface ShellWriteTargetProof {
  dynamicWords: Set<ShellWord>;
  boundTargets: Set<ShellWord>;
  commands: number;
  simpleDataCommand: boolean;
}

function evidenceBudgetExceeded(error: ShellExecutionError): boolean {
  const reason = error.message.replace(/^(?:nested command cannot be analyzed: )+/u, "");
  return shellFloorParserBudgetExceeded(reason)
    || ["execution-state limit exceeded", "execution-step limit exceeded", "execution analysis depth exceeded", "loop expansion limit exceeded", "loop authority state does not converge within the execution-state limit"].includes(reason);
}

function hostBoundPathWord(word: ShellWord, incoming: Readonly<Record<string, string | undefined>>, current: Readonly<Record<string, string | undefined>>): boolean {
  return word.parts.some((part) => part.kind === "parameter") && word.parts.every((part) => part.kind === "literal"
    || part.kind === "parameter" && part.index === undefined && incoming[part.name] !== undefined && incoming[part.name] === current[part.name]);
}

export function findShellPathPolicyViolation(
  command: string, cwd: string, sandboxRoot: string, extraAllowedDirectories: readonly string[],
  blockReadsOutsideWorkingDirectories: boolean,
  facts: ShellExecutionFacts = { dialect: "bash", environment: {} },
  evidence?: PermissionPathEvidence[],
  onUnknownWrite?: (reason: string) => void,
  targetProof?: ShellWriteTargetProof,
): ShellPathPolicyViolation | null {
  const evidenceForPath = evidence ? createPermissionPathEvidence(sandboxRoot) : undefined;
  const resolvedEvidencePaths = evidence ? new Map<string, string>() : undefined;
  let unresolvedEvidence: ShellPathPolicyViolation | null = null;
  const nativeCwdViolation = windowsShellPathViolation(cwd, cwd, "write");
  if (!evidence && nativeCwdViolation) return nativeCwdViolation;
  const cwdError = validateShellWorkingDirectory(cwd, sandboxRoot, extraAllowedDirectories);
  if (!evidence && cwdError) return { kind: cwdError.startsWith("Sensitive") ? "sensitive-path" : "sandbox-boundary", reason: cwdError, path: cwd };
  const checkPath = (path: string, label: string, cwd: string | null, effect: PathEffect, deleting = false, role?: "directory"): void => {
    if (evidence && role === "directory") effect = "read";
    // Public standard-stream operands identify child descriptors; host resolution would inspect different resources.
    if (SHELL_DEVICE_PATHS.has(path)) return;
    const nativeViolation = windowsShellPathViolation(path, label, effect);
    if (!evidence && nativeViolation) throw new PathPolicyError(nativeViolation);
    // Check prepared HOME and OS home tilde anchors without granting either workspace authority.
    if (!evidence && (label === "~" || label.startsWith("~/"))) {
      for (const candidate of expandShellTildePaths(label)) {
        const sensitive = isAdmissionDeniedPath(caseFoldForMatch(canonicalizePathForMatch(candidate)), effect);
        if (sensitive) throw new PathPolicyError({ kind: "sensitive-path", reason: `Sensitive path: command operand ${label} matches ${sensitive}`, candidate: label, path: candidate });
      }
    }
    // Drive-relative targets depend on a per-drive cwd that was not captured.
    if (process.platform === "win32" && /^[A-Za-z]:(?![\\/])/.test(path)) decline("drive-relative command operand is unresolved");
    if (!isAbsolute(path) && cwd === null) {
      if (effect === "write") onUnknownWrite?.("The write target's working directory is unresolved.");
      if (evidence) {
        unresolvedEvidence ??= { kind: "dynamic-path", reason: "Shell path policy: working directory is unresolved", candidate: label };
        return;
      }
      decline("working directory is unresolved");
    }
    if (!evidence) {
      const lexical = isAbsolute(path) ? path : `${cwd ?? sandboxRoot}/${path}`;
      const admission = isAdmissionDeniedPath(caseFoldForMatch(lexical), effect);
      if (admission) throw new PathPolicyError({ kind: "sensitive-path", reason: `Sensitive path: command operand ${label} matches ${admission}`, candidate: label, path: lexical });
    }
    let absolute: string;
    try {
      const key = resolvedEvidencePaths ? JSON.stringify([cwd, path]) : undefined;
      absolute = key === undefined ? resolveShellFilesystemPath(path, cwd ?? sandboxRoot, { dialect: "bash" })
        : resolvedEvidencePaths!.get(key) ?? resolveShellFilesystemPath(path, cwd ?? sandboxRoot, { dialect: "bash" });
      if (key !== undefined) resolvedEvidencePaths!.set(key, absolute);
    }
    catch (error) {
      if (!(error instanceof Error) || !("code" in error)) throw error;
      if (evidence) {
        unresolvedEvidence ??= { kind: "invalid-path", reason: "Shell path policy: cannot resolve command operand", candidate: label };
        if (effect === "write") onUnknownWrite?.(`The write target's identity is unresolved: ${label}`);
        return;
      }
      if (error.code === "EUNRESOLVEDSHELLPATH") throw new PathPolicyError({
        kind: "dynamic-path", reason: `Shell path policy: filesystem namespace is unresolved: ${label}`, candidate: label,
      });
      throw new PathPolicyError({ kind: "invalid-path", reason: "Shell path policy: cannot resolve command operand", candidate: label });
    }
    if (evidence) {
      const lexical = isAbsolute(path) ? path : `${cwd ?? sandboxRoot}/${path}`;
      evidence.push({ ...evidenceForPath!({ lexical, canonical: absolute, effect }), ...(deleting ? { deleteIntent: true as const } : {}) });
      return;
    }
    const violation = findResolvedShellPathViolation(absolute, label, sandboxRoot, extraAllowedDirectories, effect, blockReadsOutsideWorkingDirectories);
    if (violation) throw new PathPolicyError(violation);
  };
  try {
    inspectShellExecution(command, cwd, facts, { path: (path, raw, at, effect, role) => checkPath(path, raw, at, effect, false, role),
      word(word) {
        if (word.parts.some((part) => part.kind !== "literal")) targetProof?.dynamicWords.add(word);
      },
      unresolvedState(error) {
        if (!evidence || evidenceBudgetExceeded(error)) return;
        unresolvedEvidence ??= { kind: "dynamic-path", reason: "Shell path policy: " + error.message, ...(error.operand ? { candidate: error.operand } : {}) };
        return true;
      },
      unresolvedWord(word, error) {
        if (!evidence || evidenceBudgetExceeded(error)) return;
        unresolvedEvidence ??= { kind: "dynamic-path", reason: "Shell path policy: unresolved command operand", candidate: word.source.raw };
        return true;
      },
      resolvedRedirect(target, _path, effect, environment) {
        if (effect !== "write" || target.parts.every((part) => part.kind === "literal")) return;
        if (hostBoundPathWord(target, facts.environment, environment)) targetProof?.boundTargets.add(target);
        else onUnknownWrite?.(`The write target lacks a deterministic host environment binding: ${target.source.raw}`);
      },
      unresolvedPath(raw, _cwd, effect, error, role) {
        if (error && evidenceBudgetExceeded(error)) return;
        if (evidence && role === "directory") effect = "read";
        if (effect === "write") onUnknownWrite?.(`The write target may be protected: ${raw}`);
        if (evidence) {
          unresolvedEvidence ??= { kind: "dynamic-path", reason: "Shell path policy: unresolved redirect target", candidate: raw };
          return true;
        }
      }, command(event) {
      const {node, effective} = event;
      const outerKnownArgv = event.argv.map((argument,index) => argument ?? displayShellWord(effective.words[index]!));
      const outerSlots = classifyOperandSlots(outerKnownArgv);
      const view = projectCommandPolicyView(event, outerSlots);
      const {
        argv, words, knownArgv, slots, offset, executableHeads,
        wrapperPaths, wrapperCwds, environment: projectedEnvironment, cwd: projectedCwd,
      } = view;
      if (view.unsupported) decline(view.unsupported.reason, view.unsupported.word);
      const head = argv[0];
      if (head === undefined) {
        inspectEmbeddedShellPrograms(event, outerSlots);
        return;
      }
      const verb = transferCommandVerb(head) ?? stripCommandPath(head);
      if (event.functionCall) return;
      if (targetProof) {
        targetProof.commands++;
        targetProof.simpleDataCommand &&= ["echo", "printf"].includes(head) && event.original.assignments.length === 0
          && event.original.words.every((word) => staticShellWord(word) !== undefined)
          && event.effective.wrappers.length === 0 && !event.fromPipe && event.activeFunctions.length === 0 && event.definedFunctions.length === 0;
      }
      let implicitGitCommand: string | undefined;
      if (evidence && verb.toLowerCase().replace(/\.exe$/u, "") === "git") {
        const unknownTarget = inspectImplicitGitWriteTargets(argv, projectedCwd, projectedEnvironment, checkPath, (command) => { implicitGitCommand = command; });
        if (unknownTarget) onUnknownWrite?.(unknownTarget);
      }
      // Text checks protect startup config paths and refuse selector overrides without rewriting commands.
      // Arbitrary code can bypass them without OS isolation; native sandbox denial is that boundary.
      if ((verb === "curl" || verb === "wget") && !slots.defaultConfigDisabled) {
        const selectors = verb === "curl" ? ["CURL_HOME", "XDG_CONFIG_HOME"] : ["WGETRC", "SYSTEM_WGETRC"];
        const homeSelectors = ["HOME", ...(verb === "curl" && process.platform === "win32" ? ["APPDATA", "USERPROFILE"] : [])];
        const normalizeName = (name: string): string => process.platform === "win32" ? name.toUpperCase() : name;
        const redirected = Object.entries(projectedEnvironment).some(([name, value]) => {
          const normalized = normalizeName(name);
          return selectors.includes(normalized) || (homeSelectors.includes(normalized)
            && (value === undefined || value !== Object.entries(facts.environment).find(([key]) => normalizeName(key) === normalized)?.[1]));
        });
        if (redirected) decline("transfer configuration environment is unsupported", words[0]);
      }
      // State analysis checks cd semantics; builtin exit consumes status data after expansion and redirect checks.
      // External executables and functions named exit keep operand checks; infer no numeric result and keep conservative scanning.
      const sourceBuiltin = evidence && event.builtin && ["source", "."].includes(verb);
      const opaqueBuiltin = sourceBuiltin || evidence && event.builtin && ["eval", "alias", "unalias", "shopt"].includes(verb);
      if (sourceBuiltin) {
        const fileIndex = argv[1] === "--" ? 2 : 1;
        const file = argv[fileIndex];
        if (file !== undefined) checkPath(file, words[fileIndex]!.source.raw, projectedCwd, "read");
      }
      const dataOnly = opaqueBuiltin || SHELL_DATA_ONLY_COMMANDS.has(verb)
        || (offset === 0 && event.builtin
          && ["export", "readonly", "unset", "read", "cd", "exit", "break"].includes(verb));
      // Prove mixed data/program argv shape before consuming option values.
      if (verb === "sqlite3") assertProjectedOperandCardinality(argv, words);
      // Unknown values may be flags; prove option positions from literal/bound messages and keep substitutions checked.
      if (verb.toLowerCase() === "git") {
        const unknown = argv.findIndex((argument) => argument === undefined);
        if (unknown >= 0) {
          if (!evidence) decline("unresolved command operand", words[unknown]);
          unresolvedEvidence ??= { kind: "dynamic-path", reason: "Shell path policy: unresolved command operand", candidate: words[unknown]?.source.raw };
        }
      }
      const leaf = commandLeaf(node, effective);
      const effect: PathEffect = verb === "cd" ? evidence ? "read" : "write" : isReadOnlyShellLeaf(leaf, {ignoreRedirects:true}) ? "read" : "write";
      if (!evidence && pathEffectIsConfined(effect, blockReadsOutsideWorkingDirectories)) {
        if (RECURSIVE_TRAVERSAL_COMMANDS.has(verb) && !(verb === "tar" && parseTarListing(knownArgv) && !projectedEnvironment.TAR_OPTIONS)) {
          throw new PathPolicyError({kind:"recursive-traversal",reason:buildRecursiveBlockMessage(head,verb),candidate:head});
        }
        const selected=recursiveTraversalFlag(verb, knownArgv);
        if(selected) throw new PathPolicyError({kind:"recursive-traversal",reason:buildRecursiveBlockMessage(head,verb,selected),candidate:selected});
      }
      const projectedSlots = offset === 0 && event.testExpression ? {
        ...slots,
        nonPathIndices: new Set([...slots.nonPathIndices, ...event.testExpression.dataIndices]),
      } : slots;
      if(projectedSlots.dynamicExecution) decline(projectedSlots.dynamicExecution);
      const unknowns = argv.flatMap((argument, index) => argument === undefined && !dataOnly
        && !(["curl", "wget"].includes(verb) && isQuotedRemoteUrl(words[index]!))
        && (verb === "curl" || projectedSlots.programIndices?.has(index) || !projectedSlots.nonPathIndices.has(index) || projectedSlots.extraCandidates.some((path) => path.index === index)) ? [index] : []);
      for (const unknown of unknowns) {
        if (isUnknownWriteTarget(verb, unknown, argv, knownArgv, projectedSlots, words[unknown])) onUnknownWrite?.(`The write target may be protected: ${words[unknown]?.source.raw ?? "unresolved operand"}`);
        if (!evidence) decline("unresolved command operand", words[unknown]);
        unresolvedEvidence ??= { kind: "dynamic-path", reason: "Shell path policy: unresolved command operand", candidate: words[unknown]?.source.raw };
      }
      if (evidence) {
        for (let index = 1; index < argv.length; index++) {
          if (argv[index] === undefined || !isUnknownWriteTarget(verb, index, argv, knownArgv, projectedSlots, words[index])) continue;
          const originalWord = event.original.words.find((word) => word.source === words[index]?.source);
          if (originalWord && originalWord.parts.some((part) => part.kind !== "literal")
            && !hostBoundPathWord(originalWord, facts.environment, projectedEnvironment)) {
            onUnknownWrite?.(`The write target lacks a deterministic host environment binding: ${originalWord.source.raw}`);
          }
        }
      }
      // Executable paths inherit the command's proven effect; readable bytes alone cannot prove read-only execution.
      const hostScriptReads = hostScriptInvocationReadPaths(argv, projectedEnvironment);
      for (const executable of executableHeads) {
        checkPath(executable.value, executable.word.source.raw, executable.cwd,
          hostScriptReads.includes(executable.value) ? "read" : effect);
      }
      for (const wrapperPath of wrapperPaths) {
        checkPath(wrapperPath.value, wrapperPath.word.source.raw, wrapperPath.cwd, "read");
      }
      for (const wrapperCwd of wrapperCwds) {
        checkPath(wrapperCwd.value, wrapperCwd.word.source.raw, wrapperCwd.cwd, "write", false, "directory");
      }
      if(!dataOnly && implicitGitCommand !== "config" && implicitGitCommand !== "remote"){
        let optionsEnded=false;
        for(let index=1;index<knownArgv.length;index++){
          const argument=knownArgv[index]!;
          if (evidence && argv[index] === undefined) continue;
          if(projectedSlots.nonPathIndices.has(index))continue;
          // A URL in an opaque command is data; a proven output slot still names a filesystem target.
          if (evidence && !["curl", "wget"].includes(verb) && /^[a-z][a-z0-9+.-]*:\/\//iu.test(argument)
            && !isUnknownWriteTarget(verb, index, argv, knownArgv, projectedSlots, words[index])) continue;
          if(!optionsEnded && argument === "--"){optionsEnded=true;continue;}
          if(offset === 0 && event.testExpression?.pathIndices.has(index)){
            checkPath(argument,words[index]!.source.raw,projectedCwd,effect);
            continue;
          }
          for(const path of operandPaths(argument,!optionsEnded,verb)) {
            const copySource = evidence && verb === "cp" && (index < knownArgv.length - 1
              || knownArgv.some((value) => value === "-t" || value.startsWith("--target-directory") || /^-[^-]*t/.test(value)));
            const inputFile = evidence && verb === "dd" && argument.startsWith("if=");
            checkPath(path, words[index]!.source.raw, projectedCwd,
              copySource || inputFile || (index === 1 && hostScriptReads.includes(path)) ? "read" : effect,
              ["rm", "rmdir", "unlink"].includes(verb) || (verb === "find" && knownArgv.includes("-delete")));
          }
        }
        for(const path of projectedSlots.extraCandidates){
          if (evidence && argv[path.index] === undefined) continue;
          checkPath(path.value,words[path.index]!.source.raw,projectedCwd,path.effect ?? effect);
          // File-backed options are reads, but can redirect output at runtime.
          if(path.refuseAfterCheck)ambiguousTransferPath();
        }
      }
      inspectEmbeddedShellPrograms(event,outerSlots);
    }}, evidence ? MAX_SHELL_ANALYSIS_TOKENS : undefined);
    return unresolvedEvidence;
  }catch(error){
    if(error instanceof PathPolicyError)return error.violation;
    if(error instanceof ShellExecutionError)return {kind:evidenceBudgetExceeded(error) ? "analysis-limit" : "dynamic-path",reason:"Shell path policy: "+error.message,...(error.operand?{candidate:error.operand}:{})};
    throw error;
  }
}

/** Collect parsed operands, retaining repeated spellings and their individual effects.
 * A non-null unproven result means paths may be partial; route that uncertainty through the pipeline. */
export function inspectShellPermissionPaths(command: string, cwd: string, facts: ShellExecutionFacts = { dialect: "bash", environment: {} }): {
  paths: readonly PermissionPathEvidence[];
  unproven: ShellPathPolicyViolation | null;
  unknownProtectedWrite?: string;
  resolvedWriteTargetsOnly?: true;
} {
  const paths: PermissionPathEvidence[] = [];
  let unknownProtectedWrite: string | undefined;
  const targetProof: ShellWriteTargetProof = { dynamicWords: new Set(), boundTargets: new Set(), commands: 0, simpleDataCommand: true };
  const unproven = findShellPathPolicyViolation(command, cwd, cwd, [], false, facts, paths, (reason) => { unknownProtectedWrite ??= reason; }, targetProof);
  const resolvedWriteTargetsOnly = unproven === null && !unknownProtectedWrite && targetProof.commands === 1 && targetProof.simpleDataCommand
    && targetProof.dynamicWords.size > 0 && [...targetProof.dynamicWords].every((word) => targetProof.boundTargets.has(word));
  return { paths, unproven, ...(unknownProtectedWrite ? { unknownProtectedWrite } : {}), ...(resolvedWriteTargetsOnly ? { resolvedWriteTargetsOnly: true as const } : {}) };
}

function operandPaths(value: string, option: boolean, verb: string): string[] {
  if (["curl", "wget"].includes(verb) && /^file:/i.test(value)) {
    // This protocol is unsupported by wget and grants no local file authority.
    if (verb === "wget") return [];
    // Preserve link and parent components; URL normalization would erase them before filesystem inspection.
    const match = /^file:(?:\/\/([^/]*))?(.*)$/i.exec(value);
    if (!match || (match[1] && match[1].toLowerCase() !== "localhost") || /[?#\0\r\n]/.test(value)) ambiguousTransferPath();
    let path: string;
    try { path = decodeURIComponent(match[2]!); } catch { return ambiguousTransferPath(); }
    if (!path || /[\0\r\n]/.test(path) || path.includes("\\")) ambiguousTransferPath();
    if (process.platform === "win32" && /^\/[a-z]:\//i.test(path)) path = path.slice(1);
    return [path];
  }
  if (["curl", "wget"].includes(verb) && /^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    return [];
  }
  if (value === "-" && ["cat", "sed", "awk", "head", "tail", "sort", "diff", "tee"].includes(verb)) return [];
  let paths = [value];
  if (option && value.startsWith("-") && value.length > 1) {
    const equals = value.indexOf("=");
    if (value.startsWith("--") && equals > 0) return [value.slice(equals + 1)];
    // For unknown arity, check every possible nonempty value suffix through path policy without granting data exemptions.
    // Never split values already owned by a known option contract.
    return value.startsWith("--") ? [] : Array.from({ length: value.length - 2 }, (_, index) => value.slice(index + 2));
  }
  if (["awk", "gawk", "mawk", "nawk"].includes(verb)) {
    return paths.map((path) => {
      const equals = path.indexOf("=");
      return equals > 0 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(path.slice(0, equals)) ? path.slice(equals + 1) : path;
    });
  }
  if (verb === "dd" && (value.startsWith("if=") || value.startsWith("of="))) return [value.slice(3)];
  return paths;
}

function isQuotedRemoteUrl(word: ShellWord): boolean {
  const first = word.parts[0];
  return first?.kind === "literal" && /^https?:\/\//i.test(first.value)
    && word.parts.every((part) => part.kind === "literal" || (part.kind === "parameter" && part.quoted));
}
export function validateShellCommandPathPolicy(
  command: string, cwd: string, sandboxRoot: string, extraAllowedDirectories: readonly string[],
  blockReadsOutsideWorkingDirectories: boolean, facts?: ShellExecutionFacts,
): string | null {
  return findShellPathPolicyViolation(command, cwd, sandboxRoot, extraAllowedDirectories, blockReadsOutsideWorkingDirectories, facts)?.reason ?? null;
}

/** Program roles and recursive admission are shared by structural and path checks. */
export function inspectEmbeddedShellPrograms(event: ShellCommandEvent, suppliedSlots?: OperandSlotClassification): void {
  const view = projectCommandPolicyView(event, suppliedSlots);
  if (view.unsupported) decline(view.unsupported.reason, view.unsupported.word);
  const nestedContext = {
    cwd: view.cwd,
    environment: view.environment,
    unsetVariables: view.unsetVariables,
  };
  const inspectProgramView = (
    argv: readonly (string | undefined)[],
    words: readonly ShellWord[],
    slots: OperandSlotClassification,
  ): void => {
    if (slots.dynamicExecution) decline(slots.dynamicExecution);
    const unknownProgram = argv.findIndex((argument, index) =>
      argument === undefined && slots.programIndices?.has(index));
    if (unknownProgram >= 0) decline("unresolved embedded program", words[unknownProgram]);
    // Leave unresolved non-program operands to the path gate without guessing arity or roles.
    if (argv.some((argument) => argument === undefined)) {
      if (stripCommandPath(argv[0]!) === "sqlite3") assertProjectedOperandCardinality(argv, words);
      return;
    }
    assertProjectedOperandCardinality(argv, words);
    const knownArgv = argv as readonly string[];

    for (const program of slots.nestedCommands) event.inspectNested(program.value, "posix", nestedContext, words[program.index]?.source);
    const verb = stripCommandPath(knownArgv[0]!);
    const shellOptions = NON_PATH_OPERAND_SPECS.get(verb)?.nestedCommandOptions;
    if (!shellOptions) return;
    if (!["sh", "dash", "bash"].includes(verb)) decline("nested shell dialect is not supported", words[0]);
    const dialect = verb === "bash" ? "bash" : "posix";
    let carriesCommand = false;
    for (let index = 1; index < knownArgv.length; index += 1) {
      const carried = readOptionValue(knownArgv, index, shellOptions);
      if (!carried) continue;
      event.inspectNested(carried.value, dialect, nestedContext, words[carried.consumedNext ? index + 1 : index]?.source);
      carriesCommand = true;
      if (carried.consumedNext) index += 1;
    }
    if (!carriesCommand) {
      for (const redirect of event.inputRedirect ? [event.inputRedirect] : []) {
        if (!redirect.data) continue;
        const program = staticShellWord(redirect.data);
        if (program === undefined) decline("unresolved shell input program", redirect.data);
        event.inspectNested(program, dialect, nestedContext, redirect.data.source);
      }
      if (event.fromPipe) decline("unresolved shell program from a pipe", words[0]);
    }
  };

  inspectProgramView(view.argv, view.words, view.slots);
}
