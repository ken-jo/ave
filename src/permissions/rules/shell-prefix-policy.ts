/**
 * Shell prefix policy (issue #28, P1a): the single refused-prefix list and the
 * pure arity-table suggestion used by the dock and validated on every write.
 *
 * A refused prefix can still be approved once or for the session; it can never
 * become a persistent `Bash(<prefix> *)` allow rule. Deny and ask rules are not
 * restricted — `Bash(sudo *)` as a deny rule is useful.
 */

/** Programs that run arbitrary code given any argument (prefix of 1 token is refused). */
const SHELLS = ["sh", "bash", "zsh", "dash", "ksh", "mksh", "fish", "csh", "tcsh", "pwsh", "powershell", "cmd", "busybox"];
/** Interpreters: refused as a bare 1-token prefix and with an option as the 2nd token (`python -c`, `node -e`). */
const INTERPRETERS = [
  "python", "python2", "python3", "node", "nodejs", "deno", "bun", "perl", "ruby", "php", "lua", "luajit",
  "osascript", "Rscript", "julia", "tclsh", "awk", "gawk", "mawk", "nawk", "jshell", "groovy", "scala",
];
/**
 * Wrappers execute another command. They are never stripped when matching an
 * allow rule, so they are refused at every length (`env FOO=1 ls *` included).
 */
const WRAPPERS = [
  "env", "xargs", "sudo", "doas", "su", "eval", "exec", "source", ".", "command", "builtin", "nohup",
  "timeout", "nice", "ionice", "time", "stdbuf", "chroot", "unshare", "nsenter", "setsid", "watch",
  "parallel", "script", "runuser", "pkexec", "caffeinate", "taskpolicy", "flock", "chrt", "strace", "ltrace",
  // A multi-call binary runs whichever applet its first argument names.
  "busybox",
];
/** Package runners that fetch and execute arbitrary packages: a 1-token prefix is refused. */
const PACKAGE_RUNNERS = ["npx", "bunx", "pnpx", "uvx", "pipx"];

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
    if (tokens.length === 1) return "interpreter";
    if (tokens[1]!.startsWith("-")) return "interpreter";
    // `bun` is both an interpreter and a multi-verb tool: `bun run <script>`
    // and `bun test` are ordinary; `bun x`/`bun -e` are not.
    if (program === "bun" && tokens[1] === "x") return "package-runner";
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
  arity: ARITY,
});

/** Used by deny/ask matching to look through wrappers (it only ever widens a deny). */
export function isShellWrapperProgram(token: string): boolean {
  return WRAPPER_SET.has(programName(token));
}
