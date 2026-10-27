import { devNull } from "node:os";

const CONFIGURATION = Object.freeze([
  ["core.fsmonitor", "false"],
  ["core.hooksPath", devNull],
  ["core.attributesFile", devNull],
  ["core.excludesFile", devNull],
  ["core.untrackedCache", "false"],
  ["diff.autoRefreshIndex", "false"],
  ["diff.submodule", "short"],
  ["status.submoduleSummary", "false"],
  ["submodule.recurse", "false"],
  ["log.showSignature", "false"],
  ["log.mailmap", "false"],
  ["log.decorate", "false"],
  ["format.pretty", "medium"],
  ["color.ui", "false"],
  ["credential.helper", ""],
  ["credential.interactive", "false"],
  ["core.askPass", ""],
  ["protocol.allow", "never"],
  ["gc.auto", "0"],
  ["maintenance.auto", "false"],
] as const);
const GLOBAL_ARGUMENTS = Object.freeze([
  "--no-pager", "--no-lazy-fetch", "--no-optional-locks", "--no-replace-objects",
  ...CONFIGURATION.flatMap(([key, value]) => ["-c", `${key}=${value}`]),
]);
const DIFF_ARGUMENTS = Object.freeze([
  "--no-ext-diff", "--no-textconv", "--ignore-submodules=all", "--submodule=short", "--no-renames",
  "--no-color", "--no-relative", `-O${devNull}`,
]);
const REVISION_QUERIES = new Set([
  "--show-toplevel", "--show-prefix", "--git-dir", "--absolute-git-dir",
  "--is-inside-work-tree", "--is-bare-repository",
]);
const DIFF_OUTPUTS = new Set(["--name-only", "--name-status", "--raw"]);
const ENVIRONMENT_SELECTORS = /^(?:GIT_.*|PAGER|MANPAGER|LESS|LV|LD_.*|DYLD_.*|_RLD.*|LDR_.*|LIBPATH|SHLIB_PATH|GCONV_PATH|BASH_ENV|ENV|ZDOTDIR|SHELLOPTS|BASHOPTS|BASH_FUNC_.*|CDPATH|IFS|NODE_OPTIONS|NODE_PATH|NODE_REPL_EXTERNAL_MODULE|NODE_USE_ENV_PROXY|PYTHON.*|PERL.*|RUBY.*|GEM_.*|BUNDLE_.*|SSH_ASKPASS|SSH_ASKPASS_REQUIRE|SSH_AUTH_SOCK|SSLKEYLOGFILE)$/i;

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

function historyArguments(command: "log" | "show", args: readonly string[]): readonly string[] | null {
  let revision: string | undefined;
  let count: string | undefined;
  let oneline = false;
  let noPatch = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--no-patch" && !noPatch) {
      noPatch = true;
    } else if (arg === "--oneline" && !oneline) {
      oneline = true;
    } else if (command === "log" && (arg === "-n" || arg === "--max-count" || arg.startsWith("--max-count="))) {
      if (count !== undefined) return null;
      const value = arg.startsWith("--max-count=") ? arg.slice("--max-count=".length) : args[++index];
      if (value === undefined || !/^(?:0|[1-9][0-9]{0,5})$/.test(value)) return null;
      count = value;
    } else if (revision === undefined && (command === "log" ? isRevisionRange(arg) : isRevision(arg))) {
      revision = arg;
    } else {
      return null;
    }
  }
  if (command === "show" && !noPatch) return null;
  return [command, ...DIFF_ARGUMENTS, "--no-show-signature", "--no-patch", "--no-use-mailmap",
    "--no-notes", "--no-decorate", "--date=default", "--encoding=UTF-8",
    ...(oneline ? ["--format=oneline", "--abbrev-commit"] : ["--format=medium"]),
    ...(count === undefined ? [] : [`--max-count=${count}`]), ...(revision === undefined ? [] : [revision]), "--"];
}

function differenceArguments(args: readonly string[]): readonly string[] | null {
  let output: string | undefined;
  const revisions: string[] = [];
  for (const arg of args) {
    if (DIFF_OUTPUTS.has(arg) && output === undefined) {
      output = arg;
    } else if (isRevision(arg) && revisions.length < 2) {
      revisions.push(arg);
    } else {
      return null;
    }
  }
  // Index reads can update shared-index timestamps; worktree reads can run clean filters.
  if (output === undefined || revisions.length !== 2) return null;
  return ["diff", ...DIFF_ARGUMENTS, output, ...revisions, "--"];
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
  let sort: string | undefined;
  for (const arg of args) {
    if (arg === "--list" && !list) {
      list = true;
    } else if (scope === undefined && (arg === "-a" || arg === "--all" || arg === "-r" || arg === "--remotes")) {
      scope = arg === "-a" || arg === "--all" ? "--all" : "--remotes";
    } else if (sort === undefined && (arg === "--sort=refname" || arg === "--sort=-refname")) {
      sort = arg;
    } else {
      return null;
    }
  }
  return list ? ["branch", "--no-sort", sort ?? "--sort=refname", "--list", "--no-column", "--no-color",
    ...(scope === undefined ? [] : [scope])] : null;
}

/**
 * Accepts tokens including the literal executable and returns executable-free argv.
 * The caller must bind a checked installation and absolute inspected repository
 * roots, then execute with the matching owned environment.
 */
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

/** Repository identity is supplied only by the host's metadata inspection. */
export function gitReadOnlyEnvironment(
  base: Readonly<Record<string, string>>,
  repository: { readonly gitDirectory: string; readonly workTree: string; readonly referenceBackend: "files" },
): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (!ENVIRONMENT_SELECTORS.test(key)) environment[key] = value;
  }
  return Object.assign(environment, {
    GIT_DIR: repository.gitDirectory,
    GIT_WORK_TREE: repository.workTree,
    GIT_CEILING_DIRECTORIES: repository.workTree,
    GIT_DISCOVERY_ACROSS_FILESYSTEM: "0",
    GIT_REFERENCE_BACKEND: "files",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: devNull,
    GIT_CONFIG_SYSTEM: devNull,
    GIT_ATTR_NOSYSTEM: "1",
    GIT_NO_LAZY_FETCH: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ALLOW_PROTOCOL: "",
    GIT_PROTOCOL_FROM_USER: "0",
    GIT_PAGER: "",
    GIT_TRACE: "0",
    GIT_TRACE2: "0",
    GIT_TRACE2_EVENT: "0",
    GIT_TRACE2_PERF: "0",
  });
}

export function isSupportedGitVersion(output: string): boolean {
  const match = /^git version (0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})(?:\r?\n)?$/.exec(output);
  if (match === null || match[0] !== output) return false;
  return Number(match[1]) === 2 && Number(match[2]) >= 54;
}
