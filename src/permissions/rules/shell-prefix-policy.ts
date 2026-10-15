/**
 * Shell prefix policy (issue #28, P1a): the single refused-prefix list and the
 * pure arity-table suggestion used by the dock and validated on every write.
 *
 * A refused prefix can still be approved once or for the session; it can never
 * become a persistent `Bash(<prefix> *)` allow rule. Deny and ask rules are not
 * restricted — `Bash(sudo *)` as a deny rule is useful.
 */

import { analyzeShell, staticShellWord, type ShellAnalysis, type ShellCommand, type ShellWord } from "../../shared/shell-analysis.js";

/** Programs that run arbitrary code given any argument (prefix of 1 token is refused). */
const SHELLS = ["sh", "bash", "zsh", "dash", "ksh", "mksh", "yash", "fish", "csh", "tcsh", "pwsh", "powershell", "cmd", "busybox"];
/**
 * Interpreters: every invocation runs code the matcher cannot read (a script
 * file, a module, stdin, a here-document or an inline string), so they are
 * refused at every length except `bun`/`deno` task verbs (`bun run build`).
 */
const INTERPRETERS = [
  "python", "python2", "python3", "pypy", "pypy3", "ipython", "node", "nodejs", "deno", "bun", "tsx", "ts-node",
  "zx", "qjs", "perl", "ruby", "irb", "php", "lua", "luajit", "osascript", "Rscript", "R", "julia", "tclsh",
  "wish", "expect", "awk", "gawk", "mawk", "nawk", "jshell", "groovy", "scala", "racket", "guile", "elixir",
  "erl", "escript", "runghc", "swift", "sqlite3", "psql", "mysql", "dc", "gdb", "lldb",
];
/**
 * Wrappers execute another command. They are never stripped when matching an
 * allow rule, so they are refused at every length (`env FOO=1 ls *` included).
 */
const WRAPPERS = [
  "env", "xargs", "sudo", "doas", "su", "eval", "exec", "source", ".", "command", "builtin", "nohup",
  "timeout", "nice", "ionice", "time", "stdbuf", "chroot", "unshare", "nsenter", "setsid", "watch",
  "parallel", "script", "runuser", "pkexec", "caffeinate", "taskpolicy", "flock", "chrt", "strace", "ltrace",
  "unbuffer", "firejail", "systemd-run", "torsocks", "proxychains", "proxychains4", "fakeroot", "faketime",
  "taskset", "numactl", "cpulimit", "prlimit", "rlwrap", "sg", "ssh-agent", "dbus-launch", "xvfb-run",
  "catchsegv", "valgrind", "run0", "genv", "gtimeout", "gnice", "gstdbuf", "gnohup", "gxargs", "gchroot",
  // A multi-call binary runs whichever applet its first argument names.
  "busybox",
];
/**
 * Wrappers that join their arguments into a string a shell runs
 * (`watch 'rm x'`, `parallel 'rm {}' ::: a`, `flock f -c 'rm x'`).
 */
const STRING_JOINING_WRAPPERS = new Set(["watch", "parallel", "sg"]);
const DASH_C_WRAPPERS = new Set(["su", "script", "flock", "runuser"]);
interface RunnerDataOptions {
  flags?: readonly string[];
  values?: readonly string[];
  optionalValues?: readonly string[];
}

interface PackageRunnerPolicy extends RunnerDataOptions {
  prefixRunner?: boolean;
  command?: true | readonly string[];
  delegate?: boolean;
  code?: readonly string[];
  codeVerbs?: readonly string[];
  taskArguments?: readonly string[];
  scriptVerbs?: readonly string[];
  blockedVerbs?: readonly string[];
  packageSources?: readonly string[];
  configGetters?: readonly string[];
  tasks?: ReadonlySet<string>;
  commandDelimiter?: boolean;
  taskOptions?: Readonly<Record<string, RunnerDataOptions>>;
}

const CALL_OPTIONS = ["-c", "--call", "--shell-mode"];
const TASK_FLAGS = ["--silent", "--quiet", "--offline", "--ignore-scripts", "--frozen-lockfile"];
const CONFIG_SOURCE_OPTIONS = new Set(["config", "userconfig", "globalconfig", "importmap", "nodeoptions", "require", "preload", "import", "scriptshell"]);
const NPM_INSTALL_OPTIONS = { flags: ["--save", "--legacy-peer-deps", "-g", "--global", "--save-dev", "-D", "--save-exact", "-E", "--no-save"] };
const PNPM_INSTALL_OPTIONS = { flags: ["--no-frozen-lockfile", "--save-dev", "-D"] };
const CONFIG_GETTERS = ["get", "list", "ls"];
const PACKAGE_SOURCE_VERBS = ["install", "i", "add"];
const REMOTE_CODE_SOURCE = /^(?:(?:https?|file|data|blob|ftp|ftps|ssh|git(?:\+[a-z\d+.-]+)?):|[\\/]{2})/i;
const REGISTRY_SPECIFIER = /^(?:npm|jsr):/i;
const DENO_TASK_VERBS = new Set(["task", "test", "fmt", "lint", "check", "info", "doc", "bench", "cache", "types", "completions", "upgrade", "compile", "install", "add"]);
/** Data bindings belong to each runner; source scans also inspect forwarded argv. */
const PACKAGE_RUNNER_POLICIES: Readonly<Record<string, PackageRunnerPolicy>> = {
  npx: { prefixRunner: true, command: true, code: CALL_OPTIONS, flags: ["-y", "--yes", "--no", "--no-install"], values: ["-p", "--package"] },
  bunx: { prefixRunner: true, command: true, code: CALL_OPTIONS, flags: ["--bun", "--no-install"], values: ["-p", "--package"] },
  pnpx: { prefixRunner: true, command: true, code: CALL_OPTIONS, flags: ["-s", "--silent"], values: ["--package"] },
  uvx: { prefixRunner: true, command: true, flags: ["--offline", "--no-cache", "-q", "--quiet"], values: ["--from", "--with"] },
  pipx: { prefixRunner: true, command: ["run"], code: ["--path"], codeVerbs: ["runpip"], values: ["--spec"] },
  corepack: { prefixRunner: true, delegate: true, taskOptions: { prepare: { flags: ["--activate"] } } },
  yarnpkg: { prefixRunner: true, command: ["dlx"], code: CALL_OPTIONS, codeVerbs: ["exec", "node"], flags: TASK_FLAGS, values: ["--cwd"], packageSources: PACKAGE_SOURCE_VERBS, configGetters: CONFIG_GETTERS },
  deno: { prefixRunner: true, code: ["-e", "--eval"], codeVerbs: ["eval"], taskArguments: ["task"], scriptVerbs: ["run"], tasks: DENO_TASK_VERBS, flags: ["--quiet", "--watch"],
    blockedVerbs: ["init", "serve", "publish", "outdated", "remove", "repl"], packageSources: ["install", "cache", "add"],
    taskOptions: { test: { flags: ["-A"] }, run: { flags: ["-A"], optionalValues: ["--allow-", "--deny-"] }, task: { values: ["--cwd"] }, install: { flags: ["-g", "--global", "--entrypoint"] } } },
  npm: { command: ["exec", "x"], code: CALL_OPTIONS, codeVerbs: ["explore"], commandDelimiter: true, values: ["--package", "--prefix", "-w", "--workspace"], flags: TASK_FLAGS, packageSources: PACKAGE_SOURCE_VERBS, configGetters: CONFIG_GETTERS,
    taskOptions: { install: NPM_INSTALL_OPTIONS, i: NPM_INSTALL_OPTIONS, ci: { values: ["--omit"] }, init: { flags: ["-y"] }, run: { flags: ["--if-present"] }, publish: { values: ["--access"] } } },
  pnpm: { command: ["exec", "dlx", "x"], code: CALL_OPTIONS, flags: [...TASK_FLAGS, "--recursive", "-r"], values: ["--package", "--filter", "-C", "--dir"], packageSources: PACKAGE_SOURCE_VERBS, configGetters: CONFIG_GETTERS,
    taskOptions: { install: PNPM_INSTALL_OPTIONS, i: PNPM_INSTALL_OPTIONS, add: PNPM_INSTALL_OPTIONS, run: { flags: ["--parallel"] } } },
  yarn: { command: ["dlx"], code: CALL_OPTIONS, codeVerbs: ["exec", "node"], flags: TASK_FLAGS, values: ["--cwd"], packageSources: PACKAGE_SOURCE_VERBS, configGetters: CONFIG_GETTERS,
    taskOptions: { add: { flags: ["--dev", "-D"] }, install: { flags: ["--immutable"] } } },
  bun: { command: ["x"], code: ["-e", "--eval", "-p", "--print", "--preload"], codeVerbs: ["exec", "repl"], taskArguments: ["run"], flags: TASK_FLAGS, packageSources: [...PACKAGE_SOURCE_VERBS, "a"],
    taskOptions: { run: { flags: ["--hot", "--bail"] }, build: { values: ["--outdir"] }, test: { flags: ["--coverage", "--watch"] }, install: NPM_INSTALL_OPTIONS } },
};
/** Package and project task runners: a 1-token prefix cannot constrain their execution. */
const PACKAGE_RUNNERS = Object.keys(PACKAGE_RUNNER_POLICIES).filter((name) => PACKAGE_RUNNER_POLICIES[name]!.prefixRunner);

/**
 * Arity table (opencode-style): how many leading tokens a suggestion keeps.
 * Multi-verb tools also refuse their 1-token prefix: `git *` covers
 * `git -c core.fsmonitor=…`, and `npm *` covers `npm exec`.
 */
const ARITY: ReadonlyMap<string, number> = new Map([
  ["git", 2], ["npm", 2], ["pnpm", 2], ["yarn", 2], ["docker", 2], ["kubectl", 2],
  ["npm run", 3], ["pnpm run", 3], ["yarn run", 3], ["bun run", 3],
]);
const MULTI_VERB_TOOLS = new Set(["git", "npm", "pnpm", "yarn", "docker", "kubectl", "bun"]);

const SHELL_SET = new Set(SHELLS);
const INTERPRETER_SET = new Set(INTERPRETERS);
const WRAPPER_SET = new Set(WRAPPERS);
const RUNNER_SET = new Set(PACKAGE_RUNNERS);

/** Program name with any directory and a trailing version suffix removed (`/usr/bin/python3.12` → `python3`). */
function programName(token: string): string {
  const base = token.split(/[\\/]/).pop() ?? token;
  return base.replace(/\.exe$/i, "").replace(/^(python[23]?)\.\d+$/, "$1");
}

export type RefusedPrefixReason =
  | "empty"
  | "config-writer"
  | "shell"
  | "interpreter"
  | "wrapper"
  | "package-runner"
  | "multi-verb-tool";

/**
 * The single refused-prefix check. `tokens` is the static prefix of a
 * `Bash(<tokens> *)` rule (or of an exact `Bash(<tokens>)` rule).
 * Returns the reason when the prefix may not become a persistent allow rule.
 */
export function refusedShellPrefix(tokens: readonly string[]): RefusedPrefixReason | null {
  if (tokens.length === 0) return "empty";
  const program = programName(tokens[0]!);
  if (WRAPPER_SET.has(program)) return "wrapper";
  if (SHELL_SET.has(program)) return "shell";
  if (INTERPRETER_SET.has(program)) {
    // `bun` is both an interpreter and a multi-verb tool: `bun run <script>`
    // and `bun test` are ordinary; `bun x`/`bun -e`/`bun file.ts` are not.
    if (program === "bun" && tokens[1] === "x") return "package-runner";
    // Any other interpreter prefix runs code the rules cannot read
    // (`node scripts/build.mjs`, `python -m x`), so it never persists.
    if (!isTaskRunnerVerb(program, tokens.slice(1))) return "interpreter";
  }
  if (RUNNER_SET.has(program) && tokens.length === 1) return "package-runner";
  if (MULTI_VERB_TOOLS.has(program) && tokens.length === 1) return "multi-verb-tool";
  // `git -c …`, `docker --host …`: an option before the verb re-targets the tool.
  if (MULTI_VERB_TOOLS.has(program) && tokens[1]!.startsWith("-")) return "multi-verb-tool";
  if ((program === "npm" || program === "pnpm" || program === "yarn") && (tokens[1] === "exec" || tokens[1] === "dlx" || tokens[1] === "x")) {
    return "package-runner";
  }
  // `git config` writes settings that run code later (`core.fsmonitor`,
  // `core.pager`, aliases); `npm config` / `yarn config` likewise.
  if ((program === "git" || program === "npm" || program === "pnpm" || program === "yarn") && tokens[1] === "config") {
    return "config-writer";
  }
  return null;
}

/**
 * Value-taking options of wrapper programs, so the wrapped command can be
 * found (`xargs -I {} sh -c …`, `sudo -u root rm`, `nice -n 5 rm`).
 */
const WRAPPER_VALUE_OPTIONS: Readonly<Record<string, ReadonlySet<string>>> = {
  xargs: new Set(["-I", "-L", "-n", "-P", "-s", "-d", "-E", "-a", "--arg-file", "--delimiter", "--max-args", "--max-procs", "--replace"]),
  sudo: new Set(["-u", "-g", "-C", "-h", "-p", "-r", "-t", "-U", "-D", "--user", "--group"]),
  doas: new Set(["-u", "-C"]),
  su: new Set(["-c", "-s", "-g", "-G", "--command", "--shell"]),
  env: new Set(["-u", "-C", "--unset", "--chdir"]),
  timeout: new Set(["-s", "-k", "--signal", "--kill-after"]),
  nice: new Set(["-n", "--adjustment"]),
  ionice: new Set(["-c", "-n", "-p", "--class", "--classdata"]),
  chrt: new Set(["-p"]),
  flock: new Set(["-w", "-E", "--timeout", "--conflict-exit-code"]),
  watch: new Set(["-n", "-d", "--interval"]),
  stdbuf: new Set(["-i", "-o", "-e"]),
  runuser: new Set(["-u", "-g", "-G", "--user", "--group"]),
  setsid: new Set(),
  nohup: new Set(),
};

/**
 * Number of leading argv words that are wrapper programs and their options
 * (`env A=1`, `timeout 5`, `xargs -I {}`, `busybox`). `undefined` entries are
 * dynamic words and stop the scan. Used by deny/ask matching, the inline-code
 * detector and the exfiltration floor so all three see the same command.
 */
export function wrapperPrefixLength(argv: readonly (string | undefined)[]): number {
  let index = 0;
  for (let guard = 0; guard < 16 && index < argv.length; guard += 1) {
    const head = argv[index];
    if (head === undefined) return index;
    const program = programName(head);
    // `eval` / `source` / `.` run a string or file: they are code carriers,
    // not transparent wrappers.
    if (!WRAPPER_SET.has(program) || program === "eval" || program === "source" || program === ".") return index;
    index += 1;
    const valueOptions = WRAPPER_VALUE_OPTIONS[program] ?? new Set<string>();
    if (program === "timeout") {
      // `timeout [opts] DURATION cmd`
      while (index < argv.length && argv[index]?.startsWith("-")) {
        index += valueOptions.has(argv[index]!) ? 2 : 1;
      }
      if (index < argv.length && argv[index] !== undefined && /^\d+(?:\.\d+)?[smhd]?$/.test(argv[index]!)) index += 1;
      continue;
    }
    while (index < argv.length) {
      const token = argv[index];
      if (token === undefined) return index;
      if (token === "--") { index += 1; break; }
      if (token.startsWith("-")) {
        index += valueOptions.has(token) ? 2 : 1;
        continue;
      }
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) { index += 1; continue; }
      break;
    }
  }
  return index;
}

/** Value-taking global options of multi-verb tools (before the verb). */
const GLOBAL_VALUE_OPTIONS: Readonly<Record<string, ReadonlySet<string>>> = {
  git: new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--config-env", "--exec-path"]),
  docker: new Set(["-H", "--host", "--context", "-c", "--config", "-l", "--log-level", "--tlscacert", "--tlscert", "--tlskey"]),
  kubectl: new Set(["-n", "--namespace", "--context", "--cluster", "--user", "-s", "--server", "--kubeconfig", "--token"]),
  npm: new Set(["--prefix", "-w", "--workspace", "-C"]),
  pnpm: new Set(["-C", "--dir", "-w", "--filter", "-F"]),
  yarn: new Set(["--cwd"]),
  bun: new Set(["--cwd", "--config", "-c"]),
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
  let arity = 1;
  for (const [key, value] of ARITY) {
    const keyTokens = key.split(" ");
    if (keyTokens.length <= statics.length
      && programName(statics[0]!) === keyTokens[0]
      && keyTokens.every((token, index) => index === 0 || statics[index] === token)) {
      arity = Math.max(arity, value);
    }
  }
  const prefix: string[] = [];
  for (let index = 0; index < Math.min(arity, statics.length); index += 1) {
    const token = statics[index]!;
    // Options and paths are arguments, not verbs: stop the prefix there.
    if (index > 0 && (token.startsWith("-") || /[\\/=]/.test(token))) break;
    prefix.push(token);
  }
  if (prefix.some((token) => /[\s;&|<>()$`'"\\*?[\]{}#~!]/.test(token))) return null;
  return refusedShellPrefix(prefix) === null ? prefix : null;
}

/** Exposed for the design doc and tests; do not fork these lists elsewhere. */
export const SHELL_PREFIX_POLICY = Object.freeze({
  shells: Object.freeze([...SHELLS]),
  interpreters: Object.freeze([...INTERPRETERS]),
  wrappers: Object.freeze([...WRAPPERS]),
  packageRunners: Object.freeze([...PACKAGE_RUNNERS]),
  packageTaskPrograms: Object.freeze(Object.keys(PACKAGE_RUNNER_POLICIES)),
  arity: ARITY,
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
/** `bun <verb>` / `deno <verb>` that run project tasks, not a code argument. */
const BUN_TASK_VERBS = new Set([
  "run", "test", "install", "i", "add", "a", "remove", "rm", "update", "outdated", "build", "pm", "link",
  "unlink", "init", "upgrade", "audit", "info", "publish", "patch", "why",
]);
const SCRIPT_FILE_ARG = /[\\/]|\.(?:[cm]?[jt]sx?|sh|py|rb|pl|php|lua)$/i;
const FILE_OPERAND_INTERPRETERS = new Set(["node", "nodejs", "tsx", "ts-node"]);

function isTaskRunnerVerb(program: string, rest: readonly (string | undefined)[]): boolean {
  const verb = rest[0];
  if (verb === undefined) return false;
  if (program === "deno") return DENO_TASK_VERBS.has(verb);
  if (program !== "bun" || !BUN_TASK_VERBS.has(verb)) return false;
  if (verb !== "run" || rest.length < 2) return true;
  // `bun run build` runs a package.json script; `bun run ./x.ts` runs a file.
  const target = rest[1];
  return target !== undefined && !target.startsWith("-") && !SCRIPT_FILE_ARG.test(target);
}

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
  const program = programName(head);
  const args = argv.slice(1);
  let effect: ShellOptionEffect | null = null;
  switch (program) {
    case "sed": case "gsed": effect = sedEffect(args); break;
    case "tar": case "gtar": case "bsdtar": effect = tarEffect(args); break;
    case "git": effect = gitEffect(args); break;
    case "ssh": case "scp": case "sftp": effect = sshFamilyEffect(program, args); break;
    case "rg":
      if (args.some((arg) => arg !== undefined && /^--pre(?:-glob)?(?:=|$)/.test(arg))) effect = exec("rg --pre runs a command");
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

interface PackageRunnerInvocation {
  // Data binds argv, including project tasks; it does not prove task contents.
  // Scripts retain interpreter visibility, unknown options ask normally, and
  // opaque sources force the floor. Blocked forms hide rule visibility without
  // proving a code source. None defers to intrinsic program handling.
  kind: "none" | "data" | "script" | "unknown" | "blocked" | "opaque";
  reason: string | null;
  ordinaryAsk?: string;
  readOnlyConfig?: boolean;
  commandIndex?: number;
  program?: string;
  task?: boolean;
  scriptPath?: string;
}

function isLocalScriptOperand(value: string | undefined): value is string {
  return !!value && !value.startsWith("-") && !REMOTE_CODE_SOURCE.test(value) && !REGISTRY_SPECIFIER.test(value)
    && !/^(?:\/dev\/(?:stdin|fd\/\d+)|con(?:in\$)?)$/i.test(value);
}

function isRemotePackageSource(value: string): boolean {
  const source = value.replace(/^(?:@[^/@]+\/)?[^/@]+@(?=[a-z][a-z\d+.-]*:)/i, "");
  return [value, source].some((candidate) => REMOTE_CODE_SOURCE.test(candidate)
    || /^(?:git@[^:]+:|(?:github|gitlab|bitbucket):)/i.test(candidate));
}

/** Unknown options add an ordinary ask independently of script and source visibility. */
export function packageRunnerInvocation(argv: readonly (string | undefined)[]): PackageRunnerInvocation {
  const nameAt = (index: number): string => programName(argv[index] ?? "").replace(/^(?!@)([^@]+)@[^@]+$/, "$1");
  if (!Object.hasOwn(PACKAGE_RUNNER_POLICIES, nameAt(0))) return { kind: "none", reason: null };
  const opaque = (reason: string): PackageRunnerInvocation => ({ kind: "opaque", reason: `package runner ${reason}` });
  if (argv.length > 1024) return opaque("analysis budget exceeded");
  let chars = 0;
  let unresolved = false;
  for (const arg of argv) {
    unresolved ||= arg === undefined;
    chars += arg?.length ?? 0;
    if (chars > 65_536) return opaque("analysis budget exceeded");
  }
  let start = 0;
  let unknown: string | undefined;
  let binding: string | undefined;
  for (let depth = 0; depth < 16; depth += 1) {
    const program = nameAt(start);
    const policy = Object.hasOwn(PACKAGE_RUNNER_POLICIES, program) ? PACKAGE_RUNNER_POLICIES[program] : undefined;
    const command = (): PackageRunnerInvocation => ({ kind: unresolved ? "opaque" : binding ? "blocked" : unknown ? "unknown" : "data",
      reason: unresolved ? "package runner has an unresolved argument" : binding ?? unknown ?? null,
      ...(unknown ? { ordinaryAsk: unknown } : {}),
      ...(start ? { commandIndex: start, program } : {}) });
    if (!policy) {
      if (!argv[start] || /[\s;&|`$<>()]/.test(argv[start]!)) return opaque("has an opaque command operand");
      const inner = [program, ...argv.slice(start + 1)];
      if (INTERPRETER_SET.has(program) && inner.slice(1).some((arg) => arg !== undefined && !arg.startsWith("--")
        && (arg === "-" || (!arg.startsWith("-") && !isLocalScriptOperand(arg))))) return opaque("has a remote or stdin interpreter source");
      const intrinsic = WRAPPER_SET.has(program) ? "launches a wrapper" : hiddenCodeAt(inner, 0);
      const effect = shellOptionEffect(inner);
      const info = inner.length === 2 && /^(?:--version|--help|-v|-h)$/.test(inner[1]!);
      const forwarded = command();
      const reason = intrinsic ?? (effect?.kind === "exec" ? effect.reason : null)
        ?? (NETWORK_PROGRAMS.has(program) && !info ? "package runner launches a network-capable command" : null);
      const script = FILE_OPERAND_INTERPRETERS.has(program) && isLocalScriptOperand(inner[1]) && intrinsic === `code passed to ${program}`;
      return reason ? { ...forwarded, kind: script ? "script" : "opaque", reason, ...(script ? { scriptPath: inner[1] } : {}) } : forwarded;
    }
    // Configuration and code sources win over unknown options elsewhere. A
    // task delimiter ends runner-owned options, but not remote source checks.
    for (let scan = start + 1; scan < argv.length && argv[scan] !== "--"; scan += 1) {
      const token = argv[scan]?.replace(/[\u2013-\u2015]/g, "-");
      if (!token?.startsWith("-")) continue;
      const flag = token.split("=", 1)[0]!;
      const key = flag.replace(/[-_.]/g, "").toLowerCase();
      if (CONFIG_SOURCE_OPTIONS.has(key) || key.startsWith("config")) return opaque("contains a configuration source");
      if (policy.code?.some((code) => flag === code || (code.length === 2 && token.startsWith(code)))
        || /^(?:-c|-e|--call|--eval|--print|--shell-mode)(?:=|$)/.test(token)) return opaque("contains inline code");
    }
    if (program === "deno" && argv.slice(start + 1).some((arg) => arg === "-"
      || (arg !== undefined && REMOTE_CODE_SOURCE.test(arg.startsWith("-") && arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : arg)))) return opaque("has a remote or stdin source");
    const rest = argv.slice(start + 1);
    if (rest.length === 0) return INTERPRETER_SET.has(program) ? { kind: "none", reason: null } : command();
    if (rest.every((arg) => /^(?:--version|--help|-v|-h)$/.test(arg!))) return { ...command(), task: true };
    let index = start + 1;
    let delimited = false;
    const option = (data?: RunnerDataOptions): string | null => {
      const token = argv[index]!;
      const equals = token.indexOf("=");
      const flag = equals === -1 ? token : token.slice(0, equals);
      if ((policy.flags?.includes(flag) || data?.flags?.includes(flag)) && equals === -1) { index += 1; return null; }
      if (policy.values?.includes(flag) || data?.values?.includes(flag)) {
        const value = equals === -1 ? argv[++index] : token.slice(equals + 1);
        if (!value || value.startsWith("-")) return "has an opaque option value";
        index += 1;
        return null;
      }
      if (data?.optionalValues?.some((prefix) => flag.startsWith(prefix))) { index += 1; return null; }
      unknown ??= `package runner has an unknown option (${flag})`;
      index += 1;
      return null;
    };
    const leadingOptions = (data?: RunnerDataOptions): string | null => {
      while (index < argv.length) {
        if (argv[index] === undefined) return "has an unresolved argument";
        if (!argv[index]!.startsWith("-")) break;
        if (argv[index] === "--") { delimited = true; index += 1; break; }
        const reason = option(data);
        if (reason) return reason;
      }
      return null;
    };
    const leading = leadingOptions();
    if (leading) return opaque(leading);
    const verb = argv[index];
    if (verb === undefined) return opaque("has no command operand");
    const readOnlyConfig = verb === "config" && policy.configGetters?.includes(argv[index + 1]!) && !unresolved;
    if (program === "deno" && !policy.packageSources?.includes(verb) && !policy.taskArguments?.includes(verb)
      && argv.slice(index + 1).some((arg) => arg !== undefined && REGISTRY_SPECIFIER.test(arg))) return opaque("has a registry code source");
    if (policy.codeVerbs?.includes(verb)) return opaque("contains inline code");
    if (policy.delegate && Object.hasOwn(PACKAGE_RUNNER_POLICIES, nameAt(index))) { start = index; continue; }
    if (policy.command === true || policy.command?.includes(verb)) {
      if (policy.command !== true) {
        index += 1;
        const leading = leadingOptions();
        if (leading) return opaque(leading);
      }
      if (index >= argv.length) return opaque("has no command operand");
      if (policy.commandDelimiter && !delimited) binding ??= "package runner has an unmodeled command binding";
      start = index;
      continue;
    }
    const data = policy.taskOptions?.[verb];
    if (policy.packageSources?.includes(verb) && argv.slice(index + 1).some((arg) => arg !== undefined
      && isRemotePackageSource(arg))) return opaque("has a remote package source");
    if (policy.scriptVerbs?.includes(verb)) {
      index += 1;
      const leading = leadingOptions(data);
      if (leading) return opaque(leading);
      if (!isLocalScriptOperand(argv[index])) return opaque("has an opaque script source");
      const result = command();
      return result.kind === "opaque" ? result : { ...result, kind: "script", reason: `code passed to ${program}`, scriptPath: argv[index] };
    }
    if (policy.blockedVerbs?.includes(verb)) binding ??= "package runner has an unmodeled execution form";
    else if (policy.tasks && !policy.tasks.has(verb)) return opaque("has an unmodeled execution form");
    let task: boolean | undefined;
    let scriptPath: string | undefined;
    if (policy.taskArguments?.includes(verb)) {
      index += 1;
      const leading = leadingOptions(data);
      if (leading) return opaque(leading);
      if (index >= argv.length) return opaque("has no task operand");
      if (SCRIPT_FILE_ARG.test(argv[index]!) && !isLocalScriptOperand(argv[index])) return opaque("has a remote or stdin task source");
      task = !SCRIPT_FILE_ARG.test(argv[index]!);
      if (!task) scriptPath = argv[index];
    }
    // Only table entries establish data bindings. Unknown options retain an
    // ordinary ask and cannot clear a separately recognized code source.
    for (index += 1; !delimited && index < argv.length;) {
      if (argv[index] === undefined) return opaque("has an unresolved argument");
      if (argv[index] === "--") break;
      if (!argv[index]!.startsWith("-")) { index += 1; continue; }
      const reason = option(data);
      if (reason) return opaque(reason);
    }
    if (INTERPRETER_SET.has(program) && SCRIPT_FILE_ARG.test(verb) && !isLocalScriptOperand(verb)) return opaque("has a remote interpreter source");
    const result = command();
    const taskForm = task ?? (!INTERPRETER_SET.has(program) || isTaskRunnerVerb(program, [verb]));
    if (!scriptPath && !taskForm && !binding && isLocalScriptOperand(verb)) scriptPath = verb;
    if (scriptPath && result.kind !== "opaque") return { ...result, kind: "script", reason: `code passed to ${program}`, scriptPath };
    return { ...result, task: taskForm,
      ...(readOnlyConfig ? { readOnlyConfig: true } : {}) };
  }
  return opaque("analysis budget exceeded");
}

function hiddenCodeAt(argv: readonly (string | undefined)[], start: number): string | null {
  const head = argv[start];
  if (head === undefined) return null;
  const program = programName(head);
  const args = argv.slice(start + 1);
  const runner = packageRunnerInvocation(argv.slice(start));
  if (runner.kind !== "unknown" && runner.reason) return runner.reason;
  if (runner.task) return null;
  if (WRAPPER_SET.has(program)) {
    if (program === "eval") return args.length > 0 ? "code passed to eval" : null;
    if (program === "source" || program === ".") return args.length > 0 ? `script passed to ${program}` : null;
    if (program === "env" && args.some((arg) => arg !== undefined && /^(?:-[A-Za-z]*S|--split-string)/.test(arg))) return "code passed to env -S";
    if (DASH_C_WRAPPERS.has(program) && args.some((arg) => arg !== undefined && /^(?:-[A-Za-z]*c[A-Za-z]*|--command)(?:=|$)/.test(arg))) {
      return `code passed to ${program}`;
    }
    if (STRING_JOINING_WRAPPERS.has(program) && args.some((arg) => arg === undefined || /[\s;&|$`<>()]/.test(arg))) {
      return `code string passed to ${program}`;
    }
    return codeCarryingAssignment(args);
  }
  if (SHELL_SET.has(program) || INTERPRETER_SET.has(program)) {
    if (args.length > 0 && args.every((arg) => arg !== undefined && INFO_ONLY_ARGS.has(arg))) return null;
    if (isTaskRunnerVerb(program, args)) return null;
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
  const inner = wrapperPrefixLength(argv);
  if (inner > 0 && inner < argv.length && argv[inner] === undefined) return "dynamic program name behind a wrapper";
  const starts = argv[0] !== undefined && WRAPPER_SET.has(programName(argv[0])) ? argv.map((_, index) => index) : [0];
  for (const start of starts) {
    const reason = hiddenCodeAt(argv, start);
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
