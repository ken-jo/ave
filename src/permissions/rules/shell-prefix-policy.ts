/**
 * Shell prefix policy (issue #28, P1a): the single refused-prefix list and the
 * pure arity-table suggestion used by the dock and validated on every write.
 *
 * A refused prefix can still be approved once or for the session; it can never
 * become a persistent `Bash(<prefix> *)` allow rule. Deny and ask rules are not
 * restricted — `Bash(sudo *)` as a deny rule is useful.
 */

import { analyzeShell, staticShellWord, type ShellAnalysis, type ShellCommand, type ShellWord } from "../../shared/shell-analysis.js";

import { SHELLS, INTERPRETERS, WRAPPERS, STRING_JOINING_WRAPPERS, RUNNER_COMMAND_PREFIXES, PACKAGE_RUNNERS, runnerHasPrefix, WILDCARD_PREFIX_CATALOG, wildcardCatalogKey, SHELL_SET, INTERPRETER_SET, WRAPPER_SET, RUNNER_SET, programName, runnerName, literalCommandAfterPrefix, refusedShellPrefix } from "./shell-prefix-values.js";
export { refusedShellPrefix } from "./shell-prefix-values.js";

/**
 * Setup operands, value options and shell-command options share one grammar.
 * A command view widens inspection and restrictions, never allow coverage.
 */
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
  // https://man7.org/linux/man-pages/man1/script.1.html: optional log file, -c text or -- argv.
  // https://raw.githubusercontent.com/freebsd/freebsd-src/main/usr.bin/script/script.1: recording setup operands, file then argv.
  // https://raw.githubusercontent.com/apple-oss-distributions/shell_cmds/main/script/script.1: alternate -F flush arity stays visible to floor scans.
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

/**
 * The inner argv boundary or a wrapper's explicit shell-command payload.
 * Uncertain positions retain floor-only candidates, never an allow-rule boundary.
 * Setup values retain proven arity.
 * At most sixteen wrappers are followed.
 */
export function wrapperCommand(argv: readonly (string | undefined)[]): { index: number; code?: { text: string | undefined }; ordinaryAsk?: string; candidates?: number[] } {
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
    const program = programName(head);
    // `eval` / `source` / `.` run a string or file: they are code carriers,
    // not transparent wrappers.
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
              // A setup operand is provisional when the remaining grammar is
              // unknown. Keep it and every later word visible to floor scans.
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
  }
  const next = argv[index];
  if (index < argv.length && (next === undefined || WRAPPER_SET.has(programName(next)))) {
    ordinaryAsk ??= "wrapper analysis limit exceeded";
    return uncertain(index);
  }
  return finish(index);
}

/** Shared boundary for deny/ask matching, inline-code and sink inspection. */
export function wrapperPrefixLength(argv: readonly (string | undefined)[]): number {
  return wrapperCommand(argv).index;
}

/** Value-taking global options of multi-verb tools (before the verb). */
const GLOBAL_VALUE_OPTIONS: Readonly<Record<string, ReadonlySet<string>>> = {
  git: new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--config-env", "--exec-path"]),
  docker: new Set(["-H", "--host", "--context", "-c", "--config", "-l", "--log-level", "--tlscacert", "--tlscert", "--tlskey"]),
  kubectl: new Set(["-n", "--namespace", "--context", "--cluster", "--user", "-s", "--server", "--kubeconfig", "--token"]),
};

/**
 * argv with a multi-verb tool's global options removed (`git -C . push` →
 * `git push`). Deny/ask matching tries this form as well as the original, so
 * a global option can never step a command around a restriction.
 */
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

/**
 * Pure suggestion for one simple command: the arity-table prefix of its static
 * argv. Returns `null` when no persistent suggestion is allowed (dynamic
 * argv0, or the derived prefix is refused) — the dock then offers once /
 * session only.
 */
export function suggestShellPrefix(argv: readonly (string | undefined)[]): string[] | null {
  const statics: string[] = [];
  for (const token of argv) {
    if (token === undefined) break;
    statics.push(token);
  }
  if (statics.length === 0) return null;
  // Only an allowlisted program/verb gets a wildcard; anything else is exact-only.
  const key = wildcardCatalogKey(statics);
  if (key === null) return null;
  const keyLength = key.split(" ").length;
  const arity = WILDCARD_PREFIX_CATALOG.get(key)!;
  const prefix: string[] = [];
  for (let index = 0; index < Math.min(arity, statics.length); index += 1) {
    const token = statics[index]!;
    // Past the catalog key, options and paths are arguments, not verbs: stop there.
    if (index >= keyLength && (token.startsWith("-") || /[\\/=]/.test(token))) break;
    prefix.push(token);
  }
  if (prefix.length < arity) return null;
  if (prefix.some((token) => /[\s;&|<>()$`'"\\*?[\]{}#~!]/.test(token))) return null;
  return refusedShellPrefix(prefix) === null ? prefix : null;
}

/** Exposed for the design doc and tests; do not fork these lists elsewhere. */
export const SHELL_PREFIX_POLICY = Object.freeze({
  shells: Object.freeze([...SHELLS]),
  interpreters: Object.freeze([...INTERPRETERS]),
  wrappers: Object.freeze([...WRAPPERS]),
  packageRunners: Object.freeze([...PACKAGE_RUNNERS]),
  wildcardCatalog: WILDCARD_PREFIX_CATALOG,
});

/** Used by deny/ask matching to look through wrappers (it only ever widens a deny). */
export function isShellWrapperProgram(token: string): boolean {
  return WRAPPER_SET.has(programName(token));
}

// ─── Hidden code and option effects ─────────────────────────────────────
// One program table for the rule matcher and the exfiltration floor: which
// invocations run code the matcher cannot read, which options make an
// otherwise read-only program execute or write, and which programs can send
// data off the machine.

/** Arguments that make a shell or interpreter print and exit without running code. */
const INFO_ONLY_ARGS = new Set(["--version", "--help"]);

/**
 * Variables whose value is a command, a code path or a config that runs one
 * (`GIT_SSH_COMMAND='rm x' git fetch`, `LESSOPEN`, `BASH_ENV`, `PATH`).
 */
const CODE_CARRYING_VARIABLE = /^(?:GIT_SSH_COMMAND|GIT_SSH|GIT_EXTERNAL_DIFF|GIT_PAGER|GIT_EDITOR|GIT_SEQUENCE_EDITOR|GIT_ASKPASS|SSH_ASKPASS|GIT_PROXY_COMMAND|GIT_CONFIG_PARAMETERS|GIT_CONFIG_COUNT|GIT_CONFIG_(?:KEY|VALUE)_\d+|GIT_CONFIG|GIT_CONFIG_GLOBAL|GIT_CONFIG_SYSTEM|GIT_EXEC_PATH|GIT_TEMPLATE_DIR|GIT_DIR|PAGER|MANPAGER|EDITOR|VISUAL|LESS|LESSOPEN|LESSCLOSE|LESSKEY|LESSKEYIN|MORE|BASH_ENV|ENV|PROMPT_COMMAND|PS4|SHELLOPTS|BASHOPTS|IFS|LD_PRELOAD|LD_LIBRARY_PATH|DYLD_INSERT_LIBRARIES|DYLD_LIBRARY_PATH|NODE_OPTIONS|NODE_PATH|PYTHONSTARTUP|PYTHONPATH|PYTHONHOME|PERL5OPT|PERL5LIB|PERLLIB|RUBYOPT|RUBYLIB|BROWSER|RIPGREP_CONFIG_PATH|TAR_OPTIONS|FZF_DEFAULT_OPTS|BAT_PAGER|DELTA_PAGER|GH_PAGER|AWS_PAGER|PSQL_PAGER|SYSTEMD_PAGER|ZDOTDIR|HOME|PATH)$/;

/** `NAME` when the variable carries code (see {@link CODE_CARRYING_VARIABLE}). */
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

/** Editors and pagers whose command mode runs shell commands. */
const EDITORS = new Set(["vi", "vim", "nvim", "gvim", "rvim", "view", "vimdiff", "ex", "ed", "red", "emacs", "emacsclient", "nano", "pico", "micro", "joe", "mcedit", "kak", "hx"]);
const NETWORK_PROGRAMS = new Set([
  "curl", "wget", "ssh", "scp", "sftp", "rsync", "openssl", "nc", "ncat", "netcat", "socat", "telnet", "nslookup",
  "dig", "host", "drill", "whois", "ping", "gh", "glab", "aws", "gcloud", "gsutil", "az", "http", "https", "xh",
  "httpie", "ftp", "lftp", "tftp", "sendmail", "mail", "mailx", "mutt", "s3cmd", "rclone", "smbclient", "nmap",
  "redis-cli", "mongosh", "mongo", "psql", "mysql", "git", "docker", "podman", "kubectl", "npm", "pnpm", "yarn",
  "twine", "gpg", "websocat", "aria2c", "axel", "transmission-cli",
]);

export type ShellOptionEffect = { kind: "exec" | "write"; reason: string };

/**
 * Options that make an otherwise allowed program write to a path of the
 * model's choosing (`git log --output=~/.zshrc`, `curl -o`, `sort -o`).
 */
const WRITING_LONG_OPTION = /^--(?:output(?:-file|-document|-dir)?|log-file|logfile|outfile|out-file|out|dump-header)(?:=|$)/;
const SHORT_OUTPUT_PROGRAMS = new Set(["curl", "wget", "sort", "gcc", "g++", "cc", "clang", "clang++", "go", "rustc", "tsc", "esbuild", "pandoc", "uniq", "split", "sqlite3"]);
const FIND_WRITING_ACTIONS = /^-(?:fprint|fprint0|fprintf|fls|delete)$/;
const FIND_EXEC_ACTIONS = /^-(?:exec|execdir|ok|okdir)$/;
const TAR_VALUE_SHORTS = "bCfFgHIKLNTVX";

function longOptionIs(flag: string, names: readonly string[], minimum = 6): boolean {
  return names.some((name) => name === flag || (flag.length >= minimum && name.startsWith(flag)));
}

const exec = (reason: string): ShellOptionEffect => ({ kind: "exec", reason });
const write = (reason: string): ShellOptionEffect => ({ kind: "write", reason });
const worse = (a: ShellOptionEffect | null, b: ShellOptionEffect | null): ShellOptionEffect | null =>
  a?.kind === "exec" ? a : b?.kind === "exec" ? b : a ?? b;

/** Index after a sed address at `index`, or `index` when there is none. */
function skipSedAddress(script: string, index: number): number {
  const rest = script.slice(index);
  const simple = /^(?:\d+(?:~\d+)?|\$)/.exec(rest);
  if (simple) return index + simple[0].length;
  const delimiter = rest[0] === "/" ? "/" : rest[0] === "\\" && rest[1] ? rest[1] : undefined;
  if (!delimiter) return index;
  let cursor = index + (rest[0] === "/" ? 1 : 2);
  while (cursor < script.length && script[cursor] !== delimiter) cursor += script[cursor] === "\\" ? 2 : 1;
  if (cursor >= script.length) return -1;
  cursor += 1;
  while (script[cursor] === "I" || script[cursor] === "M") cursor += 1;
  return cursor;
}

/**
 * Effect of a sed script. Only addresses with the print/delete/quit/hold
 * family, `s///` with plain flags and `y///` are read-only; `e`, `s///e`
 * execute; `w`/`W`/`r`/`R`, `s///w` touch files; anything else is unproven.
 */
function sedScriptEffect(script: string): ShellOptionEffect | null {
  const unproven = write("sed script is not provably read-only");
  let worst: ShellOptionEffect | null = null;
  let index = 0;
  const skipBlank = (): void => { while (index < script.length && /[\s;]/.test(script[index]!)) index += 1; };
  for (;;) {
    skipBlank();
    if (index >= script.length) return worst;
    index = skipSedAddress(script, index);
    if (index < 0) return worse(worst, unproven);
    if (script[index] === ",") {
      index += 1;
      const step = /^[+~]\d+/.exec(script.slice(index));
      index = step ? index + step[0].length : skipSedAddress(script, index);
      if (index < 0) return worse(worst, unproven);
    }
    while (script[index] === " " || script[index] === "!") index += 1;
    const command = script[index];
    if (command === undefined) return worst;
    if ("pdDqQ=nNgGhHxlzPF".includes(command)) {
      index += 1;
      while (/\d/.test(script[index] ?? "")) index += 1;
      while (script[index] === " " || script[index] === "\t") index += 1;
      if (index < script.length && !/[;\n]/.test(script[index]!)) return worse(worst, unproven);
      continue;
    }
    if (command === "s" || command === "y") {
      const delimiter = script[index + 1];
      if (!delimiter || delimiter === "\\" || delimiter === "\n") return worse(worst, unproven);
      let cursor = index + 2;
      for (let part = 0; part < 2; part += 1) {
        while (cursor < script.length && script[cursor] !== delimiter) cursor += script[cursor] === "\\" ? 2 : 1;
        if (cursor >= script.length) return worse(worst, unproven);
        cursor += 1;
      }
      index = cursor;
      if (command === "s") {
        while (/[A-Za-z0-9]/.test(script[index] ?? "")) {
          const flag = script[index]!;
          if (flag === "e") return exec("sed s///e runs the result as a command");
          if (flag === "w") return worse(worst, write("sed s///w writes a file"));
          if (!/[gpiImM0-9]/.test(flag)) return worse(worst, unproven);
          index += 1;
        }
      }
      continue;
    }
    if (command === "e") return exec("sed e runs a command");
    if ("wWrR".includes(command)) {
      worst = worse(worst, write(`sed ${command} reads or writes a file`));
      while (index < script.length && script[index] !== "\n") index += 1;
      continue;
    }
    return worse(worst, unproven);
  }
}

function sedEffect(args: readonly (string | undefined)[]): ShellOptionEffect | null {
  const scripts: (string | undefined)[] = [];
  const positional: (string | undefined)[] = [];
  let explicitScript = false;
  let worst: ShellOptionEffect | null = null;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined || !arg.startsWith("-") || arg === "-") { positional.push(arg); continue; }
    if (arg === "--") { positional.push(...args.slice(index + 1)); break; }
    if (arg.startsWith("--")) {
      const [name, ...value] = arg.split("=");
      const inline = value.length > 0 ? value.join("=") : undefined;
      if (longOptionIs(name!, ["--expression"], 3)) {
        explicitScript = true;
        scripts.push(inline ?? args[++index]);
      } else if (longOptionIs(name!, ["--file"], 4)) {
        return exec("sed script file");
      } else if (longOptionIs(name!, ["--in-place"], 3)) {
        worst = worse(worst, write("sed -i edits files in place"));
      } else if (longOptionIs(name!, ["--line-length"], 3) && inline === undefined) {
        index += 1;
      }
      continue;
    }
    for (let letter = 1; letter < arg.length; letter += 1) {
      const flag = arg[letter]!;
      if (flag === "i") { worst = worse(worst, write("sed -i edits files in place")); break; }
      if (flag === "f") return exec("sed script file");
      if (flag === "e") {
        explicitScript = true;
        scripts.push(letter + 1 < arg.length ? arg.slice(letter + 1) : args[++index]);
        break;
      }
      if (flag === "l") { if (letter + 1 === arg.length) index += 1; break; }
    }
  }
  if (!explicitScript && positional.length > 0) scripts.push(positional[0]);
  for (const script of scripts) {
    worst = worse(worst, script === undefined ? exec("dynamic sed script") : sedScriptEffect(script));
    if (worst?.kind === "exec") return worst;
  }
  return worst;
}

function tarEffect(args: readonly (string | undefined)[]): ShellOptionEffect | null {
  let worst: ShellOptionEffect | null = null;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) continue;
    if (arg.startsWith("--")) {
      const name = arg.split("=")[0]!;
      if (longOptionIs(name, ["--to-command", "--use-compress-program", "--checkpoint-action", "--info-script", "--new-volume-script", "--rsh-command", "--rmt-command"])) {
        return exec(`tar ${name} runs a command`);
      }
      if (longOptionIs(name, ["--extract", "--get", "--create", "--append", "--update", "--delete", "--catenate", "--concatenate", "--remove-files"])) {
        worst = worse(worst, write(`tar ${name} writes files`));
      }
      continue;
    }
    // Old-style bundled first argument (`tar xf a.tar`).
    const letters = arg.startsWith("-") ? arg.slice(1) : index === 0 ? arg : "";
    for (const letter of letters) {
      if (letter === "I" || letter === "F") return exec(`tar -${letter} runs a command`);
      if ("xcruA".includes(letter)) worst = worse(worst, write(`tar -${letter} writes files`));
      if (TAR_VALUE_SHORTS.includes(letter)) break;
    }
  }
  return worst;
}

const GIT_EXEC_LONG = ["--ext-diff", "--textconv", "--config-env", "--exec", "--upload-pack", "--receive-pack", "--extcmd", "--open-files-in-pager", "--sendmail-cmd", "--to-cmd", "--exec-path"];
const GIT_EXEC_VERBS = new Set(["difftool", "mergetool", "filter-branch", "instaweb", "web--browse", "credential"]);

function gitEffect(args: readonly (string | undefined)[]): ShellOptionEffect | null {
  const verbArgs = stripGlobalOptions(["git", ...args]).slice(1);
  const verb = verbArgs[0];
  if (verb !== undefined && GIT_EXEC_VERBS.has(verb)) return exec(`git ${verb} runs configured commands`);
  if ((verb === "submodule" && verbArgs.includes("foreach")) || (verb === "bisect" && verbArgs[1] === "run")) {
    return exec(`git ${verb} runs a command`);
  }
  if (verb === "config") return write("git config changes configuration");
  for (const arg of args) {
    if (arg === undefined) continue;
    if (arg === "-c" || /^-c.+=/.test(arg)) return exec("git -c sets configuration that can run commands");
    const name = arg.split("=")[0]!;
    if (name === "--exec-path" && !arg.includes("=")) continue;
    if (name.startsWith("--") && !name.startsWith("--no-") && longOptionIs(name, GIT_EXEC_LONG, 7)) return exec(`git ${name} runs a command`);
    if (arg === "-O" || /^-O./.test(arg)) return exec("git -O runs a pager command");
    if (/^-[A-Za-z]*x/.test(arg) && (verb === "rebase" || verb === "difftool")) return exec(`git ${verb} -x runs a command`);
    if (/^-[A-Za-z]*u/.test(arg) && (verb === "clone" || verb === "fetch" || verb === "pull" || verb === "ls-remote" || verb === "archive")) {
      return exec(`git ${verb} -u runs an upload-pack command`);
    }
  }
  return null;
}

function sshFamilyEffect(program: string, args: readonly (string | undefined)[]): ShellOptionEffect | null {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined || !arg.startsWith("-")) continue;
    if (/^-[A-Za-z]*o/.test(arg)) {
      const value = arg.replace(/^-[A-Za-z]*o/, "") || args[index + 1] || "";
      if (/(?:proxy|local|knownhosts)command|permitlocalcommand/i.test(value)) return exec(`${program} -o runs a local command`);
    }
    if (/^-[A-Za-z]*F/.test(arg)) return exec(`${program} -F reads a config that can run commands`);
    if (program !== "ssh" && /^-[A-Za-z]*[SD]/.test(arg)) return exec(`${program} -S runs a program`);
  }
  return null;
}

/**
 * Per-program code-exec and write options. `exec` options run a command the
 * matcher cannot see (deny/ask treat the call as hidden); `write` options
 * write or edit a path. An allow rule never covers either.
 */
export function shellOptionEffect(argv: readonly (string | undefined)[]): ShellOptionEffect | null {
  const head = argv[0];
  if (head === undefined) return null;
  if (RUNNER_SET.has(runnerName(head))) return null;
  const program = programName(head);
  const args = argv.slice(1, opaqueRunnerReason(argv) ? wrapperPrefixLength(argv) : argv.length);
  let effect: ShellOptionEffect | null = null;
  switch (program) {
    case "sed": case "gsed": effect = sedEffect(args); break;
    case "tar": case "gtar": case "bsdtar": effect = tarEffect(args); break;
    case "git": effect = gitEffect(args); break;
    case "ssh": case "scp": case "sftp": effect = sshFamilyEffect(program, args); break;
    case "rg":
      if (args.some((arg) => arg !== undefined && /^--pre(?:-glob)?(?:=|$)/.test(arg))) effect = exec("rg --pre runs a command");
      // `--hostname-bin` runs a program to learn the hostname for hyperlinks.
      else if (args.some((arg) => arg !== undefined && /^--hostname-bin(?:=|$)/.test(arg))) effect = exec("rg --hostname-bin runs a command");
      break;
    case "less": case "more": case "most":
      if (args.some((arg) => arg !== undefined && arg.startsWith("+") && /[!|]/.test(arg))) effect = exec(`${program} + runs a shell command`);
      else if (args.some((arg) => arg !== undefined && (/^-[A-Za-z]*k/.test(arg) || arg.startsWith("--lesskey")))) effect = exec(`${program} lesskey file`);
      else if (args.some((arg) => arg !== undefined && (/^-[A-Za-z]*[oO]/.test(arg) || /^--(?:log-file|LOG-FILE)/.test(arg)))) effect = write(`${program} -o writes a file`);
      break;
    case "find":
      if (args.some((arg) => arg === undefined || FIND_EXEC_ACTIONS.test(arg))) effect = exec("command passed to find -exec");
      else {
        const action = args.find((arg) => arg !== undefined && FIND_WRITING_ACTIONS.test(arg));
        if (action) effect = write(`find ${action} writes or deletes`);
      }
      break;
    case "fd": case "fdfind":
      if (args.some((arg) => arg !== undefined && /^(?:-[A-Za-z]*[xX]|--exec(?:-batch)?)(?:=|$)/.test(arg))) effect = exec("fd --exec runs a command");
      break;
    case "man":
      if (args.some((arg) => arg !== undefined && (/^-[A-Za-z]*[PH]/.test(arg) || /^--(?:pager|html|browser)/.test(arg)))) effect = exec("man --pager runs a command");
      break;
    case "rsync":
      if (args.some((arg) => arg !== undefined && (/^-[A-Za-z]*e/.test(arg) || /^--(?:rsh|rsync-path)(?:=|$)/.test(arg)))) effect = exec("rsync -e runs a command");
      break;
    case "zip":
      if (args.some((arg) => arg !== undefined && (arg === "-TT" || /^--unzip-command/.test(arg)))) effect = exec("zip -TT runs a command");
      break;
    case "tcpdump":
      if (args.some((arg) => arg !== undefined && /^-[A-Za-z]*z/.test(arg))) effect = exec("tcpdump -z runs a command");
      break;
    case "wget":
      if (args.some((arg) => arg !== undefined && /^--use-askpass/.test(arg))) effect = exec("wget --use-askpass runs a command");
      break;
    case "fzf":
      if (args.some((arg) => arg !== undefined && /^--(?:preview|bind)/.test(arg))) effect = exec("fzf runs a command");
      break;
    case "ack": case "ag": case "bat": case "batcat": case "delta":
      if (args.some((arg) => arg !== undefined && /^--pager/.test(arg))) effect = exec(`${program} --pager runs a command`);
      break;
    case "sort": case "gsort":
      if (args.some((arg) => arg === undefined || /^--compress-prog(?:r(?:a(?:m)?)?)?(?:=|$)/.test(arg))) effect = exec("sort --compress-program runs a program");
      break;
    case "xxd": {
      // `xxd [options] [infile [outfile]]`: a second operand is written; `-r` patches it in place.
      let operands = 0;
      for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];
        if (arg !== undefined && /^-(?:c|g|l|o|s|n|cols|groupsize|len|offset|seek|name)$/.test(arg)) { index += 1; continue; }
        if (arg === undefined || !arg.startsWith("-") || arg === "-") operands += 1;
      }
      if (operands >= 2) effect = write("xxd writes its second operand");
      break;
    }
    default:
      break;
  }
  if (effect?.kind === "exec") return effect;
  for (const token of args) {
    if (token === undefined) continue;
    if (WRITING_LONG_OPTION.test(token)) return worse(effect, write(`option ${token.split("=")[0]} writes to a path`));
    if (SHORT_OUTPUT_PROGRAMS.has(program) && /^-[A-Za-z]*[oO]/.test(token)) return worse(effect, write(`option ${token.slice(0, 2)} writes to a path`));
  }
  return effect;
}

/** Reason the command at `argv[start]` runs code the matcher cannot read, else null. */
/** A variable name bash takes literally: no subscript, or a constant integer one. */
const LITERAL_VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*(?:\[\d+\])?$/;

/** Options of `read` whose value is the next word (`-a` names an array, the rest are data). */
const READ_VALUE_OPTIONS = new Set(["d", "i", "n", "N", "p", "t", "u"]);

/**
 * The words these builtins take as variable NAMES. Bash evaluates an array
 * subscript in such a name arithmetically, and that evaluation runs command
 * substitutions even from a quoted, otherwise static word
 * (`read 'a[$(rm x)]'`, `printf -v 'a[$(rm x)]' 1`, `[ -v 'a[$(rm x)]' ]`).
 */
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

/**
 * A runner always needs ordinary approval unless a rule or grant covers its
 * raw argv. Its option spellings and sources do not establish execution facts.
 */
export function opaqueRunnerReason(argv: readonly (string | undefined)[]): string | null {
  const head = argv[wrapperPrefixLength(argv)];
  return head !== undefined && RUNNER_SET.has(runnerName(head)) ? "opaque runner prefix" : null;
}

/**
 * Downstream command views for sink inspection only. Literal boundaries keep
 * delegated runner identities; opaque options retain conservative candidates.
 * Rules must retain the complete runner prefix and must not use this list.
 */
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
    // A proved non-runner interpreter owns its code arguments. Those words
    // cannot also acquire another language's command catalogue meanings.
    if (!RUNNER_SET.has(runnerName(target)) && (INTERPRETER_SET.has(program)
      || (SHELL_SET.has(program) && !["pwsh", "powershell", "cmd"].includes(program)))) return candidates.filter((index) => index <= start);
  }
  return candidates;
}

/** Script/code prefixes declare a language without interpreting runner options. */
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
  if (RUNNER_SET.has(runnerName(head))) return null;
  if (WRAPPER_SET.has(program)) {
    if (program === "eval") return args.length > 0 ? "code passed to eval" : null;
    if (program === "source" || program === ".") return args.length > 0 ? `script passed to ${program}` : null;
    if (program === "env" && args.some((arg) => arg !== undefined && /^(?:-[A-Za-z]*S|--split-string)/.test(arg))) return "code passed to env -S";
    if (wrapperCommand(argv.slice(start)).code) {
      return `code passed to ${program}`;
    }
    if (STRING_JOINING_WRAPPERS.has(program) && args.some((arg) => arg === undefined || /[\s;&|$`<>()]/.test(arg))) {
      return `code string passed to ${program}`;
    }
    return codeCarryingAssignment(args);
  }
  if (SHELL_SET.has(program) || INTERPRETER_SET.has(program)) {
    if (args.length > 0 && args.every((arg) => arg !== undefined && INFO_ONLY_ARGS.has(arg))) return null;
    if (args.length === 0) return `${program} reads code from stdin`;
    return `code passed to ${program}`;
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
  const effect = shellOptionEffect(argv.slice(start));
  return effect?.kind === "exec" ? effect.reason : null;
}

const ARITHMETIC_TEST_OPERATORS = new Set(["-eq", "-ne", "-lt", "-le", "-gt", "-ge"]);
/** An operand bash's arithmetic evaluates without looking anything up (`1`, `-2`, `0x1f`, `8#17`). */
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

/**
 * Reason this command evaluates a variable arithmetically, else null. Bash
 * arithmetic evaluates a variable's VALUE as an expression, and an array
 * subscript inside it runs command substitutions
 * (`x='a[$(rm -rf y)]'; echo $((x))`), so `$((…))` with a variable operand,
 * `[[ … -eq … ]]` with a non-constant operand, and opaque arithmetic or
 * array-index expansions are hidden code. `(( ))`, `let` and `declare -i`
 * already lower to unsupported syntax. `echo $((1+2))` stays visible.
 */
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

/**
 * Reason this argv runs code the matcher cannot read, else null: a shell or
 * interpreter given any code source (stdin, here-document, script file,
 * `-c`/`-e`/`-m`, `-s`, `-`), a code carrier (`eval`, `source`, `trap`,
 * `hash -p`, `alias`, `bind -x`, `mapfile -C`, `git -c`, editors, …), a
 * code-carrying variable, or an option in {@link shellOptionEffect} that
 * executes. Behind a wrapper every later word is tried as the program,
 * because wrapper option grammars differ too much to skip exactly.
 */
export function hiddenCodeReason(argv: readonly (string | undefined)[]): string | null {
  const wrapper = wrapperCommand(argv);
  const inner = wrapper.index;
  if (!wrapper.code && inner > 0 && inner < argv.length && argv[inner] === undefined) return "dynamic program name behind a wrapper";
  const wrapperStarts = argv[0] !== undefined && WRAPPER_SET.has(programName(argv[0])) ? argv.map((_, index) => index) : [0];
  const runner = opaqueRunnerReason(argv) !== null;
  const visibleArgv = runner ? argv.slice(0, inner + 1) : argv;
  const starts = runner ? wrapperStarts.filter((start) => start <= inner) : wrapperStarts;
  for (const start of starts) {
    const reason = hiddenCodeAt(visibleArgv, start);
    if (reason) return reason;
  }
  return null;
}

/** True when this argv (or the program behind a wrapper) can send data off the machine. */
export function isNetworkProgram(argv: readonly (string | undefined)[]): boolean {
  const starts = argv[0] !== undefined && WRAPPER_SET.has(programName(argv[0])) ? argv.map((_, index) => index) : [0];
  return starts.some((start) => argv[start] !== undefined && NETWORK_PROGRAMS.has(programName(argv[start]!)));
}

// ─── One parse per decision ─────────────────────────────────────────────

/**
 * A shell command parsed once, with the facts the matcher and the floors
 * derive from it memoized per cwd, so one `checkDetailed` call parses the
 * command once instead of once per consumer.
 */
export interface ParsedShellCommand {
  readonly command: string;
  readonly analysis: ShellAnalysis;
  /** Set when the parser runtime threw (reported as unparseable). */
  readonly parserError?: unknown;
  readonly facts: Map<string, unknown>;
}

export type ShellCommandInput = string | ParsedShellCommand;

export function parseShellCommand(command: string): ParsedShellCommand {
  try {
    return { command, analysis: analyzeShell(command, "bash"), facts: new Map() };
  } catch (error) {
    return { command, analysis: { ok: false, reason: "shell parser failed" }, parserError: error, facts: new Map() };
  }
}

export function asParsedShellCommand(input: ShellCommandInput): ParsedShellCommand {
  return typeof input === "string" ? parseShellCommand(input) : input;
}

/** `compute()` once per parsed command and key. */
export function shellFact<T>(parsed: ParsedShellCommand, key: string, compute: () => T): T {
  if (parsed.facts.has(key)) return parsed.facts.get(key) as T;
  const value = compute();
  parsed.facts.set(key, value);
  return value;
}
