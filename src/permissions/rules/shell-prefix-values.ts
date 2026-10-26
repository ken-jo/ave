import { POWERSHELL_FILE_TYPES } from "./powershell-file-types.js";
import { canonicalPowerShellName } from "./powershell-command-policy.js";

// Shell executable identities used for hidden-code and floor inspection.
export const SHELLS = ["sh", "bash", "zsh", "dash", "ksh", "mksh", "yash", "fish", "csh", "tcsh", "pwsh", "powershell", "pwsh-preview", "cmd", "busybox"];
// Interpreters run code the matcher cannot read. Runners retain their own complete prefixes so an explicit rule can name the intended invocation.
export const INTERPRETERS = [
  "python", "python2", "python3", "pypy", "pypy3", "ipython", "node", "nodejs", "deno", "bun", "tsx", "ts-node",
  "zx", "qjs", "perl", "ruby", "irb", "php", "lua", "luajit", "osascript", "Rscript", "R", "julia", "tclsh",
  "wish", "expect", "awk", "gawk", "mawk", "nawk", "jshell", "groovy", "scala", "racket", "guile", "elixir",
  "erl", "escript", "runghc", "swift", "sqlite3", "psql", "mysql", "dc", "gdb", "lldb",
];
// Wrappers execute another command. Inspection follows that command while allow-rule matching retains the complete wrapper argv.
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
// Runner identities and literal prefixes that can introduce another command.
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

// Broad argv prefixes that cannot be suggested or saved as wildcard allows.
export const BANNED_PREFIX_SUGGESTIONS: readonly (readonly string[])[] = [
  ["/bin/bash"],
  ["/bin/bash", "-c"],
  ["/bin/bash", "-lc"],
  ["/bin/sh"],
  ["/bin/sh", "-c"],
  ["/bin/sh", "-lc"],
  ["/bin/zsh"],
  ["/bin/zsh", "-c"],
  ["/bin/zsh", "-lc"],
  ["Rscript"],
  ["bash"],
  ["bash", "-c"],
  ["bash", "-lc"],
  ["bun"],
  ["bun", "-e"],
  ["bun", "run"],
  ["cmd"],
  ["cmd", "/c"],
  ["cmd", "/k"],
  ["cmd.exe"],
  ["cmd.exe", "/c"],
  ["cmd.exe", "/k"],
  ["dash"],
  ["dash", "-c"],
  ["deno"],
  ["deno", "eval"],
  ["env"],
  ["fish"],
  ["fish", "-c"],
  ["git"],
  ["julia"],
  ["julia", "-e"],
  ["ksh"],
  ["ksh", "-c"],
  ["lua"],
  ["lua", "-e"],
  ["node"],
  ["node", "-e"],
  ["nodejs"],
  ["nodejs", "-e"],
  ["npm", "run"],
  ["osascript"],
  ["perl"],
  ["perl", "-e"],
  ["php"],
  ["php", "-r"],
  ["pnpm", "run"],
  ["powershell"],
  ["powershell", "-Command"],
  ["powershell", "-EncodedCommand"],
  ["powershell", "-File"],
  ["powershell", "-c"],
  ["powershell.exe"],
  ["powershell.exe", "-Command"],
  ["powershell.exe", "-EncodedCommand"],
  ["powershell.exe", "-File"],
  ["powershell.exe", "-c"],
  ["pwsh"],
  ["pwsh", "-Command"],
  ["pwsh", "-EncodedCommand"],
  ["pwsh", "-File"],
  ["pwsh", "-c"],
  ["pwsh", "-e"],
  ["pwsh", "-ec"],
  ["pwsh", "-f"],
  ["py"],
  ["py", "-3"],
  ["pypy"],
  ["pypy3"],
  ["python"],
  ["python", "-"],
  ["python", "-c"],
  ["python3"],
  ["python3", "-"],
  ["python3", "-c"],
  ["pythonw"],
  ["pyw"],
  ["rm"],
  ["ruby"],
  ["ruby", "-e"],
  ["sh"],
  ["sh", "-c"],
  ["sh", "-lc"],
  ["sudo"],
  ["yarn", "run"],
  ["zsh"],
  ["zsh", "-c"],
  ["zsh", "-lc"],
];

export const SHELL_SET = new Set(SHELLS.map((name) => name.toLowerCase()));
export const INTERPRETER_SET = new Set(INTERPRETERS.map((name) => name.toLowerCase()));
export const WRAPPER_SET = new Set(WRAPPERS.map((name) => name.toLowerCase()));
export const RUNNER_SET = new Set(PACKAGE_RUNNERS);

// Checked before parsing commands that could satisfy a reusable allow rule.
export const MAX_LITERAL_COMMAND_LENGTH = 2_000;

const POWERSHELL_LAUNCHERS = new Set(["pwsh", "pwsh-preview", "powershell", "powershell_ise"]);

export function isPowerShellLauncher(token: string): boolean {
  return POWERSHELL_LAUNCHERS.has(canonicalPowerShellName(token).replace(/\.exe$/i, ""));
}

// Canonical executable identity for visible-floor and restriction matching.
export function programName(token: string): string {
  const base = (token.split(/[\\/]/).pop() ?? token).toLowerCase();
  const name = base.replace(/\.exe$/i, "").replace(/^(python[23]?)\.\d+$/, "$1");
  if (INTERPRETER_SET.has(name) || SHELL_SET.has(name)) return name;
  const versioned = /^(.+?)(?:\d+(?:\.\d+)*|x)$/.exec(name);
  const stem = versioned?.[1];
  return stem && (INTERPRETER_SET.has(stem) || SHELL_SET.has(stem)) ? stem : name;
}

// Runner shims share the executable/script suffixes and retain versioned identity.
export function runnerName(token: string): string {
  const base = (token.split(/[\\/]/).pop() ?? token).toLowerCase().replace(/[ .]+$/, "");
  const extension = /\.[^.]+$/.exec(base)?.[0] ?? "";
  const type = POWERSHELL_FILE_TYPES[extension];
  const name = type === "opaque" || type === "script" ? base.slice(0, -extension.length) : base;
  return name.replace(/@[^@]+$/, "");
}

// Program identities used by the argument-aware destructive floor below.
const DESTRUCTIVE_PROGRAMS = new Set(["rm", "shred", "srm", "wipefs", "dd", "mkfs", "newfs", "diskutil", "format"]);
// Programs whose ordinary file operands can irreversibly overwrite or remove data.
const OVERWRITING_PROGRAMS = new Set(["truncate", "unlink", "mv", "cp", "tee", "dropdb", "install"]);
// Ownership and mode changers: destructive when recursive or world-writable.
const PERMISSION_CHANGERS = new Set(["chmod", "chown", "chgrp"]);
function isDestructiveProgram(program: string): boolean {
  return DESTRUCTIVE_PROGRAMS.has(program) || program.startsWith("mkfs.") || program.startsWith("newfs_");
}

// `chmod -x file`: a leading mode removal reads like an option but is the mode operand.
const CHMOD_REMOVAL_MODE = /^[ugoa]*-[rwxXst]+$/;

// Options before `--` (GNU tools permute, so position does not matter); `undefined` is a dynamic word.
function optionWords(
  args: readonly (string | undefined)[],
  isOperand: (arg: string) => boolean = () => false,
): { options: (string | undefined)[]; operands: (string | undefined)[] } {
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
    } else if (!delimited && arg.startsWith("-") && arg !== "-" && !isOperand(arg)) {
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

// GNU long options accept any unambiguous abbreviation (`--rec`, `--forc`).
function hasLongFlag(options: readonly (string | undefined)[], names: readonly string[]): boolean {
  return options.some((option) => {
    if (option === undefined || !option.startsWith("--") || option.length < 3) return false;
    const name = option.slice(2).split("=")[0]!.toLowerCase();
    return names.some((candidate) => candidate.startsWith(name));
  });
}

// A mode that may make the target writable by everyone: `777`, `00777`, `o+w`, `a=rwx`, `+w`, or a copy such as `o=u` whose source may hold `w`. A mode this grammar cannot read counts as world-writable only where the caller asks (refusing a stored rule); the floor never guesses.
function worldWritableMode(mode: string | undefined, unreadableIsWritable: boolean): boolean {
  if (mode === undefined) return unreadableIsWritable;
  if (/^[0-7]+$/.test(mode)) return mode.length > 5 || ["2", "3", "6", "7"].includes(mode[mode.length - 1]!);
  return mode.split(",").some((clause) => {
    const symbolic = /^([ugoa]*)([-+=])([rwxXst]*|[ugo])$/.exec(clause);
    if (symbolic === null) return unreadableIsWritable;
    const [, who, operator, perms] = symbolic as unknown as [string, string, string, string];
    return operator !== "-" && (who === "" || /[oa]/.test(who)) && (perms.includes("w") || /^[ugo]$/.test(perms));
  });
}

// Argument-aware destructive floor for one static command: recursive or forced deletion in any option order or spelling, recursive or world-writable permission changes, raw disk writers and `find -delete`. A dynamic word in an option position counts as the worst case.
export function isDestructiveShellArgv(argv: readonly (string | undefined)[]): boolean {
  const head = argv[0];
  if (head === undefined) return false;
  const program = programName(head);
  const { options, operands } = optionWords(argv.slice(1), program === "chmod" ? (arg) => CHMOD_REMOVAL_MODE.test(arg) : undefined);
  const dynamicOption = options.includes(undefined);
  if (program === "rm") {
    return dynamicOption || hasShortFlag(options, "rRf") || hasLongFlag(options, ["recursive", "force", "no-preserve-root"]);
  }
  if (isDestructiveProgram(program)) return program !== "dd" || argv.slice(1).some((arg) => arg === undefined || /^of=/i.test(arg));
  if (PERMISSION_CHANGERS.has(program)) {
    if (dynamicOption || hasShortFlag(options, "R") || hasLongFlag(options, ["recursive"])) return true;
    // `--reference=FILE` copies a mode the rule cannot see.
    return program === "chmod" && (hasLongFlag(options, ["reference"]) || worldWritableMode(operands[0], false));
  }
  if (program === "find") {
    const args = argv.slice(1);
    return args.some((arg, index) => arg === undefined || arg === "-delete"
      || (["-exec", "-execdir", "-ok", "-okdir"].includes(arg) && isDestructiveShellArgv(execArgv(args, index + 1))));
  }
  return false;
}

// Irreversible commands retain per-call consent, regardless of allow rules.
export function noReusableRuleReason(argv: readonly (string | undefined)[]): string | null {
  return isIrreversibleShellArgv(argv) ? "irreversible command" : null;
}

// The first word after a tool's leading options (`git -C dir clean` → `clean`); options that take a value skip it.
function verbIndex(argv: readonly (string | undefined)[], valued: ReadonlySet<string>): number {
  let index = 1;
  while (index < argv.length) {
    const word = argv[index];
    if (word === undefined || !word.startsWith("-")) return index;
    index += valued.has(word) ? 2 : 1;
  }
  return index;
}

const GIT_VALUED_OPTIONS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path"]);
const DOCKER_VALUED_OPTIONS = new Set(["-H", "--host", "--context", "-c", "--config", "-l", "--log-level"]);
const KUBECTL_VALUED_OPTIONS = new Set(["-n", "--namespace", "--context", "--kubeconfig", "-s", "--server", "--cluster", "--user"]);

// Non-option words after the program, in order (`gh -R o/r repo delete` → `repo`, `delete`).
function verbWords(argv: readonly (string | undefined)[], valued: ReadonlySet<string>): (string | undefined)[] {
  const words: (string | undefined)[] = [];
  for (let index = 1; index < argv.length; index += 1) {
    const word = argv[index];
    if (word !== undefined && word.startsWith("-")) {
      if (valued.has(word)) index += 1;
      continue;
    }
    words.push(word);
  }
  return words;
}

// The value of `-X DELETE`, `-XDELETE`, `--method DELETE` or `--method=DELETE`; `undefined` when dynamic.
function httpMethods(argv: readonly (string | undefined)[]): (string | undefined)[] {
  const methods: (string | undefined)[] = [];
  argv.forEach((word, index) => {
    if (word === undefined) return;
    if (word === "-X" || word === "--method") methods.push(argv[index + 1]);
    else if (/^-X./.test(word)) methods.push(word.slice(2));
    else if (word.startsWith("--method=")) methods.push(word.slice("--method=".length));
  });
  return methods;
}

const GH_VALUED_OPTIONS = new Set(["-R", "--repo", "-X", "--method", "-H", "--header", "-f", "-F", "--field", "--raw-field", "--hostname", "--jq", "-q", "-t", "--template", "--input"]);
const AWS_VALUED_OPTIONS = new Set(["--profile", "--region", "--endpoint-url", "--output", "--query"]);

// Irreversible forms included in the per-call floor: they discard work or data the user cannot get back (`git clean -f`, `git reset --hard`, `git checkout --.`, `git restore`, `git stash drop`, `docker … prune`, `kubectl delete`, `mv`, `tee`, `truncate`, `unlink`). No allow rule covers them; each invocation needs user consent. A dynamic word counts as the worst case.
function isIrreversibleShellArgv(argv: readonly (string | undefined)[]): boolean {
  const head = argv[0];
  if (head === undefined) return false;
  const program = programName(head);
  if (OVERWRITING_PROGRAMS.has(program)) {
    if (program !== "tee") return true;
    const { options, operands } = optionWords(argv.slice(1));
    // `tee` without a file only copies to stdout; `-a` appends instead of overwriting.
    return operands.length > 0 && !(hasShortFlag(options, "a") || hasLongFlag(options, ["append"]));
  }
  if (program === "git") {
    const at = verbIndex(argv, GIT_VALUED_OPTIONS);
    const verb = argv[at];
    if (verb === undefined) return at < argv.length;
    const { options, operands } = optionWords(argv.slice(at + 1));
    const delimited = argv.slice(at + 1).includes("--");
    const dynamic = options.includes(undefined);
    switch (verb) {
      case "switch":
        return dynamic || hasShortFlag(options, "fC") || hasLongFlag(options, ["force", "discard-changes", "force-create"]);
      case "branch":
        return dynamic || hasShortFlag(options, "dDMCf") || hasLongFlag(options, ["delete", "force"]);
      case "push":
        return dynamic || hasShortFlag(options, "fd") || hasLongFlag(options, ["force", "force-with-lease", "force-if-includes", "delete", "mirror", "prune"])
          || operands.some((operand) => operand === undefined || operand.startsWith("+") || operand.startsWith(":"));
      case "clean":
        return dynamic || !(hasShortFlag(options, "n") || hasLongFlag(options, ["dry-run"]));
      case "reset":
        return dynamic || hasLongFlag(options, ["hard", "merge", "keep"]);
      case "checkout": {
        // `git checkout <name>` restores a file of that name as readily as it switches branch, so any operand counts. Only `-b <new> [<start>]` is storable; `git switch <branch>` is the reusable spelling.
        const creates = hasShortFlag(options, "b") && !hasShortFlag(options, "B");
        return dynamic || delimited || hasShortFlag(options, "fpB") || hasLongFlag(options, ["force", "patch", "theirs", "ours", "pathspec-from-file"])
          || (creates ? operands.length > 2 : operands.length > 0);
      }
      case "restore":
        // Only `--staged` alone leaves the working tree untouched.
        return dynamic || !(hasShortFlag(options, "S") || hasLongFlag(options, ["staged"]))
          || hasShortFlag(options, "W") || hasLongFlag(options, ["worktree"]);
      case "stash":
        return operands[0] === undefined ? argv.length > at + 1 && dynamic : operands[0] === "drop" || operands[0] === "clear";
      case "gc":
        return dynamic || hasLongFlag(options, ["prune"]);
      // Option-only forms (`git remote -v`, `git reflog`) read; a dynamic subcommand counts as the worst case.
      case "reflog":
        if (operands.length === 0) return dynamic;
        return operands[0] === undefined || operands[0] === "expire" || operands[0] === "delete";
      case "worktree":
        if (operands.length === 0) return dynamic;
        return operands[0] === undefined || operands[0] === "prune"
          || (operands[0] === "remove" && (dynamic || hasShortFlag(options, "f") || hasLongFlag(options, ["force"])));
      case "prune":
        return true;
      case "tag":
        return dynamic || hasShortFlag(options, "d") || hasLongFlag(options, ["delete"]);
      case "remote":
        // Only the mutating subcommands; `-v`, `show`, `get-url` read.
        if (operands.length === 0) return dynamic;
        return operands[0] === undefined || ["remove", "rm", "rename", "set-url", "prune"].includes(operands[0]);
      case "pull":
        return dynamic || hasShortFlag(options, "f") || hasLongFlag(options, ["force"]);
      case "update-ref":
        return dynamic || hasShortFlag(options, "d") || hasLongFlag(options, ["stdin"]);
      case "fetch":
        // Forced or pruning fetches drop local refs; `+src:dst` forces one.
        return dynamic || hasShortFlag(options, "fpP") || hasLongFlag(options, ["force", "prune", "prune-tags"])
          || operands.some((operand) => operand === undefined || operand.startsWith("+"));
      default:
        return false;
    }
  }
  if (program === "docker" || program === "podman" || program === "nerdctl" || program === "docker-compose") {
    const words = verbWords(argv, DOCKER_VALUED_OPTIONS).slice(0, 3);
    const { options } = optionWords(argv.slice(1));
    if (words.some((word) => word === undefined || word === "prune" || word === "rm" || word === "rmi")) return true;
    // `docker compose down -v` deletes named volumes; `--rmi` deletes images.
    return words.includes("down") && (hasShortFlag(options, "v") || hasLongFlag(options, ["volumes", "rmi"]));
  }
  if (program === "kubectl") {
    const verb = verbWords(argv, KUBECTL_VALUED_OPTIONS)[0];
    const { options } = optionWords(argv.slice(1));
    if (verb === undefined) return argv.length > 1;
    if (verb === "delete" || verb === "drain") return true;
    return (verb === "apply" || verb === "replace") && hasLongFlag(options, ["prune", "force"]);
  }
  if (program === "gh") {
    const words = verbWords(argv, GH_VALUED_OPTIONS);
    if (words.slice(0, 3).some((word) => word === undefined || word === "delete")) return true;
    return words[0] === "api" && httpMethods(argv).some((method) => method === undefined || method.toUpperCase() === "DELETE");
  }
  if (program === "helm") {
    const verb = verbWords(argv, new Set(["-n", "--namespace", "--kube-context", "--kubeconfig"]))[0];
    return verb === undefined ? argv.length > 1 : ["uninstall", "delete", "del", "un"].includes(verb);
  }
  if (program === "terraform" || program === "tofu") {
    const words = verbWords(argv, new Set(["-chdir"]));
    if (words[0] === undefined) return argv.length > 1;
    if (words[0] === "destroy" || (words[0] === "state" && (words[1] === "rm" || words[1] === undefined))) return true;
    return words[0] === "apply" && argv.some((word) => word === undefined || word === "-destroy" || word === "--destroy");
  }
  if (program === "aws") {
    const words = verbWords(argv, AWS_VALUED_OPTIONS);
    const operation = words[1];
    if (operation === undefined) return words.length > 1;
    if (/^(?:rm|rb|delete-|terminate-|remove-|deregister-|purge-)/.test(operation)) return true;
    return argv.some((word) => word === undefined || word === "--delete");
  }
  if (program === "rsync") {
    const { options } = optionWords(argv.slice(1));
    return options.includes(undefined) || hasLongFlag(options, ["delete", "delete-before", "delete-during", "delete-delay", "delete-after", "delete-excluded", "remove-source-files"]);
  }
  if (program === "ln") {
    const { options } = optionWords(argv.slice(1));
    return options.includes(undefined) || hasShortFlag(options, "f") || hasLongFlag(options, ["force"]);
  }
  if (program === "npm" || program === "pnpm" || program === "yarn") {
    // `yarn npm unpublish` (Berry) as well as `npm unpublish`.
    return verbWords(argv, new Set()).slice(0, 2).some((word) => word === undefined || word === "unpublish");
  }
  if (program === "xattr") {
    // `-c` clears every attribute and `-d` deletes one; `-w` only writes.
    const { options } = optionWords(argv.slice(1));
    return options.includes(undefined) || hasShortFlag(options, "cd");
  }
  if (program === "redis-cli") {
    return argv.slice(1).some((word) => word === undefined || /^flush(?:all|db)$/i.test(word));
  }
  return false;
}

// The command a `find -exec` runs, up to its `;` or `+` terminator.
function execArgv(args: readonly (string | undefined)[], start: number): (string | undefined)[] {
  const end = args.findIndex((arg, index) => index >= start && (arg === ";" || arg === "+"));
  return args.slice(start, end < 0 ? undefined : end);
}

export type RefusedPrefixReason = "destructive" | "empty" | "broad-prefix";

// An option leaves the command boundary unknown until a literal delimiter.
export function literalCommandAfterPrefix(tokens: readonly (string | undefined)[], start: number): number | undefined {
  const token = tokens[start];
  if (token === undefined || token.length === 0) return undefined;
  if (!token.startsWith("-")) return start;
  const delimiter = tokens.indexOf("--", start);
  const command = delimiter < 0 ? undefined : tokens[delimiter + 1];
  return command !== undefined && command.length > 0 && !command.startsWith("-") ? delimiter + 1 : undefined;
}

// Exact rules may name a broad program; wildcard rules must name a bounded prefix.
export function refusedShellPrefix(tokens: readonly string[], wildcard = true): RefusedPrefixReason | null {
  if (tokens.length === 0) return "empty";
  if (isDestructiveShellArgv(tokens) || noReusableRuleReason(tokens) !== null) return "destructive";
  if (wildcard && BANNED_PREFIX_SUGGESTIONS.some((banned) =>
    banned.length <= tokens.length && banned.every((token, index) =>
      index === 0 ? programName(token) === programName(tokens[0]!) : token === tokens[index])
    && tokens.slice(banned.length).every((token) => token.startsWith("-") || /^[A-Za-z_][A-Za-z0-9_.]*=/.test(token)))) return "broad-prefix";
  return null;
}
