// Broad shell prefixes may receive exact one-call consent but never persistent prefix allows; deny/ask rules remain unrestricted.

import { analyzeShell, staticShellWord, type ShellAnalysis, type ShellCommand, type ShellWord } from "../../shared/shell-analysis.js";
import { MAX_SHELL_ANALYSIS_TOKENS } from "../../shared/shell-analysis-limits.js";

import { SHELLS, INTERPRETERS, WRAPPERS, PACKAGE_RUNNERS, BANNED_PREFIX_SUGGESTIONS, isDestructiveShellArgv, noReusableRuleReason, WRAPPER_SET, RUNNER_SET, programName, runnerName, refusedShellPrefix, MAX_LITERAL_COMMAND_LENGTH } from "./shell-prefix-values.js";
export { refusedShellPrefix } from "./shell-prefix-values.js";

// Setup operands, value options and shell-command options share one grammar. A command view widens inspection and restrictions, never allow coverage.
interface WrapperGrammar {
  flags?: readonly string[];
  flagPattern?: RegExp;
  values?: readonly string[];
  alternateFlags?: readonly string[];
  code?: readonly string[];
  operand?: true | RegExp;
  separator?: ",";
  optionsAfterOperand?: boolean;
  direct?: readonly string[];
  boundary?: readonly string[];
  noCommand?: readonly string[];
  assignments?: true;
  shell?: true;
  runtimeArgv?: true;
}
const WRAPPER_GRAMMAR: Readonly<Record<string, WrapperGrammar>> = {
  xargs: { flags: ["-0", "-r", "-t", "-x", "-p", "--null", "--no-run-if-empty", "--verbose", "--exit", "--interactive"], values: ["-I", "-L", "-n", "-P", "-s", "-d", "-E", "-a", "--arg-file", "--delimiter", "--max-args", "--max-procs", "--replace"], runtimeArgv: true },
  sudo: { flags: ["-A", "-b", "-B", "-E", "-H", "-i", "-k", "-K", "-n", "-P", "-S", "-s", "-v", "-e", "-l", "--askpass", "--background", "--bell", "--preserve-env", "--set-home", "--login", "--reset-timestamp", "--remove-timestamp", "--non-interactive", "--preserve-groups", "--stdin", "--shell", "--validate", "--edit", "--list"], values: ["-u", "-g", "-C", "-h", "-p", "-r", "-t", "-U", "-D", "--user", "--group"], assignments: true },
  doas: { flags: ["-L", "-n", "-s"], values: ["-u", "-C"] },
  env: { flags: ["-i", "-0", "-v", "--ignore-environment", "--null", "--debug"], values: ["-u", "-C", "--unset", "--chdir"], assignments: true },
  timeout: { flags: ["-v", "--verbose", "--foreground", "--preserve-status"], values: ["-s", "-k", "--signal", "--kill-after"], operand: /^\d+(?:\.\d+)?[smhd]?$/ },
  // https://www.gnu.org/software/coreutils/manual/html_node/nice-invocation.html: -N adjustment.
  nice: { flagPattern: /^-[+-]?\d+$/, values: ["-n", "--adjustment"] },
  ionice: { flags: ["-t", "--ignore"], values: ["-c", "-n", "-p", "--class", "--classdata"] },
  watch: { flags: ["-b", "-c", "-d", "-e", "-g", "-p", "-t", "-w", "-x", "--beep", "--color", "--differences", "--errexit", "--chgexit", "--precise", "--no-title", "--watch", "--exec"], values: ["-n", "--interval"] },
  stdbuf: { values: ["-i", "-o", "-e"] },
  // https://man7.org/linux/man-pages/man1/chrt.1.html: optional numeric priority; -p targets a PID.
  chrt: { flags: ["-a", "-b", "-d", "-e", "-f", "-i", "-o", "-r", "-R", "-v", "--all-tasks", "--batch", "--deadline", "--ext", "--fifo", "--idle", "--other", "--rr", "--reset-on-fork", "--verbose"], values: ["-T", "-P", "-D", "-U", "-X", "--sched-runtime", "--sched-period", "--sched-deadline", "--clamp-min", "--clamp-max"], operand: /^\d+$/, noCommand: ["-p", "--pid", "-m", "--max"] },
  // https://man7.org/linux/man-pages/man1/flock.1.html: lockfile then argv or -c command.
  flock: { flags: ["-e", "-x", "-n", "-o", "-s", "-u", "-F", "--exclusive", "--nonblock", "--close", "--shared", "--unlock", "--no-fork", "--fcntl", "--verbose"], values: ["-w", "-E", "--wait", "--timeout", "--conflict-exit-code", "--start", "--length"], code: ["-c", "--command"], operand: true, optionsAfterOperand: true },
  // https://man7.org/linux/man-pages/man1/taskset.1.html: mask/CPU list then argv; -p never launches.
  taskset: { flags: ["-a", "-c", "--all-tasks", "--cpu-list"], operand: /^(?:0x)?[\da-f,:\-]+$/i, separator: ",", noCommand: ["-p", "--pid"] },
  // https://man7.org/linux/man-pages/man1/setsid.1.html: boolean options then argv.
  setsid: { flags: ["-c", "-f", "-w", "--ctty", "--fork", "--wait"] },
  // https://manpages.debian.org/trixie/expect/unbuffer.1.en.html: optional -p then argv.
  unbuffer: { flags: ["-p"] },
  // https://man7.org/linux/man-pages/man1/script.1.html: optional log file, -c text or -- argv. https://raw.githubusercontent.com/freebsd/freebsd-src/main/usr.bin/script/script.1: recording setup operands, file then argv. https://raw.githubusercontent.com/apple-oss-distributions/shell_cmds/main/script/script.1: alternate -F flush arity stays visible to floor scans.
  script: { flags: ["-a", "-d", "-e", "-f", "-k", "-q", "-r", "-w", "--append", "--return", "--flush", "--force", "--quiet"], values: ["-t", "-F", "-E", "-B", "-I", "-O", "-T", "-m", "-o", "--echo", "--log-io", "--log-in", "--log-out", "--log-timing", "--logging-format", "--output-limit"], alternateFlags: ["-F"], code: ["-c", "--command"], operand: true, optionsAfterOperand: true, boundary: ["--"] },
  // https://man7.org/linux/man-pages/man1/su.1.html: optional user and -c text (in either order).
  su: { flags: ["-", "-l", "-m", "-p", "-f", "-P", "-T", "--login", "--preserve-environment", "--fast", "--pty", "--no-pty"], values: ["-s", "-g", "-G", "-w", "--shell", "--group", "--supp-group", "--whitelist-environment"], code: ["-c", "--command", "--session-command"], operand: true, optionsAfterOperand: true },
  // https://man7.org/linux/man-pages/man1/runuser.1.html: -u user -- argv, or su-compatible -c.
  runuser: { flags: ["-", "-l", "-m", "-p", "-P", "-T", "--login", "--preserve-environment", "--pty", "--no-pty"], values: ["-u", "-g", "-G", "-s", "-w", "--user", "--group", "--supp-group", "--shell", "--whitelist-environment"], code: ["-c", "--command", "--session-command"], operand: true, optionsAfterOperand: true, direct: ["-u", "--user"] },
  // https://man7.org/linux/man-pages/man1/systemd-run.1.html: service options then argv.
  "systemd-run": { flags: ["--scope", "--user", "--system", "--no-block", "--wait", "--pipe", "--pty", "--collect", "--quiet", "-q", "-P", "-t", "-G", "-d", "--same-dir", "--send-sighup", "--slice-inherit", "--remain-after-exit", "-S", "--shell", "-v", "--verbose", "--on-clock-change", "--on-timezone-change", "--no-ask-password", "--no-pager"], values: ["-C", "--capsule", "-u", "-p", "-E", "-H", "-M", "--unit", "--property", "--description", "--slice", "--service-type", "--uid", "--gid", "--nice", "--working-directory", "--root-directory", "--setenv", "--host", "--machine", "--on-active", "--on-boot", "--on-startup", "--on-unit-active", "--on-unit-inactive", "--on-calendar", "--path-property", "--socket-property", "--timer-property"] },
  // https://manpages.debian.org/trixie/firejail/firejail.1.en.html: --option=value then argv.
  firejail: { flagPattern: /^--[\w-]+$/, values: ["--profile", "--name"] },
  // https://github.com/proot-me/proot/blob/master/doc/proot/manual.rst: setup options then argv.
  proot: { flags: ["-0", "--root-id", "-n", "--netcoop"], values: ["-r", "-R", "-S", "-b", "-m", "-q", "-w", "-v", "-k", "-i", "-p", "--rootfs", "--bind", "--mount", "--qemu", "--pwd", "--cwd", "--verbose", "--kernel-release", "--change-id", "--port"] },
  // https://man7.org/linux/man-pages/man1/chroot.1.html: new root then argv.
  chroot: { flags: ["--skip-chdir"], values: ["--userspec", "--groups"], operand: true },
  // https://github.com/microsoft/WSL/blob/master/localization/strings/en-US/Resources.resw (MessageWslUsage).
  wsl: { flags: ["--system"], values: ["-d", "-u", "--distribution", "--distribution-id", "--user", "--cd", "--shell-type"], boundary: ["-e", "--exec"], noCommand: ["-l", "--list", "--status", "--shutdown"], shell: true },
};

// The inner argv boundary or a wrapper's explicit shell-command payload. Uncertain positions retain floor-only candidates, never an allow-rule boundary. Setup values retain proven arity. By default, at most sixteen wrappers are followed.
export function wrapperCommand(argv: readonly (string | undefined)[], maxDepth = 16, start = 0): { index: number; code?: { range: { from: number; to: number } }; ordinaryAsk?: string; candidateRange?: { from: number; to: number }; nestedDialect?: true; runtimeArgv?: true } {
  let index = start;
  let ordinaryAsk: string | undefined;
  let candidateFrom: number | undefined;
  let runtimeArgv = false;
  const finish = (at: number, code?: { range: { from: number; to: number } }) => ({
    index: at,
    ...(code ? { code } : {}),
    ...(ordinaryAsk ? { ordinaryAsk } : {}),
    ...(runtimeArgv ? { runtimeArgv: true as const } : {}),
    ...(candidateFrom === undefined ? {} : { candidateRange: { from: candidateFrom, to: argv.length } }),
  });
  const inspectTail = (from: number) => {
    candidateFrom = Math.min(candidateFrom ?? from, from);
  };
  const uncertain = (from: number) => {
    inspectTail(from);
    return finish(argv.length);
  };
  for (let guard = 0; guard < maxDepth && index < argv.length; guard += 1) {
    const head = argv[index];
    if (head === undefined) {
      ordinaryAsk ??= "opaque wrapper command binding";
      return uncertain(index + 1);
    }
    const program = (head.split(/[\\/]/).pop() ?? head).toLowerCase().replace(/\.exe$/i, "");
    // `eval` / `source` / `.` run a string or file: they are code carriers, not transparent wrappers.
    if (!WRAPPER_SET.has(program) || program === "eval" || program === "source" || program === ".") return finish(index);
    index += 1;
    const declared = WRAPPER_GRAMMAR[program];
    const grammar = declared ?? {};
    runtimeArgv ||= grammar.runtimeArgv === true;
    let operand = grammar.operand;
    let options = true;
    let shell = grammar.shell;
    let payload: { index: number } | undefined;
    let operandIndex: number | undefined;
    while (index < argv.length) {
      const token = argv[index];
      if (token === undefined) {
        ordinaryAsk ??= payload ? "opaque wrapper argument binding" : "opaque wrapper command binding";
        if (payload) { index += 1; operand = undefined; continue; }
        return uncertain(index + 1);
      }
      if (options && token === "--") {
        index += 1;
        options = false;
        if (grammar.boundary?.includes(token)) operand = undefined;
        continue;
      }
      if (options && token === "-" && grammar.flags?.includes(token)) { index += 1; continue; }
      if (options && token.startsWith("-") && token !== "-") {
        if (grammar.flagPattern?.test(token) && !grammar.values?.includes(token) && !grammar.code?.includes(token)) { index += 1; continue; }
        const long = token.startsWith("--");
        const flags = long ? [token.split("=")[0]!] : [...token.slice(1)].map((letter) => `-${letter}`);
        let width = 1;
        for (const [at, flag] of flags.entries()) {
          if (declared && long && token.includes("=") && !grammar.values?.includes(flag) && !grammar.code?.includes(flag)) {
            break;
          }
          if ((token === flag && (flag === "--help" || flag === "--version")) || grammar.noCommand?.includes(flag)) return finish(argv.length);
          if (grammar.boundary?.includes(flag)) { options = false; shell = undefined; break; }
          if (grammar.direct?.includes(flag)) operand = undefined;
          const code = grammar.code?.includes(flag);
          if (!code && !grammar.values?.includes(flag)) {
            if (declared && !grammar.flags?.includes(flag)) {
              ordinaryAsk ??= "unsupported wrapper option";
              // A setup operand is provisional when the remaining grammar is unknown. Keep it and every later word visible to floor scans.
              return uncertain(Math.min(operandIndex ?? index + 1, payload?.index ?? index + 1));
            }
            continue;
          }
          const attached = long ? (token.includes("=") ? token.slice(token.indexOf("=") + 1) : undefined)
            : (at + 2 < token.length ? token.slice(at + 2) : undefined);
          const valueIndex = attached === undefined ? index + 1 : index;
          if (attached === undefined && grammar.alternateFlags?.includes(flag)) inspectTail(Math.min(valueIndex + 1, argv.length));
          const text = attached ?? argv[valueIndex];
          if (text === undefined) ordinaryAsk ??= code ? "opaque wrapper code binding" : "opaque wrapper option binding";
          if (code) {
            if (payload) {
              ordinaryAsk ??= "ambiguous wrapper code binding";
              return uncertain(payload.index);
            }
            payload = { index: valueIndex };
          }
          width = attached === undefined ? 2 : 1;
          break;
        }
        index = Math.min(index + width, argv.length);
        continue;
      }
      if (operand && (operand === true || operand.test(token))) {
        operandIndex = index;
        index += 1;
        // A native list operand can occupy several structural-parser tokens.
        while (grammar.separator && argv[index] === grammar.separator && argv[index + 1] !== undefined
          && (operand === true || operand.test(argv[index + 1]!))) index += 2;
        operand = undefined;
        if (grammar.optionsAfterOperand || payload) continue;
        break;
      }
      if (grammar.assignments && /^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) { index += 1; continue; }
      if (payload) { index += 1; continue; }
      break;
    }
    if (payload) return finish(payload.index, { range: { from: payload.index, to: Math.min(payload.index + 1, argv.length) } });
    if (shell) {
      let code = false;
      for (let at = index; at < argv.length; at += 1) {
        const token = argv[at];
        if (token === undefined) { ordinaryAsk ??= "opaque wrapper code binding"; code = true; continue; }
        if (/[\s;&|<>$`\\(){}\[\]*?!~'"]/.test(token)) code = true;
      }
      if (code) return finish(index, { range: { from: index, to: argv.length } });
      if (index < argv.length) return { ...finish(index), nestedDialect: true };
    }
  }
  const next = argv[index];
  if (index < argv.length && (next === undefined || isShellWrapperProgram(next))) {
    ordinaryAsk ??= "wrapper analysis limit exceeded";
    return uncertain(index);
  }
  return finish(index);
}

// Shared boundary for deny/ask matching, inline-code and sink inspection.
export function wrapperPrefixLength(argv: readonly (string | undefined)[]): number {
  return wrapperCommand(argv).index;
}

// Value-taking global options of multi-verb tools (before the verb).
const GLOBAL_VALUE_OPTIONS: Readonly<Record<string, ReadonlySet<string>>> = {
  git: new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--config-env", "--exec-path"]),
  docker: new Set(["-H", "--host", "--context", "-c", "--config", "-l", "--log-level", "--tlscacert", "--tlscert", "--tlskey"]),
  kubectl: new Set(["-n", "--namespace", "--context", "--cluster", "--user", "-s", "--server", "--kubeconfig", "--token"]),
};

// Optional suffix results belong to one argv and let restriction views share the existing option grammar.
export function globalOptionsEnd(argv: readonly (string | undefined)[], start = 0, suffixes?: Map<string, Map<number, number>>): number {
  const head = argv[start];
  if (head === undefined) return start + 1;
  const program = programName(head);
  const valueOptions = GLOBAL_VALUE_OPTIONS[program];
  if (!valueOptions) return start + 1;
  let ends = suffixes?.get(program);
  if (suffixes !== undefined && ends === undefined) { ends = new Map(); suffixes.set(program, ends); }
  const visited: number[] = [];
  let index = start + 1;
  while (index < argv.length) {
    const cached = ends?.get(index);
    if (cached !== undefined) { index = cached; break; }
    const token = argv[index];
    if (token === undefined || !token.startsWith("-")) break;
    visited.push(index);
    if (token === "--") { index += 1; break; }
    index += valueOptions.has(token) ? 2 : 1;
  }
  for (const at of visited) ends?.set(at, index);
  return index;
}

// argv with a multi-verb tool's global options removed (`git -C. push` → `git push`). Deny/ask matching tries this form as well as the original, so a global option can never step a command around a restriction.
export function stripGlobalOptions(argv: readonly (string | undefined)[]): readonly (string | undefined)[] {
  const head = argv[0];
  if (head === undefined) return argv;
  const index = globalOptionsEnd(argv);
  return index === 1 ? argv : [head, ...argv.slice(index)];
}

// A proposed wildcard prefix must be the supplied complete static argv.
export function suggestShellPrefix(argv: readonly (string | undefined)[], wildcard = true): string[] | null {
  if (argv.length === 0 || argv.some((token) => token === undefined || /[\s;&|<>()$`'"\\*?[\]{}#~!]/.test(token))
    || isDestructiveShellArgv(argv) || noReusableRuleReason(argv) !== null) return null;
  const tokens = argv as readonly string[];
  return refusedShellPrefix(tokens, wildcard) === null ? [...tokens] : null;
}

// Exposed for the design doc and tests; do not fork these lists elsewhere.
export const SHELL_PREFIX_POLICY = Object.freeze({
  shells: Object.freeze([...SHELLS]),
  interpreters: Object.freeze([...INTERPRETERS]),
  wrappers: Object.freeze([...WRAPPERS]),
  packageRunners: Object.freeze([...PACKAGE_RUNNERS]),
  bannedPrefixSuggestions: BANNED_PREFIX_SUGGESTIONS,
});

// Used by deny/ask matching to look through wrappers (it only ever widens a deny).
export function isShellWrapperProgram(token: string): boolean {
  return WRAPPER_SET.has((token.split(/[\\/]/).pop() ?? token).toLowerCase().replace(/\.exe$/i, ""));
}

// Network identities are shared by the conservative restriction helpers.
const NETWORK_PROGRAMS = new Set([
  "curl", "wget", "ssh", "scp", "sftp", "rsync", "openssl", "nc", "ncat", "netcat", "socat", "telnet", "nslookup",
  "dig", "host", "drill", "whois", "ping", "gh", "glab", "aws", "gcloud", "gsutil", "az", "http", "https", "xh",
  "httpie", "ftp", "lftp", "tftp", "sendmail", "mail", "mailx", "mutt", "s3cmd", "rclone", "smbclient", "nmap",
  "redis-cli", "mongosh", "mongo", "psql", "mysql", "git", "docker", "podman", "kubectl", "npm", "pnpm", "yarn",
  "twine", "gpg", "websocat", "aria2c", "axel", "transmission-cli",
]);

// A runner always needs ordinary approval unless a rule or grant covers its raw argv. Its option spellings and sources do not establish execution facts.
export function opaqueRunnerReason(argv: readonly (string | undefined)[]): string | null {
  const head = argv[wrapperPrefixLength(argv)];
  return head !== undefined && RUNNER_SET.has(runnerName(head)) ? "opaque runner prefix" : null;
}

const ARITHMETIC_TEST_OPERATORS = new Set(["-eq", "-ne", "-lt", "-le", "-gt", "-ge"]);
// An operand bash's arithmetic evaluates without looking anything up (`1`, `-2`, `0x1f`, `8`).
const ARITHMETIC_CONSTANT = /^\s*[-+]?(?:0[xX][0-9a-fA-F]+|\d+(?:#[0-9A-Za-z@_]+)?)\s*$/;

function arithmeticInWord(word: ShellWord): string | null {
  for (const part of word.parts) {
    if (part.kind === "arithmetic-data" && part.variables.length > 0) return `arithmetic evaluation of $${part.variables[0]}`;
    if (part.kind === "unknown" && /arithmetic|array index|parameter expansion/i.test(part.reason)) return part.reason;
    if (part.kind === "parameter-choice") {
      const nested = arithmeticInWord(part.operand);
      if (nested) return nested;
    }
  }
  return null;
}

// Reason this command evaluates a variable arithmetically, else null. Bash arithmetic evaluates a variable's VALUE as an expression, and an array subscript inside it runs command substitutions (`x='a[$(rm -rf y)]'; echo $((x))`), so `$((…))` with a variable operand, `[[ … -eq … ]]` with a non-constant operand, and opaque arithmetic or array-index expansions are hidden code. `()`, `let` and `declare -i` already lower to unsupported syntax. `echo $((1+2))` stays visible.
export function arithmeticEvaluationReason(cmd: ShellCommand): string | null {
  const words = [
    ...cmd.words,
    ...cmd.assignments.flatMap((assignment) => [assignment.value, ...(assignment.elements ?? [])]),
    ...cmd.redirects.flatMap((redirect) => [redirect.target, redirect.data].filter((word): word is ShellWord => word !== undefined)),
  ];
  for (const word of words) {
    const reason = arithmeticInWord(word);
    if (reason) return reason;
  }
  if (cmd.testForm === "double-bracket") {
    for (let index = 1; index + 1 < cmd.words.length; index += 1) {
      const operator = staticShellWord(cmd.words[index]!);
      if (operator === undefined || !ARITHMETIC_TEST_OPERATORS.has(operator)) continue;
      for (const operand of [cmd.words[index - 1]!, cmd.words[index + 1]!]) {
        const text = staticShellWord(operand);
        if (text === undefined || !ARITHMETIC_CONSTANT.test(text)) return `[[ ${operator} ]] evaluates ${operand.source.raw} arithmetically`;
      }
    }
  }
  return null;
}

// True when this argv (or the program behind a wrapper) can send data off the machine.
export function isNetworkProgram(argv: readonly (string | undefined)[]): boolean {
  const starts = argv[0] !== undefined && WRAPPER_SET.has(programName(argv[0])) ? argv.map((_, index) => index) : [0];
  return starts.some((start) => argv[start] !== undefined && NETWORK_PROGRAMS.has(programName(argv[start]!)));
}

// One parse per decision

// A shell command parsed once, with the facts the matcher and the floors derive from it memoized per cwd, so one `checkDetailed` call parses the command once instead of once per consumer.
export interface ParsedShellCommand {
  readonly command: string;
  readonly analysis: ShellAnalysis;
  // Set when the parser runtime threw (reported as unparseable).
  readonly parserError?: unknown;
  readonly facts: Map<string, unknown>;
}

export type ShellCommandInput = string | ParsedShellCommand;

export function parseShellCommand(command: string): ParsedShellCommand {
  if (command.length > MAX_LITERAL_COMMAND_LENGTH) return { command, analysis: { ok: false, reason: "literal command length limit exceeded" }, facts: new Map() };
  try {
    return { command, analysis: analyzeShell(command, "bash", { totalTokens: MAX_SHELL_ANALYSIS_TOKENS }), facts: new Map() };
  } catch (error) {
    return { command, analysis: { ok: false, reason: "shell parser failed" }, parserError: error, facts: new Map() };
  }
}

export function asParsedShellCommand(input: ShellCommandInput): ParsedShellCommand {
  return typeof input === "string" ? parseShellCommand(input) : input;
}

// `compute` once per parsed command and key.
export function shellFact<T>(parsed: ParsedShellCommand, key: string, compute: () => T): T {
  if (parsed.facts.has(key)) return parsed.facts.get(key) as T;
  const value = compute();
  parsed.facts.set(key, value);
  return value;
}
