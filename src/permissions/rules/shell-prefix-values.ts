import { POWERSHELL_FILE_TYPES } from "./powershell-file-types.js";

/** Programs that run arbitrary code given any argument (prefix of 1 token is refused). */
export const SHELLS = ["sh", "bash", "zsh", "dash", "ksh", "mksh", "yash", "fish", "csh", "tcsh", "pwsh", "powershell", "cmd", "busybox"];
/**
 * Interpreters run code the matcher cannot read. Runners retain their own
 * complete prefixes so an explicit rule can name the intended invocation.
 */
export const INTERPRETERS = [
  "python", "python2", "python3", "pypy", "pypy3", "ipython", "node", "nodejs", "deno", "bun", "tsx", "ts-node",
  "zx", "qjs", "perl", "ruby", "irb", "php", "lua", "luajit", "osascript", "Rscript", "R", "julia", "tclsh",
  "wish", "expect", "awk", "gawk", "mawk", "nawk", "jshell", "groovy", "scala", "racket", "guile", "elixir",
  "erl", "escript", "runghc", "swift", "sqlite3", "psql", "mysql", "dc", "gdb", "lldb",
];
/**
 * Wrappers execute another command. They are never stripped when matching an
 * allow rule, so they are refused at every length (`env FOO=1 ls *` included).
 */
export const WRAPPERS = [
  "env", "xargs", "sudo", "doas", "su", "eval", "exec", "source", ".", "command", "builtin", "nohup",
  "timeout", "nice", "ionice", "time", "stdbuf", "chroot", "unshare", "nsenter", "setsid", "watch",
  "parallel", "script", "runuser", "pkexec", "caffeinate", "taskpolicy", "flock", "chrt", "strace", "ltrace",
  "unbuffer", "firejail", "systemd-run", "proot", "wsl", "torsocks", "proxychains", "proxychains4", "fakeroot", "faketime",
  "taskset", "numactl", "cpulimit", "prlimit", "rlwrap", "sg", "ssh-agent", "dbus-launch", "xvfb-run",
  "catchsegv", "valgrind", "run0", "genv", "gtimeout", "gnice", "gstdbuf", "gnohup", "gxargs", "gchroot",
  // A multi-call binary runs whichever applet its first argument names.
  "busybox",
];
/**
 * Wrappers that join their arguments into a string a shell runs
 * (`watch 'rm x'`, `parallel 'rm {}' ::: a`, `flock f -c 'rm x'`).
 */
export const STRING_JOINING_WRAPPERS = new Set(["watch", "parallel", "sg"]);
/** Runner identities and literal prefixes that can introduce another command. */
export type RunnerCommandPrefix = string | readonly [verb: string, interpreter: string];
export const RUNNER_COMMAND_PREFIXES: Readonly<Record<string, true | readonly RunnerCommandPrefix[]>> = {
  npx: true, bunx: true, pnpx: true, uvx: true, corepack: true,
  pipx: ["run"], yarn: ["dlx", "exec", ["node", "node"]], yarnpkg: ["dlx", "exec", ["node", "node"]],
  pnpm: ["dlx", "exec", "x"], npm: ["exec", "x"], bun: ["x", "exec"], deno: [["run", "deno"], ["eval", "deno"]],
};
export const PACKAGE_RUNNERS = Object.keys(RUNNER_COMMAND_PREFIXES);

export function runnerHasPrefix(prefixes: readonly RunnerCommandPrefix[], token: string | undefined): boolean {
  return token !== undefined && prefixes.some((prefix) => (typeof prefix === "string" ? prefix : prefix[0]) === token.toLowerCase());
}

/**
 * Arity table: how many leading tokens a suggestion keeps.
 * Multi-verb tools also refuse their 1-token prefix: `git *` covers
 * `git -c core.fsmonitor=…`, and `npm *` covers `npm exec`.
 */
export const ARITY: ReadonlyMap<string, number> = new Map([
  ["git", 2], ["npm", 2], ["pnpm", 2], ["yarn", 2], ["docker", 2], ["kubectl", 2],
  ["npm run", 3], ["pnpm run", 3], ["yarn run", 3], ["bun run", 3],
]);
const MULTI_VERB_TOOLS = new Set(["git", "npm", "pnpm", "yarn", "docker", "kubectl", "bun"]);

export const SHELL_SET = new Set(SHELLS.map((name) => name.toLowerCase()));
export const INTERPRETER_SET = new Set(INTERPRETERS.map((name) => name.toLowerCase()));
export const WRAPPER_SET = new Set(WRAPPERS.map((name) => name.toLowerCase()));
export const RUNNER_SET = new Set(PACKAGE_RUNNERS);

/** Program name with any directory and a trailing version suffix removed (`/usr/bin/python3.12` → `python3`). */
export function programName(token: string): string {
  const base = (token.split(/[\\/]/).pop() ?? token).toLowerCase();
  return base.replace(/\.exe$/i, "").replace(/^(python[23]?)\.\d+$/, "$1");
}

/** Runner shims share the executable/script suffixes and retain versioned identity. */
export function runnerName(token: string): string {
  const base = (token.split(/[\\/]/).pop() ?? token).toLowerCase().replace(/[ .]+$/, "");
  const extension = /\.[^.]+$/.exec(base)?.[0] ?? "";
  const type = POWERSHELL_FILE_TYPES[extension];
  const name = type === "opaque" || type === "script" ? base.slice(0, -extension.length) : base;
  return name.replace(/@[^@]+$/, "");
}

/**
 * Programs that delete or overwrite data whatever their arguments look like
 * at suggestion time. Never an allow prefix at any length: `Bash(rm *)` saved
 * from `rm notes.txt` would also cover `rm --recursive --force ~`.
 */
const DESTRUCTIVE_PROGRAMS = new Set(["rm", "shred", "srm", "wipefs", "dd", "mkfs", "newfs", "diskutil", "format"]);
/** Ownership and mode changers: destructive when recursive or world-writable. */
const PERMISSION_CHANGERS = new Set(["chmod", "chown", "chgrp"]);
/**
 * Network-egress clients. Their prefixes are not offered as reusable allows
 * until host-scoped network rules can bound where they connect.
 */
export const NETWORK_EGRESS_PROGRAMS: ReadonlySet<string> = new Set([
  "curl", "wget", "nc", "ncat", "netcat", "socat", "telnet", "ssh", "scp", "sftp", "ftp", "lftp", "tftp",
  "rsync", "http", "https", "xh", "aria2c", "httpie",
]);

function isDestructiveProgram(program: string): boolean {
  return DESTRUCTIVE_PROGRAMS.has(program) || program.startsWith("mkfs.") || program.startsWith("newfs_");
}

/** Options before `--` (GNU tools permute, so position does not matter); `undefined` is a dynamic word. */
function optionWords(args: readonly (string | undefined)[]): { options: (string | undefined)[]; operands: (string | undefined)[] } {
  const options: (string | undefined)[] = [];
  const operands: (string | undefined)[] = [];
  let delimited = false;
  for (const arg of args) {
    if (arg === undefined) {
      // A dynamic word may expand to an option.
      if (!delimited) options.push(undefined);
      operands.push(undefined);
    } else if (!delimited && arg === "--") {
      delimited = true;
    } else if (!delimited && arg.startsWith("-") && arg !== "-") {
      options.push(arg);
    } else {
      operands.push(arg);
    }
  }
  return { options, operands };
}

function hasShortFlag(options: readonly (string | undefined)[], letters: string): boolean {
  return options.some((option) => option !== undefined && /^-[^-]/.test(option)
    && [...option.slice(1)].some((letter) => letters.includes(letter)));
}

/** GNU long options accept any unambiguous abbreviation (`--rec`, `--forc`). */
function hasLongFlag(options: readonly (string | undefined)[], names: readonly string[]): boolean {
  return options.some((option) => {
    if (option === undefined || !option.startsWith("--") || option.length < 3) return false;
    const name = option.slice(2).split("=")[0]!.toLowerCase();
    return names.some((candidate) => candidate.startsWith(name));
  });
}

/** A mode that makes the target writable by everyone (`777`, `o+w`, `a=rwx`, `+w`). */
function worldWritableMode(mode: string | undefined): boolean {
  if (mode === undefined) return true;
  if (/^[0-7]{3,4}$/.test(mode)) return ["2", "3", "6", "7"].includes(mode[mode.length - 1]!);
  return mode.split(",").some((clause) => {
    const symbolic = /^([ugoa]*)([+=])([rwxXst]*)$/.exec(clause);
    return symbolic !== null && (symbolic[1] === "" || /[oa]/.test(symbolic[1]!)) && symbolic[3]!.includes("w");
  });
}

/**
 * Argument-aware destructive floor for one static command: recursive or
 * forced deletion in any option order or spelling, recursive or world-writable
 * permission changes, raw disk writers and `find -delete`. A dynamic word in
 * an option position counts as the worst case.
 */
export function isDestructiveShellArgv(argv: readonly (string | undefined)[]): boolean {
  const head = argv[0];
  if (head === undefined) return false;
  const program = programName(head);
  const { options, operands } = optionWords(argv.slice(1));
  const dynamicOption = options.includes(undefined);
  if (program === "rm") {
    return dynamicOption || hasShortFlag(options, "rRf") || hasLongFlag(options, ["recursive", "force", "no-preserve-root"]);
  }
  if (isDestructiveProgram(program)) return program !== "dd" || argv.slice(1).some((arg) => arg === undefined || /^of=/i.test(arg));
  if (PERMISSION_CHANGERS.has(program)) {
    if (dynamicOption || hasShortFlag(options, "R") || hasLongFlag(options, ["recursive"])) return true;
    return program === "chmod" && worldWritableMode(operands[0]);
  }
  if (program === "find") {
    const args = argv.slice(1);
    return args.some((arg, index) => arg === undefined || arg === "-delete"
      || (["-exec", "-execdir", "-ok", "-okdir"].includes(arg) && isDestructiveShellArgv(execArgv(args, index + 1))));
  }
  return false;
}

/** The command a `find -exec` runs, up to its `;` or `+` terminator. */
function execArgv(args: readonly (string | undefined)[], start: number): (string | undefined)[] {
  const end = args.findIndex((arg, index) => index >= start && (arg === ";" || arg === "+"));
  return args.slice(start, end < 0 ? undefined : end);
}

export type RefusedPrefixReason =
  | "destructive"
  | "empty"
  | "config-writer"
  | "shell"
  | "interpreter"
  | "wrapper"
  | "package-runner"
  | "multi-verb-tool";

/** An option leaves the command boundary unknown until a literal delimiter. */
export function literalCommandAfterPrefix(tokens: readonly (string | undefined)[], start: number): number | undefined {
  const token = tokens[start];
  if (token === undefined || token.length === 0) return undefined;
  if (!token.startsWith("-")) return start;
  const delimiter = tokens.indexOf("--", start);
  const command = delimiter < 0 ? undefined : tokens[delimiter + 1];
  return command !== undefined && command.length > 0 && !command.startsWith("-") ? delimiter + 1 : undefined;
}

/**
 * The single refused-prefix check. `tokens` is the static prefix of a
 * `Bash(<tokens> *)` rule (or of an exact `Bash(<tokens>)` rule).
 * Returns the reason when the prefix may not become a persistent allow rule.
 */
export function refusedShellPrefix(tokens: readonly string[]): RefusedPrefixReason | null {
  if (tokens.length === 0) return "empty";
  const program = programName(tokens[0]!);
  if (WRAPPER_SET.has(program)) return "wrapper";
  if (isDestructiveProgram(program)) return "destructive";
  // A bare or recursive permission-changer prefix covers `chmod -R 777 /`.
  if (PERMISSION_CHANGERS.has(program)
    && (tokens.length === 1 || isDestructiveShellArgv(tokens))) return "destructive";
  if (SHELL_SET.has(program)) return "shell";
  const runner = runnerName(tokens[0]!);
  if (RUNNER_SET.has(runner)) {
    const commandPrefix = RUNNER_COMMAND_PREFIXES[runner]!;
    const commandIndex = literalCommandAfterPrefix(tokens, 1);
    if (commandIndex === undefined) return "package-runner";
    const command = tokens[commandIndex]!;
    // A delegate specifier does not prove its delegated command boundary.
    if (runner === "corepack" && command.includes("@")) return "package-runner";
    if (runner === "corepack" && RUNNER_SET.has(runnerName(command))) return refusedShellPrefix(tokens.slice(commandIndex));
    if (commandPrefix !== true && runnerHasPrefix(commandPrefix, command)
      && literalCommandAfterPrefix(tokens, commandIndex + 1) === undefined) return "package-runner";
    return null;
  }
  if (INTERPRETER_SET.has(program)) {
    // Any other interpreter prefix runs code the rules cannot read
    // (`node scripts/build.mjs`, `python -m x`), so it never persists.
    return "interpreter";
  }
  if (MULTI_VERB_TOOLS.has(program) && tokens.length === 1) return "multi-verb-tool";
  // `git -c …`, `docker --host …`: an option before the verb re-targets the tool.
  if (MULTI_VERB_TOOLS.has(program) && tokens[1]!.startsWith("-")) return "multi-verb-tool";
  // `git config` writes settings that run code later (`core.fsmonitor`,
  // `core.pager`, aliases).
  if (program === "git" && tokens[1]?.toLowerCase() === "config") {
    return "config-writer";
  }
  return null;
}
