// Broad shell prefixes may receive exact one-call consent but never persistent prefix allows; deny/ask rules remain unrestricted.

import { analyzeShell, staticShellWord, type ShellAnalysis, type ShellCommand, type ShellWord } from "../../shared/shell-analysis.js";

import { SHELLS, INTERPRETERS, WRAPPERS, STRING_JOINING_WRAPPERS, RUNNER_COMMAND_PREFIXES, PACKAGE_RUNNERS, runnerHasPrefix, BANNED_PREFIX_SUGGESTIONS, isDestructiveShellArgv, noReusableRuleReason, SHELL_SET, INTERPRETER_SET, WRAPPER_SET, RUNNER_SET, programName, runnerName, literalCommandAfterPrefix, refusedShellPrefix, codeLauncherName, MAX_LITERAL_COMMAND_LENGTH } from "./shell-prefix-values.js";
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
}
const WRAPPER_GRAMMAR: Readonly<Record<string, WrapperGrammar>> = {
  xargs: { flags: ["-0", "-r", "-t", "-x", "-p", "--null", "--no-run-if-empty", "--verbose", "--exit", "--interactive"], values: ["-I", "-L", "-n", "-P", "-s", "-d", "-E", "-a", "--arg-file", "--delimiter", "--max-args", "--max-procs", "--replace"] },
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

// The inner argv boundary or a wrapper's explicit shell-command payload. Uncertain positions retain floor-only candidates, never an allow-rule boundary. Setup values retain proven arity. At most sixteen wrappers are followed.
export function wrapperCommand(argv: readonly (string | undefined)[]): { index: number; code?: { text: string | undefined }; ordinaryAsk?: string; candidates?: number[]; nestedDialect?: true } {
  let index = 0;
  let ordinaryAsk: string | undefined;
  let candidateFrom: number | undefined;
  const finish = (at: number, code?: { text: string | undefined }) => ({
    index: at,
    ...(code ? { code } : {}),
    ...(ordinaryAsk ? { ordinaryAsk } : {}),
    ...(candidateFrom === undefined ? {} : { candidates: Array.from({ length: argv.length - candidateFrom }, (_, offset) => candidateFrom! + offset) }),
  });
  const inspectTail = (from: number) => {
    candidateFrom = Math.min(candidateFrom ?? from, from);
  };
  const uncertain = (from: number) => {
    inspectTail(from);
    return finish(argv.length);
  };
  for (let guard = 0; guard < 16 && index < argv.length; guard += 1) {
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
    let operand = grammar.operand;
    let options = true;
    let shell = grammar.shell;
    let payload: { index: number; text: string | undefined } | undefined;
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
            payload = { index: valueIndex, text };
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
    if (payload) return finish(payload.index, { text: payload.text });
    const tail = shell ? argv.slice(index) : [];
    if (shell && tail.some((token) => token === undefined || /[\s;&|<>$`\\(){}\[\]*?!~'"]/.test(token))) {
      const text = tail.every((token) => token !== undefined) ? tail.join(" ") : undefined;
      if (text === undefined) ordinaryAsk ??= "opaque wrapper code binding";
      return finish(index, { text });
    }
    if (shell && tail.length > 0) return { ...finish(index), nestedDialect: true };
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

// argv with a multi-verb tool's global options removed (`git -C. push` → `git push`). Deny/ask matching tries this form as well as the original, so a global option can never step a command around a restriction.
export function stripGlobalOptions(argv: readonly (string | undefined)[]): readonly (string | undefined)[] {
  const head = argv[0];
  if (head === undefined) return argv;
  const program = programName(head);
  const valueOptions = GLOBAL_VALUE_OPTIONS[program];
  if (!valueOptions) return argv;
  let index = 1;
  while (index < argv.length) {
    const token = argv[index];
    if (token === undefined || !token.startsWith("-")) break;
    if (token === "--") { index += 1; break; }
    index += valueOptions.has(token) ? 2 : 1;
  }
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

// Hidden code and credential-flow inspection The matcher and the exfiltration floor share interpreter, wrapper and network identities. Saved escape rules do not model program option safety.

// Arguments that make a shell or interpreter print and exit without running code.
const INFO_ONLY_ARGS = new Set(["--version", "--help"]);
const MAX_LITERAL_ARGV_WORDS = 1_024;

// Variables whose value is a command, a code path or a config that runs one (`GIT_SSH_COMMAND='rm x' git fetch`, `LESSOPEN`, `BASH_ENV`, `PATH`).
const CODE_CARRYING_VARIABLE = /^(?:GIT_SSH_COMMAND|GIT_SSH|GIT_EXTERNAL_DIFF|GIT_PAGER|GIT_EDITOR|GIT_SEQUENCE_EDITOR|GIT_ASKPASS|SSH_ASKPASS|GIT_PROXY_COMMAND|GIT_CONFIG_PARAMETERS|GIT_CONFIG_COUNT|GIT_CONFIG_(?:KEY|VALUE)_\d+|GIT_CONFIG|GIT_CONFIG_GLOBAL|GIT_CONFIG_SYSTEM|GIT_EXEC_PATH|GIT_TEMPLATE_DIR|GIT_DIR|PAGER|MANPAGER|EDITOR|VISUAL|LESS|LESSOPEN|LESSCLOSE|LESSKEY|LESSKEYIN|MORE|BASH_ENV|ENV|PROMPT_COMMAND|PS4|SHELLOPTS|BASHOPTS|IFS|LD_PRELOAD|LD_LIBRARY_PATH|DYLD_INSERT_LIBRARIES|DYLD_LIBRARY_PATH|NODE_OPTIONS|NODE_PATH|PYTHONSTARTUP|PYTHONPATH|PYTHONHOME|PERL5OPT|PERL5LIB|PERLLIB|RUBYOPT|RUBYLIB|BROWSER|RIPGREP_CONFIG_PATH|TAR_OPTIONS|FZF_DEFAULT_OPTS|BAT_PAGER|DELTA_PAGER|GH_PAGER|AWS_PAGER|PSQL_PAGER|SYSTEMD_PAGER|ZDOTDIR|HOME|PATH)$/;

// `NAME` when the variable carries code (see CODE_CARRYING_VARIABLE).
export function codeCarryingVariable(name: string): boolean {
  return CODE_CARRYING_VARIABLE.test(name);
}

function codeCarryingAssignment(args: readonly (string | undefined)[]): string | null {
  for (const arg of args) {
    const name = arg === undefined ? undefined : /^([A-Za-z_][A-Za-z0-9_]*)\+?=/.exec(arg)?.[1];
    if (name && CODE_CARRYING_VARIABLE.test(name)) return `code-carrying variable ${name}`;
  }
  return null;
}

// Editors and pagers whose command mode runs shell commands.
const EDITORS = new Set(["vi", "vim", "nvim", "gvim", "rvim", "view", "vimdiff", "ex", "ed", "red", "emacs", "emacsclient", "nano", "pico", "micro", "joe", "mcedit", "kak", "hx"]);
const NETWORK_PROGRAMS = new Set([
  "curl", "wget", "ssh", "scp", "sftp", "rsync", "openssl", "nc", "ncat", "netcat", "socat", "telnet", "nslookup",
  "dig", "host", "drill", "whois", "ping", "gh", "glab", "aws", "gcloud", "gsutil", "az", "http", "https", "xh",
  "httpie", "ftp", "lftp", "tftp", "sendmail", "mail", "mailx", "mutt", "s3cmd", "rclone", "smbclient", "nmap",
  "redis-cli", "mongosh", "mongo", "psql", "mysql", "git", "docker", "podman", "kubectl", "npm", "pnpm", "yarn",
  "twine", "gpg", "websocat", "aria2c", "axel", "transmission-cli",
]);

const LITERAL_VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*(?:\[\d+\])?$/;

// Options of `read` whose value is the next word (`-a` names an array, the rest are data).
const READ_VALUE_OPTIONS = new Set(["d", "i", "n", "N", "p", "t", "u"]);

// The words these builtins take as variable NAMES. Bash evaluates an array subscript in such a name arithmetically, and that evaluation runs command substitutions even from a quoted, otherwise static word (`read 'a[$(rm x)]'`, `printf -v 'a[$(rm x)]' 1`, `[ -v 'a[$(rm x)]' ]`).
function variableNameArgs(program: string, args: readonly (string | undefined)[]): (string | undefined)[] {
  const names: (string | undefined)[] = [];
  const after = (flag: RegExp): void => {
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index];
      if (arg === undefined || !flag.test(arg)) continue;
      const attached = arg.replace(flag, "");
      names.push(attached.length > 0 ? attached : args[index + 1]);
    }
  };
  switch (program) {
    case "read": {
      for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];
        if (arg === undefined) { names.push(arg); continue; }
        if (arg === "--") { names.push(...args.slice(index + 1)); break; }
        if (!arg.startsWith("-") || arg === "-") { names.push(arg); continue; }
        const letters = arg.slice(1);
        for (let at = 0; at < letters.length; at += 1) {
          const letter = letters[at]!;
          if (letter === "a" || READ_VALUE_OPTIONS.has(letter)) {
            const value = at + 1 < letters.length ? letters.slice(at + 1) : args[++index];
            if (letter === "a") names.push(value);
            break;
          }
        }
      }
      return names;
    }
    case "printf":
      after(/^-v/);
      return names;
    case "test": case "[": case "[[":
      after(/^-[vR]$/);
      return names;
    case "wait":
      after(/^-[A-Za-z]*p/);
      return names;
    case "getopts":
      return args.length >= 2 ? [args[1]] : [];
    case "unset":
      return args.filter((arg) => arg === undefined || !arg.startsWith("-"));
    case "mapfile": case "readarray":
      return args.length > 0 && (args.at(-1) === undefined || !args.at(-1)!.startsWith("-")) ? [args.at(-1)] : [];
    default:
      return names;
  }
}

function subscriptedNameReason(program: string, args: readonly (string | undefined)[]): string | null {
  for (const name of variableNameArgs(program, args)) {
    if (name === undefined) return `${program} takes a variable name the matcher cannot read`;
    if (!LITERAL_VARIABLE_NAME.test(name)) return `${program} evaluates the variable name ${name} (array subscripts run code)`;
  }
  return null;
}

// A runner always needs ordinary approval unless a rule or grant covers its raw argv. Its option spellings and sources do not establish execution facts.
export function opaqueRunnerReason(argv: readonly (string | undefined)[]): string | null {
  const head = argv[wrapperPrefixLength(argv)];
  return head !== undefined && RUNNER_SET.has(runnerName(head)) ? "opaque runner prefix" : null;
}

// Downstream command views for sink inspection only. Literal boundaries keep delegated runner identities; opaque options retain conservative candidates. Rules must retain the complete runner prefix and must not use this list.
export function runnerCommandIndexes(argv: readonly (string | undefined)[]): readonly number[] {
  let start = wrapperPrefixLength(argv);
  const head = argv[start];
  if (head === undefined || !RUNNER_SET.has(runnerName(head))) return [];
  const prefixes = RUNNER_COMMAND_PREFIXES[runnerName(head)]!;
  const prefixEnd = prefixes === true ? start : argv.findIndex((token, index) =>
    index > start && runnerHasPrefix(prefixes, token));
  if (prefixEnd < 0) return [];
  const candidates = argv.flatMap((token, index) =>
    index > prefixEnd && token !== undefined && !token.startsWith("-") ? [index] : []);
  while (start < argv.length) {
    const head = argv[start];
    if (head === undefined || !RUNNER_SET.has(runnerName(head))) break;
    const prefixes = RUNNER_COMMAND_PREFIXES[runnerName(head)]!;
    const literal = literalCommandAfterPrefix(argv, start + 1);
    const command = prefixes === true ? literal
      : literal !== undefined && runnerHasPrefix(prefixes, argv[literal]) ? literalCommandAfterPrefix(argv, literal + 1) : undefined;
    if (command === undefined) break;
    start = command;
    if (WRAPPER_SET.has(programName(argv[start]!))) {
      const wrapped = wrapperPrefixLength(argv.slice(start));
      if (wrapped > 0) start += wrapped;
    }
    const target = argv[start];
    if (target === undefined) break;
    const program = programName(target);
    // A proved non-runner interpreter owns its code arguments. Those words cannot also acquire another language's command catalogue meanings.
    if (!RUNNER_SET.has(runnerName(target)) && (INTERPRETER_SET.has(program)
      || (SHELL_SET.has(program) && !["pwsh", "powershell", "cmd"].includes(program)))) return candidates.filter((index) => index <= start);
  }
  return candidates;
}

// Script/code prefixes declare a language without interpreting runner options.
export function runnerCodeContext(argv: readonly (string | undefined)[]): { interpreter: string; operandIndex: number } | undefined {
  let start = wrapperPrefixLength(argv);
  while (start < argv.length) {
    const head = argv[start];
    if (head === undefined) break;
    const prefixes = RUNNER_COMMAND_PREFIXES[runnerName(head)];
    if (prefixes === undefined) break;
    const index = literalCommandAfterPrefix(argv, start + 1);
    if (index === undefined) break;
    const prefix = prefixes === true ? undefined : prefixes.find((value) => (typeof value === "string" ? value : value[0]) === argv[index]);
    if (prefix !== undefined && typeof prefix !== "string") return { interpreter: prefix[1], operandIndex: index + 1 };
    const command = prefixes === true ? index : prefix !== undefined ? literalCommandAfterPrefix(argv, index + 1) : undefined;
    if (command === undefined) break;
    start = command + wrapperPrefixLength(argv.slice(command));
  }
  return undefined;
}

function hiddenCodeAt(argv: readonly (string | undefined)[], start: number): string | null {
  const head = argv[start];
  if (head === undefined) return null;
  const program = programName(head);
  const args = argv.slice(start + 1);
  if (isShellWrapperProgram(head)) {
    if (program === "eval") return args.length > 0 ? "code passed to eval" : null;
    if (program === "source" || program === ".") return args.length > 0 ? `script passed to ${program}` : null;
    if (program === "env" && args.some((arg) => arg !== undefined && /^(?:-[A-Za-z]*S|--split-string)/.test(arg))) return "code passed to env -S";
    if (wrapperCommand(argv.slice(start)).code) {
      return `code passed to ${program}`;
    }
    if (STRING_JOINING_WRAPPERS.has(program) && args.some((arg) => arg === undefined || /[\s;&|$`<>()]/.test(arg))) {
      return `code string passed to ${program}`;
    }
    const boundary = wrapperCommand(argv.slice(start)).index;
    return codeCarryingAssignment(args.slice(0, Math.max(0, boundary - 1)));
  }
  const launcher = codeLauncherName(head);
  if (launcher !== null) {
    if (args.length > 0 && args.every((arg) => arg !== undefined && INFO_ONLY_ARGS.has(arg))) return null;
    return args.length === 0 ? `${launcher} reads code from stdin` : `code passed to ${launcher}`;
  }
  if (RUNNER_SET.has(runnerName(head))) {
    return args.some((arg) => arg !== undefined && /^(?:--call(?:=|$)|-c(?:$|[^-]))/.test(arg)) ? "code passed to runner" : null;
  }
  if (EDITORS.has(program)) return `${program} can run commands`;
  const first = args[0];
  switch (program) {
    case "trap":
      return args.length > 0 && first !== "-l" && first !== "-p" && first !== "-" ? "code passed to trap" : null;
    case "hash":
      return args.some((arg) => arg === undefined || /^-[A-Za-z]*p/.test(arg)) ? "hash -p rebinds a command name" : null;
    case "alias":
      return args.some((arg) => arg === undefined || arg.includes("=")) ? "alias defines a command" : null;
    case "enable":
      return args.some((arg) => arg === undefined || /^-[A-Za-z]*f/.test(arg)) ? "enable -f loads a builtin" : null;
    case "bind":
      return args.some((arg) => arg === undefined || /^-[A-Za-z]*x/.test(arg)) ? "bind -x binds a command" : null;
    case "mapfile": case "readarray":
      if (args.some((arg) => arg === undefined || /^-[A-Za-z]*C/.test(arg))) return `${program} -C runs a callback`;
      break;
    case "complete": case "compgen":
      return args.some((arg) => arg === undefined || /^-[A-Za-z]*[CF]/.test(arg)) ? `${program} runs a command` : null;
    case "fc":
      return "fc re-runs history";
    case "at": case "batch":
      return first === "-l" ? null : `${program} runs code from stdin`;
    case "crontab":
      return args.length === 1 && first === "-l" ? null : "crontab installs commands";
    case "launchctl":
      return first !== undefined && ["list", "print", "version", "help"].includes(first) ? null : "launchctl runs jobs";
    case "tmux": case "screen":
      return `${program} runs commands`;
    case "export": case "declare": case "typeset": case "local": case "readonly":
      return codeCarryingAssignment(args);
    default:
      break;
  }
  const subscript = subscriptedNameReason(program, args);
  if (subscript) return subscript;
  return null;
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

// Reason this argv runs code the matcher cannot read. Follow declared runner command positions without inspecting code operands.
export function hiddenCodeReason(argv: readonly (string | undefined)[]): string | null {
  const wrapper = wrapperCommand(argv);
  const inner = wrapper.index;
  if (!wrapper.code && inner > 0 && inner < argv.length && argv[inner] === undefined) return "dynamic program name behind a wrapper";
  const wrapperStarts = argv[0] !== undefined && isShellWrapperProgram(argv[0]) ? argv.map((_, index) => index) : [0];
  const runner = opaqueRunnerReason(argv) !== null && (argv[inner] === undefined || codeLauncherName(argv[inner]!) === null);
  const visibleArgv = argv;
  const starts = runner ? wrapperStarts.filter((start) => start <= inner) : wrapperStarts;
  for (const start of starts) {
    const reason = hiddenCodeAt(visibleArgv, start);
    if (reason) return reason;
  }
  let command = inner;
  for (let depth = 0; depth < 16; depth += 1) {
    const head = argv[command];
    if (head === undefined) break;
    const prefixes = RUNNER_COMMAND_PREFIXES[runnerName(head)];
    if (prefixes === undefined) break;
    const verb = literalCommandAfterPrefix(argv, command + 1);
    if (verb === undefined) break;
    const selected = prefixes === true ? undefined : prefixes.find((prefix) =>
      (typeof prefix === "string" ? prefix : prefix[0]) === argv[verb]?.toLowerCase());
    if (selected !== undefined && typeof selected !== "string") {
      const reason = hiddenCodeAt([selected[1], ...argv.slice(verb + 1)], 0);
      if (reason) return reason;
      break;
    }
    const delegated = prefixes === true ? verb : runnerHasPrefix(prefixes, argv[verb]) ? literalCommandAfterPrefix(argv, verb + 1) : undefined;
    if (delegated === undefined) break;
    command = delegated + wrapperPrefixLength(argv.slice(delegated));
    const reason = hiddenCodeAt(argv, command);
    if (reason) return reason;
    if (depth === 15) return "runner analysis limit exceeded";
  }
  return null;
}

// Uncertain wrapper and runner command boundaries cannot establish literal execution.
export function literalInvocationReason(argv: readonly (string | undefined)[]): string | null {
  if (argv.length > MAX_LITERAL_ARGV_WORDS) return "literal argv word limit exceeded";
  let start = 0;
  for (let depth = 0; depth < 16; depth += 1) {
    const wrapper = wrapperCommand(argv.slice(start));
    if (wrapper.ordinaryAsk !== undefined) return wrapper.ordinaryAsk;
    if (wrapper.nestedDialect) return "nested shell dialect";
    start += wrapper.index;
    const head = argv[start];
    if (head === undefined) return null;
    const prefixes = RUNNER_COMMAND_PREFIXES[runnerName(head)];
    if (prefixes === undefined) return null;
    const args = argv.slice(start + 1);
    if (runnerName(head) === "npm" && args[0] === "explore") return "code passed to runner";
    if (args.length > 0 && args.every((arg) => arg !== undefined && INFO_ONLY_ARGS.has(arg))) return null;
    const verb = literalCommandAfterPrefix(argv, start + 1);
    if (verb === undefined) return "unproven runner command binding";
    if (prefixes !== true && !runnerHasPrefix(prefixes, argv[verb])) return null;
    const delegated = prefixes === true ? verb : literalCommandAfterPrefix(argv, verb + 1);
    if (delegated === undefined) return "unproven runner command binding";
    if (argv[delegated] === undefined || /[\s;&|<>$`'"()]/.test(argv[delegated]!)) return "unproven runner command binding";
    start = delegated;
  }
  return "runner analysis limit exceeded";
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
    return { command, analysis: analyzeShell(command, "bash"), facts: new Map() };
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
