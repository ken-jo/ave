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

/** Literal argv view: true when the command may walk a tree. Behind a wrapper, the first known walker decides; unknown words count as walking. */
export function mayTraverseRecursively(argv: readonly (string | undefined)[]): boolean {
  for (let index = 0; index < argv.length; index += 1) {
    const word = argv[index];
    if (word === undefined) return true;
    const verb = stripCommandPath(word);
    if (RECURSIVE_TRAVERSAL_COMMANDS.has(verb)) return true;
    if (RECURSIVE_FLAG_COMMANDS.has(verb)) return recursiveTraversalFlag(verb, argv.slice(index)) !== undefined;
    if (index === 0 && !isShellExecutionWrapper(verb)) return false;
  }
  return false;
}
