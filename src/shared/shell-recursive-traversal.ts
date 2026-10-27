import { isShellExecutionWrapper, stripCommandPath } from "./shell-effective-command.js";

// Commands that walk a directory tree, and the flags that make others do so.
export const RECURSIVE_TRAVERSAL_COMMANDS: ReadonlySet<string> = new Set([
  "fd",
  "fdfind",
  "find",
  "rg",
  "tar",
  "tree",
  "unzip",
  "zip",
]);

const RECURSIVE_FLAG_COMMANDS: ReadonlyMap<string, readonly string[]> = new Map<string, readonly string[]>([
  ["cp", ["-r", "-R", "--recursive", "-a", "--archive"]],
  ["du", ["-a", "--all"]],
  ["egrep", ["-r", "-R", "--recursive", "--dereference-recursive"]],
  ["fgrep", ["-r", "-R", "--recursive", "--dereference-recursive"]],
  ["grep", ["-r", "-R", "--recursive", "--dereference-recursive"]],
  ["ls", ["-R"]],
  ["mv", ["-r", "-R", "--recursive"]],
]);

function hasShellFlag(token: string, flag: string): boolean {
  if (token === flag) return true;
  if (flag.length === 2 && /^-[A-Za-z]+$/.test(token)) {
    return token.slice(1).includes(flag[1]);
  }
  if (flag.startsWith("--")) {
    return token === flag || token.startsWith(flag + "=");
  }
  return false;
}

/** The recursion-selecting flag in `argv` (after `argv[0]`), if `verb` takes one. */
export function recursiveTraversalFlag(verb: string, argv: readonly (string | undefined)[]): string | undefined {
  const flags = RECURSIVE_FLAG_COMMANDS.get(verb);
  if (flags === undefined || argv[1] === "--") return undefined;
  return argv.slice(1).find((argument): argument is string => argument !== undefined && flags.some((flag) => hasShellFlag(argument, flag)));
}

// The MXC gate's wider view; findShellPathPolicyViolation keeps the two tables above.
const WALKS_BY_DEFAULT: ReadonlySet<string> = new Set(["du"]);
const MXC_RECURSIVE_FLAGS: ReadonlyMap<string, readonly string[]> = new Map<string, readonly string[]>([
  ["chgrp", ["-R", "--recursive"]],
  ["chmod", ["-R", "--recursive"]],
  ["chown", ["-R", "--recursive"]],
  ["rm", ["-r", "-R", "--recursive"]],
  ["rsync", ["-r", "-a", "--recursive", "--archive"]],
  ["scp", ["-r"]],
]);
// Their payload is another command line the literal view cannot see.
const OPAQUE_PAYLOAD_COMMANDS: ReadonlySet<string> = new Set([
  ".", "bash", "busybox", "dash", "doas", "eval", "exec", "fish", "ksh", "source", "sh", "su", "sudo", "zsh",
]);
// Commands known not to walk a tree on their own; any other command counts as walking.
const FLAT_COMMANDS: ReadonlySet<string> = new Set([
  ":", "[", "base64", "basename", "cat", "cd", "cmp", "comm", "cut", "date", "diff", "dirname", "echo", "false", "file",
  "head", "hostname", "id", "jq", "ln", "md5sum", "mkdir", "nl", "paste", "printf", "pwd", "readlink", "realpath", "rmdir",
  "sed", "sha1sum", "sha256sum", "sleep", "sort", "stat", "tac", "tail", "test", "touch", "tr", "true", "type", "uname",
  "uniq", "wc", "which", "whoami",
]);

/** Literal argv view: true when the command may walk a tree. Behind a wrapper the wrapped command decides; unknown, opaque and dynamic commands count as walking. */
export function mayTraverseRecursively(argv: readonly (string | undefined)[]): boolean {
  let wrapped = false;
  for (let index = 0; index < argv.length; index += 1) {
    const word = argv[index];
    if (word === undefined) return true;
    // Wrapper operands: options, environment assignments and durations or priorities.
    if (wrapped && /^(?:-.*|[A-Za-z_][A-Za-z0-9_]*=.*|[+-]?\d+(?:\.\d+)?[smhd]?)$/.test(word)) continue;
    const verb = stripCommandPath(word);
    if (isShellExecutionWrapper(verb)) { wrapped = true; continue; }
    if (RECURSIVE_TRAVERSAL_COMMANDS.has(verb) || WALKS_BY_DEFAULT.has(verb) || OPAQUE_PAYLOAD_COMMANDS.has(verb)) return true;
    const rest = argv.slice(index);
    // A dynamic argument may be the recursion flag.
    if ((RECURSIVE_FLAG_COMMANDS.has(verb) || MXC_RECURSIVE_FLAGS.has(verb)) && rest.includes(undefined)) return true;
    if (RECURSIVE_FLAG_COMMANDS.has(verb)) return recursiveTraversalFlag(verb, rest) !== undefined;
    const flags = MXC_RECURSIVE_FLAGS.get(verb);
    if (flags !== undefined) return rest.slice(1).some(argument => argument !== undefined && flags.some(flag => hasShellFlag(argument, flag)));
    if (verb === "git") return rest.slice(1).some(argument => argument === undefined || argument === "grep");
    return !FLAT_COMMANDS.has(verb);
  }
  return false;
}
