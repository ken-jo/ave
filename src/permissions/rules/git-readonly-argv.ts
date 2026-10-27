const CONFIGURATION = Object.freeze([
  ["core.fsmonitor", "false"],
  ["core.hooksPath", "/dev/null"],
  ["diff.autoRefreshIndex", "false"],
  ["diff.submodule", "short"],
  ["status.submoduleSummary", "false"],
  ["submodule.recurse", "false"],
  ["log.showSignature", "false"],
  ["format.pretty", "medium"],
] as const);

const GLOBAL_ARGUMENTS = Object.freeze(["--no-pager", "--no-lazy-fetch", "--no-optional-locks"]);
const DIFF_ARGUMENTS = Object.freeze([
  "--no-ext-diff", "--no-textconv", "--ignore-submodules=all", "--submodule=short", "--no-renames",
]);
const REVISION_QUERIES = new Set([
  "--show-toplevel", "--show-prefix", "--git-dir", "--absolute-git-dir",
  "--is-inside-work-tree", "--is-bare-repository",
]);
const DIFF_OUTPUTS = new Set(["--name-only", "--name-status", "--raw"]);
const ENVIRONMENT_SELECTORS = /^(?:GIT_.*|PAGER|LD_.*|DYLD_.*|_RLD.*|LDR_.*|LIBPATH|SHLIB_PATH|GCONV_PATH|BASH_ENV|ENV|ZDOTDIR|SHELLOPTS|BASHOPTS|BASH_FUNC_.*|CDPATH|IFS|NODE_OPTIONS|NODE_PATH|PYTHONPATH|PYTHONHOME|PERL5OPT|PERL5LIB|RUBYOPT|RUBYLIB)$/i;

function isRevision(value: string): boolean {
  const match = /^([A-Za-z0-9_][A-Za-z0-9_./-]*)(?:(?:~|\^)[0-9]+)*$/.exec(value);
  if (match === null) return false;
  const name = match[1]!;
  return !name.includes("..") && name.split("/").every((part) =>
    /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(part) && !part.endsWith(".") && !part.endsWith(".lock"));
}

function isRevisionRange(value: string): boolean {
  if (isRevision(value)) return true;
  const parts = value.split(/\.{2,3}/);
  return parts.length === 2 && parts.every(isRevision) && !value.includes("....");
}

function historyArguments(command: string, args: readonly string[]): readonly string[] | null {
  let revision: string | undefined;
  let count: string | undefined;
  let oneline = false;
  let noPatch = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--no-patch" && !noPatch) {
      noPatch = true;
    } else if (command === "log" && arg === "--oneline" && !oneline) {
      oneline = true;
    } else if (command === "log" && (arg === "-n" || arg === "--max-count" || arg.startsWith("--max-count="))) {
      if (count !== undefined) return null;
      const value = arg.startsWith("--max-count=") ? arg.slice("--max-count=".length) : args[++index];
      if (value === undefined || !/^(?:0|[1-9][0-9]*)$/.test(value)) return null;
      count = value;
    } else if (revision === undefined && (command === "log" ? isRevisionRange(arg) : isRevision(arg))) {
      revision = arg;
    } else {
      return null;
    }
  }
  if (command === "show" && !noPatch) return null;
  return [command, ...DIFF_ARGUMENTS, "--no-show-signature", "--no-patch",
    ...(oneline ? ["--format=oneline", "--abbrev-commit"] : ["--format=medium", "--notes"]),
    ...(count === undefined ? [] : [`--max-count=${count}`]), ...(revision === undefined ? [] : [revision]), "--"];
}

function differenceArguments(args: readonly string[]): readonly string[] | null {
  let cached = false;
  let output: string | undefined;
  const revisions: string[] = [];
  for (const arg of args) {
    if ((arg === "--cached" || arg === "--staged") && !cached) {
      cached = true;
    } else if (DIFF_OUTPUTS.has(arg) && output === undefined) {
      output = arg;
    } else if (isRevision(arg) && revisions.length < 2) {
      revisions.push(arg);
    } else {
      return null;
    }
  }
  if (output === undefined || (cached ? revisions.length > 1 : revisions.length !== 2)) return null;
  return ["diff", ...DIFF_ARGUMENTS, ...(cached ? ["--cached"] : []), output, ...revisions, "--"];
}

function revisionArguments(args: readonly string[]): readonly string[] | null {
  if (args.length === 1 && REVISION_QUERIES.has(args[0]!)) return ["rev-parse", ...args];
  if (args[0] !== "--verify") return null;
  const quiet = args[1] === "--quiet";
  if (args.length !== (quiet ? 3 : 2) || !isRevision(args[quiet ? 2 : 1]!)) return null;
  return ["rev-parse", ...args];
}

function branchArguments(args: readonly string[]): readonly string[] | null {
  let list = false;
  let scope: string | undefined;
  for (const arg of args) {
    if (arg === "--list" && !list) {
      list = true;
    } else if (scope === undefined && (arg === "-a" || arg === "--all" || arg === "-r" || arg === "--remotes")) {
      scope = arg === "-a" || arg === "--all" ? "--all" : "--remotes";
    } else {
      return null;
    }
  }
  return list ? ["branch", "--no-sort", "--sort=refname", "--list", "--no-column", "--no-color",
    ...(scope === undefined ? [] : [scope])] : null;
}

/** Produces owned native arguments only; executable verification belongs to the caller. */
export function readOnlyGitArguments(argv: readonly string[]): readonly string[] | null {
  if (argv[0] !== "git" || argv.length < 2 || argv.length > 2_000) return null;
  let length = 0;
  for (const arg of argv) {
    length += arg.length;
    if (arg.length === 0 || /[\x00-\x1f\x7f]/.test(arg) || length > 65_536) return null;
  }
  const args = argv.slice(2);
  let result: readonly string[] | null;
  switch (argv[1]) {
    case "log":
    case "show": result = historyArguments(argv[1], args); break;
    case "diff": result = differenceArguments(args); break;
    case "rev-parse": result = revisionArguments(args); break;
    case "branch": result = branchArguments(args); break;
    default: return null;
  }
  return result === null ? null : Object.freeze([...GLOBAL_ARGUMENTS, ...result]);
}

/** POSIX-only child configuration; repository read-path confinement is separate. */
export function gitReadOnlyEnvironment(base: Readonly<Record<string, string>>): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (!ENVIRONMENT_SELECTORS.test(key)) environment[key] = value;
  }
  Object.assign(environment, {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_COUNT: String(CONFIGURATION.length),
    GIT_NO_LAZY_FETCH: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ALLOW_PROTOCOL: "",
  });
  for (const [index, [key, value]] of CONFIGURATION.entries()) {
    environment[`GIT_CONFIG_KEY_${index}`] = key;
    environment[`GIT_CONFIG_VALUE_${index}`] = value;
  }
  return environment;
}

export function isSupportedGitVersion(output: string): boolean {
  const match = /^git version (0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})(?:\r?\n)?$/.exec(output);
  if (match === null || match[0] !== output) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major === 2 && minor >= 45;
}
