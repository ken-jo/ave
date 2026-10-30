// Derive risk solely from host-owned evidence; unknown or path-bearing calls stay write-equivalent and only positive read-only proof can downgrade them. Do not trust plugin hints, perform I/O/global mutation or duplicate containment; isPathAllowed owns containment and the caller owns final permission (docs/architecture/architecture.md).
import type { ToolCategory } from "../../tools/types.js";
import type { PreparedShellAnalysis } from "../../shared/shell-analysis.js";
import { stripCommandPath, tokenizeShell, type ShellLeaf } from "../../shared/shell-tokenizer.js";
import { extractShellCommands } from "../../shared/shell-command-fields.js";
import { hasNetworkTarget } from "./network-target.js";
import { parseTarListing } from "../../shared/shell-tar-listing.js";
import type { ToolSource } from "../../shared/permission-review-status.js";

// Built-in read-only command set — the host-side allow-list model. A compound shell command is read-only ONLY IF every leaf command's head verb is in this set. Anything unknown or mutating escalates to `"shell"` (default-strict). Kept deliberately conservative — the cost of omitting a genuinely read-only command is an extra approval prompt (safe); the cost of wrongly including a mutating command would be a silent classify-down (unsafe). New entries must be provably side-effect-free in their bare form.
const READ_ONLY_COMMANDS: ReadonlySet<string> = new Set([
  // Pagers can run preprocessors or interactive shell escapes chosen by env, so argv cannot prove them read-only. cd is safe only when ordered path analysis resolves every later operand against the updated cwd; it changes no persistent state.
  "cd",
  "ls", "cat", "head", "tail", "pwd", "echo", "printf",
  "grep", "egrep", "fgrep", "rg", "ag", "find", "fd", "wc", "stat", "file",
  "du", "df", "tree", "which", "type", "whoami", "id", "hostname", "uname",
  "date", "env", "printenv", "uptime", "ps", "top", "sort", "uniq", "cut",
  // `awk` is intentionally ABSENT. awk has its own output-redirection (`print > "file"`), pipe-to-command (`print | "cmd"`), and system that execute arbitrary code inside the awk-program string. These are opaque to shell tokenization (correctly so — the shell sees a single-quoted literal string). Classifying awk as read-only would require a full awk-language parser; without one the classifier cannot distinguish `awk '{print $1}'` from `awk 'BEGIN{system("rm -rf /")}'`. Any awk call therefore classifies as `shell` (extra approval prompt — the safe, stated discipline of this module).
  "sed", "diff", "cmp", "basename", "dirname", "realpath", "readlink",
  "true", "false", "test", "sleep", "seq", "yes", "tr", "nl", "tac", "rev",
  // `split` is deliberately absent: with no flag at all it writes `xaa`, `xab`, … into the working directory. It was in this set, and only stayed harmless because its `null` entry in MUTATING_FLAGS escalated every call back to shell. Listing a writing verb as read-only and relying on a second table to undo it invites someone to prune the "redundant" entry.
  "column", "comm", "join", "paste", "expand", "unexpand", "fold",
]);

// Read-listed verbs still escalate on mutating flags; null means always mutating, including defensive entries for excluded write utilities. Match exact/equals long flags and mutating letters in leading short clusters; unexpanded dollar tokens on mutation-capable verbs fail closed because expansion can synthesize hidden flags.
const MUTATING_FLAGS: ReadonlyMap<string, ReadonlySet<string> | null> = new Map([
  ["sed",  new Set(["-i", "--in-place"])],
  // `awk` is NOT listed here — it is not in READ_ONLY_COMMANDS (see above), so hasMutatingFlag is never called for awk. Entry removed to avoid confusion.
  ["find", new Set(["-delete", "-exec", "-execdir", "-ok", "-okdir",
                    "-fprint", "-fprint0", "-fprintf", "-fls"])],
  ["fd",   new Set(["-x", "--exec", "-X", "--exec-batch"])],
  ["sort", new Set(["-o", "--output", "-T", "--temporary-directory"])],
  // ripgrep executes an arbitrary preprocessor per file with `--pre` (and picks which files reach it with `--pre-glob`), and runs a binary for `--hostname-bin`. Searching is read-only; handing rg a program to run is not.
  ["rg",   new Set(["--pre", "--pre-glob", "--hostname-bin"])],
  // Always-mutating (no side-effect-free bare form):
  ["tee",      null],  // always writes to every named file
  ["dd",       null],  // always reads/writes block devices or files
  ["truncate", null],  // always modifies file size
  ["split",    null],  // always writes output files (xaa… / prefix-based)
]);

// Verbs parsed by GNU getopt_long, which accepts any unambiguous abbreviation of a long option.
const GNU_ABBREVIATING_VERBS: ReadonlySet<string> = new Set(["sed", "sort"]);

// Short mutating flag letters per verb, for cluster/glued-suffix detection (mode 2 above). Keyed by the same verb names as MUTATING_FLAGS. A single-dash arg whose leading letter-cluster contains any of these letters is treated as mutating regardless of what follows (glued suffix or combined flags). Verbs without a short-letter entry are handled by exact/prefix matching alone.
const MUTATING_SHORT_LETTERS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["sed", new Set(["i"])],
  // `awk` removed — awk is not in READ_ONLY_COMMANDS, so this entry is dead. `sort -o` takes its output file as either a separate token (`-o out`) or glued to the flag (`-oout`, `-o/Users/x/.ssh/authorized_keys`). Exact-token matching only sees the first form, so the glued form wrote the file while classifying read. The cluster check covers both.
  ["sort", new Set(["o", "T"])],
]);

// git subcommands whose INSPECTION is read-only. The subcommand alone is not a proof: `git diff --output=~/.ssh/authorized_keys` writes a file the operand scan never sees, and `--ext-diff`/`--textconv` hand the content to a config-selected program. So membership here only means "this subcommand has a read-only form"; every flag it carries must still clear GIT_INSPECTION_READ_ONLY_FLAGS (allow-list, unknown flag → shell). Subcommands that are read-only only for certain flag forms (`config`, `tag`, `branch`, `remote`) are NOT listed here — GIT_READ_ONLY_FLAGS scans ALL of their post-subcommand tokens, operands included.
const READ_ONLY_GIT_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "status", "log", "diff", "show", "rev-parse",
  "describe", "blame", "shortlog", "ls-files", "ls-tree", "cat-file",
  "for-each-ref", "reflog", "whatchanged",
]);

// Unknown inspection flags escalate to shell; output, external driver, ordering and executable-selection options can write or execute and are deliberately excluded.
const GIT_INSPECTION_READ_ONLY_FLAGS: ReadonlySet<string> = new Set([
  // Output shaping
  "--oneline", "--graph", "--stat", "--numstat", "--shortstat", "--summary",
  "--name-only", "--name-status", "--raw", "--patch", "--no-patch",
  "--patch-with-stat", "--compact-summary", "--dirstat", "--pretty", "--format",
  "--abbrev", "--no-abbrev", "--abbrev-commit", "--no-abbrev-commit",
  "--date", "--color", "--no-color", "--color-words", "--word-diff",
  "--word-diff-regex", "--decorate", "--no-decorate", "--parents", "--children",
  "--full-index", "--binary", "--unified", "--inter-hunk-context",
  "--src-prefix", "--dst-prefix", "--no-prefix", "--default-prefix",
  "--relative", "--no-relative", "--find-renames", "--find-copies",
  "--find-copies-harder", "--no-renames", "--irreversible-delete",
  "--diff-filter", "--diff-algorithm", "--histogram", "--patience", "--minimal",
  "--ignore-all-space", "--ignore-space-change", "--ignore-space-at-eol",
  "--ignore-blank-lines", "--ignore-cr-at-eol", "--ignore-submodules",
  "--submodule", "--exit-code", "--quiet", "--stat-width", "--stat-name-width",
  "--numbered-lines", "--line-porcelain", "--porcelain", "--short", "--long",
  "--branch", "--show-stash", "--ahead-behind", "--no-ahead-behind",
  "--untracked-files", "--ignored", "--column", "--no-column", "--null",
  "--batch", "--batch-check", "--batch-all-objects", "--textconv-cache",
  // Selection / traversal
  "--all", "--branches", "--tags", "--remotes", "--glob", "--exclude",
  "--max-count", "--skip", "--since", "--after", "--until", "--before",
  "--author", "--committer", "--grep", "--grep-reflog", "--all-match",
  "--invert-grep", "--regexp-ignore-case", "--basic-regexp",
  "--extended-regexp", "--fixed-strings", "--perl-regexp",
  "--merges", "--no-merges", "--min-parents", "--max-parents",
  "--no-min-parents", "--no-max-parents", "--first-parent", "--follow",
  "--reverse", "--topo-order", "--date-order", "--author-date-order",
  "--ancestry-path", "--simplify-by-decoration", "--full-history",
  "--sparse", "--dense", "--cherry-pick", "--left-right", "--boundary",
  "--merge-base", "--cached", "--staged", "--merge", "--no-index",
  "--find-object", "--pickaxe-all", "--pickaxe-regex",
  "--reverse-blame", "--show-email", "--root", "--no-walk", "--do-walk",
  "--cc", "--diff-merges", "--no-diff-merges", "--remerge-diff",
  // rev-parse / ls-files / for-each-ref shapes
  "--verify", "--symbolic", "--symbolic-full-name", "--abbrev-ref",
  "--show-toplevel", "--show-cdup", "--show-prefix", "--git-dir",
  "--git-common-dir", "--absolute-git-dir", "--is-inside-work-tree",
  "--is-inside-git-dir", "--is-bare-repository", "--is-shallow-repository",
  "--show-superproject-working-tree", "--sq", "--not", "--flags", "--no-flags",
  "--revs-only", "--no-revs", "--default", "--prefix", "--end-of-options",
  "--others", "--deleted", "--modified", "--stage", "--unmerged",
  "--exclude-standard", "--directory", "--error-unmatch", "--full-name",
  "--recurse-submodules", "--count", "--sort", "--contains", "--no-contains",
  "--merged", "--no-merged", "--points-at", "--tags-only", "--refs",
  "--type", "--objects", "--object-only", "--allow-unknown-type",
  "--follow-symlinks", "--name-rev", "--always", "--dirty", "--broken",
  "--committish", "--summary-only", "--numbered", "--email", "--group",
  "--incremental", "--line-number", "--score-debug", "--show-name",
  "--show-number", "--reverse-order", "--indent-heading",
]);

// Short-flag letters that keep an inspection subcommand read-only, matched per letter so clusters (`-sn`) and glued values (`-U5`, `-M50%`) are covered. Same allow-list discipline: a letter outside this set escalates. `o` is deliberately absent — `-o` is `--output` for the diff family and `-O<orderfile>` reads a caller-named file.
const GIT_INSPECTION_READ_ONLY_SHORT_LETTERS: ReadonlySet<string> = new Set([
  // diff/log shaping: -p -u -s -U<n> -w -b -W -z -q -M -C -B -D -R -I
  "p", "u", "s", "U", "w", "b", "W", "z", "q", "M", "C", "B", "D", "R", "I",
  // log/blame selection: -n<n> -L -S -G -i -E -F -P -g -m -c -t -l -f -e -v -r -a
  "n", "L", "S", "G", "i", "E", "F", "P", "g", "m", "c", "t", "l", "f", "e",
  "v", "r", "a",
]);

// Flags that keep an otherwise-ambiguous git subcommand in read-only territory. For `config`, `tag`, `branch`, and `remote` the PRESENCE of a non-flag operand (beyond the subcommand itself) or a write-mode flag means mutation. These sets list the ONLY flags that are unambiguously read — everything else escalates. Default-strict: unknown flags → shell.
const GIT_READ_ONLY_FLAGS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  // `git config --list`, `git config --get key`, `git config --get-all key` are reads. `git config section.key value` or any write flag mutates. `-e`/`--edit` are deliberately EXCLUDED from this read set: they open the config file in $GIT_EDITOR/$EDITOR (an arbitrary process the classifier cannot see the argv of) AND leave the file writable, so an edit can install an alias or a `core.pager`/`core.editor` value that runs a command on a later git call. Both are non-read effects, so `git config -e` escalates to shell rather than passing on the subcommand+flag name alone.
  ["config", new Set(["-l", "--list", "--get", "--get-all", "--get-regexp",
                      "--get-urlmatch", "--global", "--system", "--local",
                      "--worktree", "--show-origin", "--show-scope",
                      "--type", "--bool", "--int", "--bool-or-int",
                      "--path", "--expiry-date", "--null", "-z",
                      "--name-only", "--includes", "--no-includes",
                      "--default"])],
  // `git tag` / `git tag -l` / `git tag --list` are reads. `git tag v2`, `git tag -d v1`, `git tag -a v2` etc. mutate.
  ["tag",    new Set(["-l", "--list", "--sort", "--format", "--color",
                      "--column", "--no-column", "--merged", "--no-merged",
                      "--contains", "--no-contains", "--points-at",
                      "--create-reflog"])],
  // `git branch` / `git branch -a` / `git branch -r` / `git branch --list` are reads. `git branch -D f`, `git branch -m f g`, `git branch newname` mutate.
  ["branch", new Set(["-a", "--all", "-r", "--remotes", "-l", "--list",
                      "-v", "--verbose", "-vv", "--format", "--sort",
                      "--color", "--no-color", "--column", "--no-column",
                      "--merged", "--no-merged", "--contains", "--no-contains",
                      "--points-at", "--show-current"])],
  // `git remote` / `git remote -v` / `git remote show <name>` are reads. `git remote add`, `git remote remove`, `git remote set-url` mutate.
  ["remote", new Set(["-v", "--verbose", "show", "get-url"])],
]);

// Escalate env assignments that select an interpreter, pager, editor, driver or preload; stripping them can hide the real execution. Ordinary tuning assignments remain inert, so constrain known execution-selecting names rather than all env variables.
const EXECUTION_SELECTING_ENV_NAMES: ReadonlySet<string> = new Set([
  // Pagers / preprocessors
  "LESSOPEN", "LESSCLOSE", "LESSEDIT", "LESSMETAECHO", "PAGER", "MANPAGER",
  "GIT_PAGER", "SYSTEMD_PAGER",
  // Editors (invoked as a program by many read-looking commands)
  "EDITOR", "VISUAL", "GIT_EDITOR", "GIT_SEQUENCE_EDITOR",
  // git external programs
  "GIT_EXTERNAL_DIFF", "GIT_DIFF_OPTS", "GIT_SSH", "GIT_SSH_COMMAND",
  "GIT_PROXY_COMMAND", "GIT_ASKPASS", "SSH_ASKPASS", "GIT_TEXTCONV",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_DIR", "GIT_WORK_TREE",
  "GIT_INDEX_FILE", "GIT_CONFIG", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM",
  "GIT_CONFIG_COUNT", "GIT_CONFIG_PARAMETERS", "GIT_ATTR_NOSYSTEM", "GIT_NAMESPACE",
  // Shell / interpreter selection and startup hooks
  "SHELL", "BASH_ENV", "ENV", "IFS", "PATH", "CDPATH", "SHELLOPTS",
  "BASH_FUNC_", "PS4", "PROMPT_COMMAND",
  // Dynamic-linker injection
  "LD_PRELOAD", "LD_LIBRARY_PATH", "LD_AUDIT", "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH", "DYLD_FRAMEWORK_PATH",
  // Language-runtime startup hooks
  "PERL5OPT", "PERL5LIB", "PERLIO", "PYTHONSTARTUP", "PYTHONPATH",
  "PYTHONEXECUTABLE", "NODE_OPTIONS", "NODE_PATH", "RUBYOPT", "RUBYLIB",
  // Command-option overrides that can smuggle execution or mutation flags
  "GREP_OPTIONS", "TAR_OPTIONS", "POSIXLY_CORRECT_EXEC",
]);

// True when the long option spelling abbreviates (or equals) one of the names.
export function longOptionAbbreviates(arg: string, names: readonly string[]): boolean {
  if (!arg.startsWith("--") || arg === "--") return false;
  const spelling = arg.split("=", 1)[0]!;
  return names.some((name) => name.startsWith(spelling));
}

// True when a short cluster (`-xfD`) contains one of the letters.
export function shortClusterHas(arg: string, letters: string): boolean {
  return /^-[^-]/.test(arg) && [...arg.slice(1)].some((letter) => letters.includes(letter));
}

// Options that name a program or command line for an otherwise read-only or local verb. A call carrying one runs that program, so it is never a read — on the host (this module's read-only table) or in a disposable guest (the guest allowlist reuses this check). Long options match by prefix, the way getopt_long resolves an abbreviation (`--compress-prog`); short options match anywhere in a cluster.
const PROGRAM_OPTIONS: ReadonlyMap<string, { readonly long: readonly string[]; readonly short?: string }> = new Map([
  ["sort", { long: ["--compress-program"] }],
  ["ag", { long: ["--pager"] }],
  ["rg", { long: ["--pre", "--hostname-bin"] }],
  ["fd", { long: ["--exec", "--exec-batch"], short: "xX" }],
  ["split", { long: ["--filter"] }],
  ["install", { long: ["--strip-program"] }],
]);

// True when `verb` is given an option that names a program for it to run.
export function namesProgramToRun(verb: string, args: readonly string[]): boolean {
  const options = PROGRAM_OPTIONS.get(verb);
  if (options === undefined) return false;
  return args.some((arg) => longOptionAbbreviates(arg, options.long) ||
    (options.short !== undefined && shortClusterHas(arg, options.short)));
}

// Signals the host owns about the observed call. The inspector reads ONLY these.
export interface HostRiskSignals {
  // Where the tool came from. Network MCP servers are foreign peers.
  source: ToolSource;
  // The actual, post-hook tool-call arguments.
  finalInput: Record<string, unknown>;
}

// Classify command-bearing args first: every leaf must prove read-only or the call stays shell. Then detect network endpoints; otherwise default to write. Paths never prove reads, and containment belongs to isPathAllowed.
export function inspectHostRisk(signals: HostRiskSignals): ToolCategory {
  // External MCP tools are foreign peers — the host assigns them `"network"` when adapting them (mcp-tool-adapter). Argument heuristics must never classify such a tool DOWN below network on the strength of its args, so a foreign-peer call is host-owned default-strict `"network"` regardless of what its arguments look like.
  if (signals.source === "mcp") return "network";

  // Classify every command field before network signals so URLs cannot bypass shell policy; read requires every carried command to prove read-only.
  const commands = extractShellCommands(signals.finalInput);
  if (commands.length > 0) {
    return commands.every((cmd) => isReadOnlyCommand(cmd)) ? "read" : "shell";
  }

  // (2) Network — a URL-shaped argument on a non-shell tool.
  if (hasNetworkTarget(signals.finalInput)) return "network";

  // (3) No host-owned signal proved read-only → default-strict write-equivalent. Filesystem arguments land here on purpose: contained and escaping paths are both write-equivalent, so inspecting them cannot change this answer.
  return "write";
}

// Every leaf must have a known read-only verb/form and no mutating flags; use the shared tokenizer. Parse failures, substitutions and all redirects fail closed, including input redirects whose paths argv checks cannot contain. Scan supported sed file/exec forms; exclude awk rather than pretend to parse its language.
export function isReadOnlyCommand(command: string, prepared?: PreparedShellAnalysis): boolean {
  const { leaves, parseError } = tokenizeShell(command, prepared);
  if (parseError) return false;
  if (leaves.length === 0) return false;
  return leaves.every((leaf) => isReadOnlyShellLeaf(leaf));
}

// Risk and path containment share leaf classification. Only containment may ignore redirect taint when judging verb operands separately: cat x > y reads x but writes y; whole-call risk must still reject the redirect.
export function isReadOnlyShellLeaf(
  leaf: ShellLeaf,
  options?: { readonly ignoreRedirects?: boolean },
): boolean {
  // Any hidden execution or redirect (output OR input) taints the whole command (default-strict — see the doc comment on isReadOnlyCommand). hasOutputRedirect covers both file-target redirects AND fd-dup (>&m, n>&m) so `ls 2>&1` / `ls >&2` correctly stay shell — they have an output-redirect operator even though no file target is named.
  if (leaf.hasCommandSubstitution || leaf.hasProcessSubstitution) return false;
  if (options?.ignoreRedirects !== true && (leaf.hasOutputRedirect || leaf.hasInputRedirect)) {
    return false;
  }

  // An assignment that selects the interpreter/pager/diff-driver the verb then runs is the execution, not a detail of it. The tokenizer strips assignments to expose the verb; discarding them silently is what let `LESSOPEN='|/bin/sh %s' less f` read as `less`.
  if (leaf.assignments.some(selectsExecutionTarget)) return false;

  const argv = leaf.argv;
  if (argv.length === 0) {
    // The leaf was only assignments/wrappers. A bare read-only wrapper verb (`env`, which prints the environment) is read-only; a bare incomplete wrapper (`timeout`, `nice`) is not. The first stripped wrapper is the effective verb the leaf would have run.
    const bareVerb = leaf.strippedWrappers[0];
    return bareVerb !== undefined && READ_ONLY_COMMANDS.has(bareVerb);
  }

  const verb = stripCommandPath(argv[0]!);
  // An option that hands the verb a program to run makes the leaf an execution, whatever the verb's read-only table says.
  if (namesProgramToRun(verb, argv.slice(1))) return false;
  if (verb === "git") {
    return isReadOnlyGitLeaf(argv);
  }
  if (verb === "tar") {
    return !leaf.argvHasExpandableDollar.some(Boolean) && parseTarListing(argv) !== null;
  }
  if (!READ_ONLY_COMMANDS.has(verb)) return false;
  if (verb === "uniq" && hasUniqOutput(argv.slice(1))) return false;
  // A read-only verb still MUTATES when carrying a mutating flag (`sed -i`, `find … -delete`, …). Escalate to non-read-only.
  if (hasMutatingFlag(verb, argv.slice(1), leaf.argvHasExpandableDollar.slice(1))) return false;
  return true;
}

function hasUniqOutput(args: readonly string[]): boolean {
  let optionsEnded = false;
  let positionals = 0;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (!optionsEnded && arg === "--") {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && arg.startsWith("-") && arg !== "-") {
      // Numeric option values are not input/output operands. Attached values stay in the option token; a bare value-taking flag consumes the next.
      if (/^-[^-]*[fsw]$/.test(arg)
        || ["--skip-fields", "--skip-chars", "--check-chars"].includes(arg)) index += 1;
      continue;
    }
    positionals += 1;
    if (positionals === 2) return true;
  }
  return false;
}

// True when a stripped `NAME=value` assignment picks the program a later verb will execute (see EXECUTION_SELECTING_ENV_NAMES). Two independent triggers, either one escalating: 1. The NAME is execution-selecting (exact match, or one of the `BASH_FUNC_x` style prefixed families that export shell functions into the child). 2. The VALUE is shaped like a program invocation — a leading `|` (the `LESSOPEN` pipe form) or an absolute/relative path to an interpreter. This catches an execution-selecting variable this list has not learned about yet, which is the failure mode a pure name list cannot cover.
function selectsExecutionTarget(assignment: string): boolean {
  const eq = assignment.indexOf("=");
  if (eq <= 0) return false;
  const name = assignment.slice(0, eq);
  const value = assignment.slice(eq + 1);
  if (EXECUTION_SELECTING_ENV_NAMES.has(name)) return true;
  for (const prefixed of EXECUTION_SELECTING_ENV_NAMES) {
    if (prefixed.endsWith("_") && name.startsWith(prefixed)) return true;
  }
  if (value.startsWith("|")) return true;
  return /(?:^|[\s/])(?:ba|da|z|k|tc|c)?sh\b|(?:^|[\s/])(?:python[0-9.]*|perl|ruby|node|osascript|env)\b/.test(value);
}

// True when the git leaf (full argv, `argv[0] === "git"`) is read-only. Unconditionally-read subcommands pass immediately. Ambiguous subcommands (`config`, `tag`, `branch`, `remote`) are read-only ONLY when EVERY post-subcommand token is a flag listed in GIT_READ_ONLY_FLAGS — any non-flag operand or write-mode flag escalates to shell. Default-strict: unlisted subcommands (including `commit`, `push`, `merge`, …) are shell.
function isReadOnlyGitLeaf(argv: readonly string[]): boolean {
  const sub = argv[1];
  if (typeof sub !== "string") return false;
  if (READ_ONLY_GIT_SUBCOMMANDS.has(sub)) {
    // `git reflog expire` / `git reflog delete` rewrite the reflog; only its show/list/exists forms read. Any such word escalates, wherever it sits.
    if (sub === "reflog" && argv.slice(2).some((t) => t === "expire" || t === "delete")) return false;
    // The subcommand name is not the whole answer: `git diff --output=~/.ssh/authorized_keys` writes, `git show --ext-diff` execs. Every FLAG must be in the read-only allow-list; non-flag tokens are revisions/pathspecs and are answered by path containment, not here.
    return argv.slice(2).every(isReadOnlyGitInspectionToken);
  }
  const readFlags = GIT_READ_ONLY_FLAGS.get(sub);
  if (readFlags === undefined) return false; // unlisted → shell
  // Every token after the subcommand must be in the read-only flag set.
  // A bare `git remote` (no args after sub) and `git branch` (no args) are
  // read-only listing forms — allowed when postArgs is empty.
  const postArgs = argv.slice(2);
  return postArgs.every((t) => readFlags.has(t));
}

// True when one post-subcommand token of an inspection subcommand keeps the leaf read-only. Allow-list: an unrecognised FLAG escalates. `--` ends option parsing, so everything after it is a pathspec — but the caller scans tokens independently and a bare `--` is itself inert, so it is simply accepted; a pathspec that happens to start with `-` after `--` is a false escalation (a prompt), never a false pass.
function isReadOnlyGitInspectionToken(token: string): boolean {
  if (!token.startsWith("-")) return true;   // revision / pathspec operand
  if (token === "-" || token === "--") return true;
  if (token.startsWith("--")) {
    const eq = token.indexOf("=");
    const name = eq > 0 ? token.slice(0, eq) : token;
    return GIT_INSPECTION_READ_ONLY_FLAGS.has(name);
  }
  // `git log -5` — a bare count shortcut, no letters to check.
  if (/^-[0-9]+$/.test(token)) return true;

  // A flag that takes a glued value: the letter is the flag and everything after it is its argument, so the cluster scan stops there. Only stopping at the first NON-letter is not enough. That works for `-U5` and `-M50%`, where a digit ends the run, and fails for an alphabetic value: `-Sneedle` scanned as the cluster `Sneedle`, and `d` is not an allow-listed letter, so searching a diff for a string prompted while `-S needle` — the same search, spelled with a space — did not.
  const valueTaking = /^-([A-Za-z])(.+)$/.exec(token);
  if (valueTaking && GIT_VALUE_TAKING_SHORT_FLAGS.has(valueTaking[1]!)) {
    return GIT_INSPECTION_READ_ONLY_SHORT_LETTERS.has(valueTaking[1]!);
  }

  // Short flags: every letter in the leading cluster must be allow-listed.
  const cluster = /^-([A-Za-z]+)/.exec(token);
  if (cluster === null) return false;
  for (const letter of cluster[1]!) {
    if (!GIT_INSPECTION_READ_ONLY_SHORT_LETTERS.has(letter)) return false;
  }
  return true;
}

// Git short flags whose value may be gluéd directly onto the letter, so the characters after it are an operand rather than more flags. Being in this set does NOT make a flag read-only — the letter is still checked against GIT_INSPECTION_READ_ONLY_SHORT_LETTERS. It only decides where the flag ends, which is what stops an alphabetic value from being misread as a cluster of unknown flag letters.
const GIT_VALUE_TAKING_SHORT_FLAGS: ReadonlySet<string> = new Set([
  "S", // -S<string>  pickaxe search
  "G", // -G<regex>   diff-content search
  "L", // -L<range>   line-range log / blame
  "U", // -U<n>       context lines
  "M", // -M<n>       rename detection threshold
  "C", // -C<n>       copy detection threshold
  "B", // -B<n>       break-rewrite threshold
  "I", // -I<regex>   ignore matching changes
  "n", // -n<n>       max count
]);

// Match exact long flags, equals values and mutating letters in leading short clusters/glued forms. Mutation-capable verbs also reject unexpanded dollar tokens that may become flags at runtime.
function hasMutatingFlag(
  verb: string,
  args: readonly string[],
  argsHaveExpandableDollar: readonly boolean[],
): boolean {
  if (!MUTATING_FLAGS.has(verb)) return false;
  // `.get` is always defined here because `.has` just returned true; TypeScript cannot narrow Map.get through.has so we assert non-null.
  const flagSet = MUTATING_FLAGS.get(verb)!;
  if (flagSet === null) return true; // always-mutating verb

  const shortLetters = MUTATING_SHORT_LETTERS.get(verb);

  for (const [index, arg] of args.entries()) {
    // Mode 4: dollar-expansion in any arg for this mutating-capable verb. Keyed on whether the shell will actually EXPAND that `$`, not on the character being present. A `$` inside `'...'` is literal, so it cannot split into a flag this scan never saw — which is the entire reason this mode exists. Without the distinction `rg 'foo$'` classified shell while `grep 'foo$' f` classified read, purely because rg has an entry in MUTATING_FLAGS and grep does not.
    if (arg.includes("$") && argsHaveExpandableDollar[index] === true) return true;

    // Mode 1: exact token.
    if (flagSet.has(arg)) return true;

    // Mode 2: `--flag=value` prefix for long flags, and for GNU getopt_long verbs an abbreviated spelling (`sed --in-pl`, `sort --out=f`), which the tool resolves to the full flag.
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq > 0 && flagSet.has(arg.slice(0, eq))) return true;
      if (GNU_ABBREVIATING_VERBS.has(verb) && longOptionAbbreviates(arg, [...flagSet].filter((flag) => flag.startsWith("--")))) {
        return true;
      }
      continue; // long flag — skip short-cluster check
    }

    // Mode 3: short-flag cluster/glue matching. Applies only to single-dash args and verbs with known mutating letters.
    if (arg.startsWith("-") && shortLetters !== undefined) {
      // Extract the leading letter-cluster (stops at first non-ASCII-letter).
      const cluster = /^-([A-Za-z]+)/.exec(arg);
      if (cluster !== null) {
        for (const letter of cluster[1]!) {
          if (shortLetters.has(letter)) return true;
        }
      }
    }
  }
  if (verb === "sed" && hasMutatingSedProgram(args)) return true;
  return false;
}

function hasMutatingSedProgram(args: readonly string[]): boolean {
  let expressionExpected = false;
  let implicitScriptSeen = false;

  for (const arg of args) {
    if (expressionExpected) {
      if (sedScriptHasWriteOrExec(arg)) return true;
      expressionExpected = false;
      continue;
    }

    if (arg === "-e" || arg === "--expression") {
      expressionExpected = true;
      continue;
    }
    if (arg.startsWith("--expression=")) {
      if (sedScriptHasWriteOrExec(arg.slice("--expression=".length))) return true;
      continue;
    }
    if (arg.startsWith("-e") && arg.length > 2) {
      if (sedScriptHasWriteOrExec(arg.slice(2))) return true;
      continue;
    }

    if (arg === "-f" || arg === "--file" || arg.startsWith("-f") || arg.startsWith("--file=")) {
      return true;
    }

    if (arg === "--") {
      implicitScriptSeen = false;
      continue;
    }
    if (arg.startsWith("-")) {
      continue;
    }
    if (!implicitScriptSeen) {
      implicitScriptSeen = true;
      if (sedScriptHasWriteOrExec(arg)) return true;
    }
  }

  return expressionExpected;
}

// Share sed operand spans with containment: r/R read, w/W and s///w write, e/s///e execute. Filenames begin immediately after the command letter through end-of-line, so w/tmp/x cannot be misread as a cwd-relative token.
export interface SedScriptFileAccess {
  // True when the script reads, writes or executes.
  hasWriteOrExec: boolean;
  // Files the script names, verbatim, in script order.
  fileOperands: string[];
  // Command lines the script runs with `e COMMAND`, verbatim, in script order. Like a file operand the command runs to end of line, so it is a span, not a word.
  execCommands: string[];
  // True when the script executes text that only exists at run time: `s///e` runs the pattern space AFTER substitution, and a bare `e` runs the pattern space as it stands. Neither can be read here, so a caller that needs to know what will run has to refuse rather than inspect.
  hasDynamicExec: boolean;
}

export function inspectSedScriptFileAccess(script: string): SedScriptFileAccess {
  const fileOperands: string[] = [];
  const execCommands: string[] = [];
  let hasDynamicExec = false;
  let hasWriteOrExec = false;
  let i = 0;
  while (i < script.length) {
    i = skipSedSeparators(script, i);
    if (i >= script.length) break;

    const commandStart = skipSedAddresses(script, i);
    if (commandStart < 0 || commandStart >= script.length) break;
    i = commandStart;

    if (script[i] === "!") {
      i = skipSedWhitespace(script, i + 1);
      if (i >= script.length) break;
    }

    const command = script[i];
    if (command === "#") {
      i = skipToSedLineEnd(script, i + 1);
      continue;
    }
    if (command === "{" || command === "}") {
      i += 1;
      continue;
    }
    if (command === "w" || command === "W" || command === "r" || command === "R") {
      hasWriteOrExec = true;
      i = takeSedFileOperand(script, i + 1, fileOperands);
      continue;
    }
    if (command === "e") {
      // `e COMMAND` runs that command line; a bare `e` runs the pattern space, which is only known once sed is running.
      hasWriteOrExec = true;
      const end = skipToSedLineEnd(script, i + 1);
      const executed = script.slice(i + 1, end).replace(/[\r\n]+$/, "").trim();
      if (executed.length > 0) execCommands.push(executed);
      else hasDynamicExec = true;
      i = end;
      continue;
    }
    if (command === "s") {
      const result = parseSedSubstitute(script, i);
      if (result.mutating) hasWriteOrExec = true;
      // `s///e` executes the pattern space after the substitution has been applied, so the text that runs does not exist in this script.
      if (result.mutating && !result.writesFile) hasDynamicExec = true;
      i = result.writesFile
        ? takeSedFileOperand(script, result.next, fileOperands)
        : result.next;
      continue;
    }

    i = skipToNextSedCommand(script, i + 1);
  }
  return { hasWriteOrExec, fileOperands, execCommands, hasDynamicExec };
}

// Take the filename running from `start` to the end of the line, append it to `operands`, and return the index just past that line.
function takeSedFileOperand(script: string, start: number, operands: string[]): number {
  const end = skipToSedLineEnd(script, start);
  const operand = script.slice(start, end).replace(/[\r\n]+$/, "").trim();
  if (operand.length > 0) operands.push(operand);
  return end;
}

// True when a sed script reads, writes or executes. See inspectSedScriptFileAccess.
function sedScriptHasWriteOrExec(script: string): boolean {
  return inspectSedScriptFileAccess(script).hasWriteOrExec;
}

function skipSedSeparators(script: string, i: number): number {
  while (i < script.length) {
    const ch = script[i];
    if (ch === ";" || ch === "\n" || ch === "\r" || /\s/.test(ch)) {
      i += 1;
      continue;
    }
    break;
  }
  return i;
}

function skipSedWhitespace(script: string, i: number): number {
  while (i < script.length && /\s/.test(script[i]!)) i += 1;
  return i;
}

function skipSedAddresses(script: string, start: number): number {
  let i = start;
  for (let count = 0; count < 2; count += 1) {
    i = skipSedWhitespace(script, i);
    const next = skipSedAddress(script, i);
    if (next === i) break;
    i = skipSedWhitespace(script, next);
    if (script[i] === ",") {
      i += 1;
      continue;
    }
    break;
  }
  return i;
}

function skipSedAddress(script: string, i: number): number {
  const ch = script[i];
  if (ch === undefined) return i;
  if (/[0-9]/.test(ch)) {
    i += 1;
    while (i < script.length && /[0-9~+]/.test(script[i]!)) i += 1;
    return i;
  }
  if ((ch === "+" || ch === "~") && /[0-9]/.test(script[i + 1] ?? "")) {
    i += 2;
    while (i < script.length && /[0-9]/.test(script[i]!)) i += 1;
    return i;
  }
  if (ch === "$") return i + 1;
  if (ch === "/") return skipSedDelimited(script, i + 1, "/");
  if (ch === "\\" && i + 1 < script.length) {
    return skipSedDelimited(script, i + 2, script[i + 1]!);
  }
  return i;
}

function parseSedSubstitute(
  script: string,
  start: number,
): { mutating: boolean; writesFile: boolean; next: number } {
  if (start + 1 >= script.length) return { mutating: false, writesFile: false, next: start + 1 };
  const delimiter = script[start + 1]!;
  if (/\s/.test(delimiter)) return { mutating: false, writesFile: false, next: start + 1 };
  const patternEnd = skipSedDelimited(script, start + 2, delimiter);
  if (patternEnd >= script.length) return { mutating: false, writesFile: false, next: patternEnd };
  const replacementEnd = skipSedDelimited(script, patternEnd, delimiter);
  if (replacementEnd >= script.length) return { mutating: false, writesFile: false, next: replacementEnd };

  let i = replacementEnd;
  while (i < script.length && script[i] !== ";" && script[i] !== "\n" && script[i] !== "\r") {
    const flag = script[i]!;
    // `w` names a FILE from here to end of line; `e` executes and names none.
    if (flag === "w" || flag === "e") {
      return { mutating: true, writesFile: flag === "w", next: i + 1 };
    }
    i += 1;
  }
  return { mutating: false, writesFile: false, next: i };
}

function skipSedDelimited(script: string, start: number, delimiter: string): number {
  let escaped = false;
  for (let i = start; i < script.length; i += 1) {
    const ch = script[i]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === delimiter) return i + 1;
  }
  return script.length;
}

function skipToNextSedCommand(script: string, start: number): number {
  let escaped = false;
  for (let i = start; i < script.length; i += 1) {
    const ch = script[i]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === ";" || ch === "\n" || ch === "\r") return i + 1;
  }
  return script.length;
}

function skipToSedLineEnd(script: string, start: number): number {
  for (let i = start; i < script.length; i += 1) {
    if (script[i] === "\n" || script[i] === "\r") return i + 1;
  }
  return script.length;
}

// Reduce `/usr/bin/ls` → `ls`; leave bare verbs unchanged.
