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
 * The wildcard allowlist (owner decision 2026-10-23). Only a `Bash(<prefix> *)`
 * rule that starts with one of these keys, and keeps at least the listed
 * number of tokens, may be stored or suggested as "always allow". The number
 * is also how many leading tokens a suggestion keeps, so `git branch --list`
 * suggests `Bash(git branch --list *)` and `Bash(git branch *)` is refused.
 * Every other command can be saved only as an exact rule for its full argv.
 *
 * An entry must not be widenable: whatever a trailing `*` can append must stay
 * read-only and local. Not in the catalog, by rule (owner decision
 * 2026-10-23, round 3):
 * - package-script runners (`npm test`, `npm run <script>`): a script body or
 *   test file is agent-editable code, the reason interpreters are refused;
 * - network clients and fetchers (`git fetch`): egress to any URL.
 * Those get exact rules only.
 *
 * To add an entry, confirm that no argument a trailing `*` can append reaches
 * a destructive, irreversible or unreusable form (`isDestructiveShellArgv`,
 * `noReusableRuleReason`), and that its writing or code-running options are
 * caught by `shellOptionEffect`. Add a hit and a miss test in
 * `rules-language.test.ts`.
 */
export const WILDCARD_PREFIX_CATALOG: ReadonlyMap<string, number> = new Map([
  // Read-only file and text inspection.
  ["ls", 1], ["cat", 1], ["head", 1], ["tail", 1], ["wc", 1], ["grep", 1], ["rg", 1], ["find", 1],
  ["pwd", 1], ["du", 1], ["df", 1], ["which", 1], ["stat", 1],
  // Repository inspection.
  ["git status", 2], ["git log", 2], ["git diff", 2], ["git show", 2],
  ["git rev-parse", 2], ["git ls-files", 2], ["git blame", 2], ["git branch --list", 3],
  // Cluster and container inspection. `kubectl` credentials, cluster
  // re-targeting and secrets are kept out by `noReusableRuleReason`.
  ["kubectl get", 2], ["kubectl describe", 2], ["kubectl logs", 2],
  ["docker ps", 2], ["docker images", 2], ["docker logs", 2],
]);

function catalogKeyMatches(key: string, tokens: readonly string[]): boolean {
  const keyTokens = key.split(" ");
  return keyTokens.length <= tokens.length && programName(tokens[0]!) === keyTokens[0]
    && keyTokens.every((token, index) => index === 0 || tokens[index] === token);
}

/** The catalog key a static argv starts with (longest first), or null. */
export function wildcardCatalogKey(argv: readonly string[]): string | null {
  let best: string | null = null;
  for (const key of WILDCARD_PREFIX_CATALOG.keys()) {
    if (catalogKeyMatches(key, argv) && (best === null || key.split(" ").length > best.split(" ").length)) best = key;
  }
  return best;
}

/** Whether a wildcard prefix stays inside one catalog entry. */
function wildcardCatalogCovers(tokens: readonly string[]): boolean {
  const key = wildcardCatalogKey(tokens);
  return key !== null && tokens.length >= WILDCARD_PREFIX_CATALOG.get(key)!;
}
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
/**
 * Programs that irreversibly overwrite or remove their file operands in
 * ordinary use. Refused as allow prefixes at every length; unlike the
 * destructive floor they keep once and session choices.
 */
const OVERWRITING_PROGRAMS = new Set(["truncate", "unlink", "mv", "cp", "tee", "dropdb", "install"]);
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

/** `chmod -x file`: a leading mode removal reads like an option but is the mode operand. */
const CHMOD_REMOVAL_MODE = /^[ugoa]*-[rwxXst]+$/;

/** Options before `--` (GNU tools permute, so position does not matter); `undefined` is a dynamic word. */
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

/** GNU long options accept any unambiguous abbreviation (`--rec`, `--forc`). */
function hasLongFlag(options: readonly (string | undefined)[], names: readonly string[]): boolean {
  return options.some((option) => {
    if (option === undefined || !option.startsWith("--") || option.length < 3) return false;
    const name = option.slice(2).split("=")[0]!.toLowerCase();
    return names.some((candidate) => candidate.startsWith(name));
  });
}

/**
 * A mode that may make the target writable by everyone: `777`, `00777`,
 * `o+w`, `a=rwx`, `+w`, or a copy such as `o=u` whose source may hold `w`.
 * A mode this grammar cannot read counts as world-writable only where the
 * caller asks (refusing a stored rule); the floor never guesses.
 */
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

/**
 * `kubectl` options that switch credentials or cluster (`--kubeconfig`,
 * `--token`, `--as`, `-s`/`--server`, …) or reach the raw API (`--raw`).
 * A reusable rule never covers them, wherever they appear.
 */
const KUBECTL_RETARGETING_OPTIONS = new Set([
  "kubeconfig", "server", "token", "context", "cluster", "user", "as", "as-group", "as-uid",
  "certificate-authority", "insecure-skip-tls-verify", "raw",
]);

function kubectlRetargets(argv: readonly (string | undefined)[]): boolean {
  return argv.slice(1).some((word) => {
    if (word === undefined) return true;
    if (/^-s(?:$|=|.)/.test(word) && !word.startsWith("--")) return true;
    if (!word.startsWith("--")) return false;
    const name = word.slice(2).split("=")[0]!.toLowerCase();
    return KUBECTL_RETARGETING_OPTIONS.has(name) || name.startsWith("client-");
  });
}

/** `secret`, `secrets`, `secret/<name>`, `secrets.v1`, or one of a comma list. */
function kubectlNamesSecrets(argv: readonly (string | undefined)[]): boolean {
  return verbWords(argv, KUBECTL_VALUED_OPTIONS).slice(1).some((word) => word === undefined
    || word.toLowerCase().split(",").some((part) => /^secrets?(?:$|[./])/.test(part)));
}

/**
 * Package-script runner options that load other code or switch the project:
 * `--script-shell`, `--node-options`, `--preload`, `--prefix`, `--cwd`,
 * `--filter`, `-r`/`--recursive`, `-w`/`--workspace`.
 */
const RUNNER_CODE_OPTIONS = ["script-shell", "node-options", "preload", "prefix", "cwd", "filter", "recursive", "workspace", "workspaces"];

function runnerLoadsOtherCode(argv: readonly (string | undefined)[]): boolean {
  const { options } = optionWords(argv.slice(1));
  return options.includes(undefined) || hasShortFlag(options, "rw")
    || options.some((option) => option !== undefined && option.startsWith("--")
      && RUNNER_CODE_OPTIONS.includes(option.slice(2).split("=")[0]!.toLowerCase()))
    || hasLongFlag(options, RUNNER_CODE_OPTIONS);
}

/**
 * Why no allow rule, exact or wildcard, may cover this static command, or
 * null. Once and session approvals stay available. The matcher, the dock and
 * the store share it:
 * - irreversible forms ({@link isIrreversibleShellArgv});
 * - `kubectl` with credential or cluster re-targeting options, or naming
 *   secrets;
 * - a package-script runner with options that load other code or switch the
 *   project (`npm run build --script-shell=./x.sh`, `bun test --preload x`).
 */
export function noReusableRuleReason(argv: readonly (string | undefined)[]): string | null {
  if (isIrreversibleShellArgv(argv)) return "irreversible command";
  const head = argv[0];
  if (head === undefined) return null;
  const program = programName(head);
  if (program === "kubectl" && kubectlRetargets(argv)) return "kubectl credential or cluster option";
  if (program === "kubectl" && kubectlNamesSecrets(argv)) return "kubectl secrets";
  if (["npm", "pnpm", "yarn", "bun"].includes(runnerName(head)) && runnerLoadsOtherCode(argv)) return "runner option that loads other code";
  return null;
}

/** The first word after a tool's leading options (`git -C dir clean` → `clean`); options that take a value skip it. */
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

/** Non-option words after the program, in order (`gh -R o/r repo delete` → `repo`, `delete`). */
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

/** The value of `-X DELETE`, `-XDELETE`, `--method DELETE` or `--method=DELETE`; `undefined` when dynamic. */
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

/**
 * Irreversible forms that are not floors: they discard work or data the user
 * cannot get back (`git clean -f`, `git reset --hard`, `git checkout -- .`,
 * `git restore`, `git stash drop`, `docker … prune`, `kubectl delete`, `mv`,
 * `tee`, `truncate`, `unlink`). No allow rule covers them; once and session
 * approvals stay available. A dynamic word counts as the worst case.
 */
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
        // `git checkout <name>` restores a file of that name as readily as it
        // switches branch, so any operand counts. Only `-b <new> [<start>]`
        // is storable; `git switch <branch>` is the reusable spelling.
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
      case "reflog":
        return operands[0] === undefined ? argv.length > at + 1 : operands[0] === "expire" || operands[0] === "delete";
      case "worktree":
        if (operands[0] === undefined) return argv.length > at + 1;
        return operands[0] === "prune" || (operands[0] === "remove" && (dynamic || hasShortFlag(options, "f") || hasLongFlag(options, ["force"])));
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

/** The command a `find -exec` runs, up to its `;` or `+` terminator. */
function execArgv(args: readonly (string | undefined)[], start: number): (string | undefined)[] {
  const end = args.findIndex((arg, index) => index >= start && (arg === ";" || arg === "+"));
  return args.slice(start, end < 0 ? undefined : end);
}

export type RefusedPrefixReason =
  | "destructive"
  | "not-allowlisted"
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
 * `Bash(<tokens> *)` rule, or with `wildcard: false` the whole argv of an
 * exact `Bash(<tokens>)` rule. Returns the reason when it may not become a
 * persistent allow rule. A wildcard must also stay inside
 * {@link WILDCARD_PREFIX_CATALOG}; exact rules need only pass the structural
 * refusals (destructive, irreversible, wrappers, shells, interpreters, …).
 */
export function refusedShellPrefix(tokens: readonly string[], wildcard = true): RefusedPrefixReason | null {
  const structural = structuralRefusal(tokens, wildcard);
  if (structural !== null) return structural;
  return wildcard && !wildcardCatalogCovers(tokens) ? "not-allowlisted" : null;
}

function structuralRefusal(tokens: readonly string[], wildcard: boolean): RefusedPrefixReason | null {
  if (tokens.length === 0) return "empty";
  const program = programName(tokens[0]!);
  if (WRAPPER_SET.has(program)) return "wrapper";
  if (isDestructiveProgram(program) || OVERWRITING_PROGRAMS.has(program)) return "destructive";
  if (noReusableRuleReason(tokens) !== null) return "destructive";
  // A bare or recursive permission-changer prefix covers `chmod -R 777 /`;
  // a mode the grammar cannot read is refused here, never floored.
  if (PERMISSION_CHANGERS.has(program) && (tokens.length === 1 || isDestructiveShellArgv(tokens)
    || (program === "chmod" && worldWritableMode(optionWords(tokens.slice(1), (arg) => CHMOD_REMOVAL_MODE.test(arg)).operands[0], true)))) {
    return "destructive";
  }
  if (SHELL_SET.has(program)) return "shell";
  const runner = runnerName(tokens[0]!);
  if (RUNNER_SET.has(runner)) {
    const commandPrefix = RUNNER_COMMAND_PREFIXES[runner]!;
    const commandIndex = literalCommandAfterPrefix(tokens, 1);
    if (commandIndex === undefined) return "package-runner";
    const command = tokens[commandIndex]!;
    // A delegate specifier does not prove its delegated command boundary.
    if (runner === "corepack" && command.includes("@")) return "package-runner";
    if (runner === "corepack" && RUNNER_SET.has(runnerName(command))) return structuralRefusal(tokens.slice(commandIndex), wildcard);
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
