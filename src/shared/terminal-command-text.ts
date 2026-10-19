/**
 * What may be typed into the user's terminal as one agent command
 * (`terminal_run`).
 *
 * The text reaches an interactive shell's line editor as keystrokes, so the
 * characters themselves are instructions: a newline submits a second command
 * the approval card never showed as its own line, a tab triggers completion,
 * ESC starts an editor or terminal sequence (bracketed-paste markers among
 * them), and Ctrl-C/Ctrl-U/Ctrl-D signal the shell or rewrite the line.
 * Characters a reader cannot see — format and default-ignorable characters,
 * non-ASCII spaces, the braille blank, a combining mark stacked on ASCII, a
 * long run of whitespace that pushes the rest off the card — make the card
 * show a different command from the one the shell reads. All of these are
 * refused; there is no escape or "paste mode" that lets them through.
 *
 * The line must also be one the shell runs exactly as approved and at once,
 * and the same in every shell the terminal may run, because the permission
 * rules read it as bash:
 *  - history expansion (`!!`, `!$`, `!name`, a leading `^old^new`, the `r`
 *    and `fc` re-run commands) would run text the user never saw, so a `!` may
 *    only precede whitespace, `=`, `(` or the end of the line, where no
 *    interactive shell expands it;
 *  - a `#` comment is a comment in bash but ordinary text in an interactive
 *    zsh without `interactivecomments`, so `ls # ; rm -rf x` would run the
 *    `rm` the rules never saw; an unquoted `#` that starts a word is refused
 *    whatever the shell's options;
 *  - zsh reads constructs bash reads as plain text, found by running every
 *    accepted command of a corpus in both shells and comparing what ran with
 *    what the rules read (terminal-command-differential.test.ts): a word
 *    starting with `=` is a path lookup (`ls =rm` passes `/bin/rm`; as a
 *    redirect target it names that file), `$=x`, `$+x`, `$~x`, `$^x` and
 *    their `${…}` forms are parameter flags, `>!` is a clobbering redirect,
 *    `nocorrect`, `noglob` and `-` are precommand modifiers, `repeat N cmd` runs `cmd` (bash runs a program
 *    named `repeat`), `command NAME=v cmd` assigns and runs `cmd` (bash runs
 *    a program named `NAME=v`), and a command of redirections alone runs
 *    `$NULLCMD` or `$READNULLCMD` (`cat`, a pager) where bash runs nothing;
 *  - a construct the shell analysis does not model (`case`,
 *    `declare`/`typeset`/`local`, `let`, `((…))`, `select`, `coproc`, a glob
 *    with parentheses, which zsh reads as glob qualifiers that can run code),
 *    or a command name taken from a variable, cannot be checked for any of
 *    this, so it is refused too;
 *  - an unfinished construct (an open quote, a here-document, a trailing
 *    operator or backslash) leaves the shell waiting at a continuation prompt
 *    with the terminal half-typed, so the line must parse as one complete
 *    shell command.
 *
 * The command also must not change the shell for the user's later commands:
 * no function definitions, no assignments to the variables a shell runs or
 * resolves later commands through (prompt and hook variables, `PATH`, `IFS`,
 * `TMOUT`, …) — with `NAME=value` or through `read`, `mapfile`, `getopts` or
 * `printf -v` — no builtins that install aliases, traps, hooks, options, key
 * bindings, limits, a umask, terminal settings or scheduled commands, and no
 * reference to the shell integration's own `__ave_*` names
 * (its marker nonce among them).
 *
 * Nor may it print the shell's own state: prompt expansion (`print -P`,
 * `${…@P}`) and any reference to the prompt, hook or line-editor variables,
 * bash's `${…@A}`/`${…@K}` declarations, variable listings (`export`,
 * `readonly`, `integer` or `float` bare or with `-p`; `compgen`; `set`,
 * `typeset`, `declare` and `local` are refused already), `vared`, and
 * `print -z`/`-s`/`-S` (the line editor's buffer stack and the history;
 * `history` itself is refused as shell state).
 *
 * Pure: shared by the tool (before any approval is asked) and the PTY write
 * (which re-checks the characters it is handed).
 */
import { analyzeShell, staticShellWord, type ShellRedirect, type ShellStatement, type ShellWord } from "./shell-analysis.js";
import { analyzeShellTestExpression } from "./shell-test-expression.js";

/** Characters one command may hold — the length a block records (terminal-blocks.ts). */
export const MAX_TERMINAL_COMMAND_CHARS = 4096;
/** Longest run of whitespace a command may hold, so nothing hides past the card's edge. */
export const MAX_TERMINAL_COMMAND_WHITESPACE_RUN = 16;

export type TerminalCommandTextProblem =
  | "empty"
  | "too-long"
  | "multi-line"
  | "control-character"
  | "invisible-character"
  | "whitespace-run"
  | "history-expansion"
  | "comment"
  | "shell-divergent"
  | "shell-state"
  | "shell-integration"
  | "shell-introspection"
  | "unchecked-construct"
  | "incomplete";

/** C0 controls (tab, LF and CR included), DEL and the C1 controls. */
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/u;
const LINE_BREAK = /[\n\r\u2028\u2029]/u;
/**
 * Characters that render as nothing or as blank space a reader takes for an
 * ordinary space: format characters, default-ignorable code points (fillers,
 * variation selectors, tags), every space separator except U+0020, and the
 * braille pattern blank.
 */
const INVISIBLE_CHARACTER = /[\p{Cf}\p{Default_Ignorable_Code_Point}\p{Zs}\u2800]/u;
/** A combining mark, judged by what it attaches to ({@link hasHiddenCombiningMark}). */
const COMBINING_MARK = /\p{M}/u;
const NON_ASCII = /[^\u0000-\u007f]/u;
/** A `!` an interactive bash or zsh would expand. */

/** Command words that run differently, or re-run history, in an interactive zsh or bash. */
const DIVERGENT_COMMAND_WORDS: ReadonlySet<string> = new Set(["nocorrect", "noglob", "-", "repeat", "foreach", "r", "fc"]);
/** Builtins whose effect outlives the command: aliases, traps, hooks, options, bindings, sourced code. */
const STATE_CHANGING_COMMAND_WORDS: ReadonlySet<string> = new Set([
  "alias", "unalias", "trap", "add-zsh-hook", "autoload", "setopt", "unsetopt", "shopt", "set", "bindkey",
  "zle", "unset", "unfunction", "functions", "enable", "disable", "hash", "source", ".", "exec",
  "eval", "emulate", "zmodload", "complete", "compdef", "bind", "umask", "ulimit", "limit", "unlimit", "sched",
  "stty", "history", "compctl", "zstyle",
]);
/** Builtins that evaluate code or arithmetic strings the shell analysis does not read. */
const UNCHECKED_COMMAND_WORDS: ReadonlySet<string> = new Set(["zpty", "zregexparse", "zformat"]);
/**
 * Builtins that assign the variables named by their arguments without
 * assignment syntax: `read NAME`, `mapfile NAME`, `getopts spec NAME`,
 * `printf -v NAME`. Every argument naming a variable is judged like the left
 * side of `NAME=value`.
 */
const VARIABLE_SETTING_COMMAND_WORDS: ReadonlySet<string> = new Set(["read", "mapfile", "readarray", "getopts", "printf", "print", "zparseopts", "wait"]);
/** Builtins that list the shell's variables or completions, or edit a variable in the line editor. */
const INTROSPECTION_COMMAND_WORDS: ReadonlySet<string> = new Set(["compgen", "vared"]);
/** Declaration builtins that list every variable (and its value) when given nothing to declare, or `-p`. */
const LISTING_DECLARATION_WORDS: ReadonlySet<string> = new Set(["export", "readonly", "integer", "float"]);
/**
 * Variables that hold the prompt, its hooks or the line editor's settings.
 * Their values are the shell integration's (the prompt prints the B marker
 * of the moment); a command neither reads nor expands them.
 */
const PROMPT_VARIABLE = /^\{?#?(?:PS[0-9]|SPROMPT|PROMPT[0-9]?|RPROMPT[0-9]?|RPS[0-9]|PROMPT_COMMAND|PROMPT_EOL_MARK|prompt|rprompt|(?:precmd|preexec|chpwd|periodic|zshaddhistory|zshexit|zsh_directory_name)_functions|zle_[A-Za-z_]+|widgets)(?![A-Za-z0-9_])/u;
/** Wrappers that run their first non-option argument as a command in the shell itself. */
const COMMAND_WRAPPERS: ReadonlySet<string> = new Set(["builtin", "command", "time"]);
/** Declaration builtins whose `NAME=value` arguments assign in the shell itself. */
const DECLARATION_COMMAND_WORDS: ReadonlySet<string> = new Set(["export", "declare", "typeset", "local", "readonly", "integer", "float"]);
/**
 * Variables an interactive shell runs or resolves every later command
 * through: prompt and hook variables, the command search path, word
 * splitting, and startup files.
 */
const SHELL_STATE_VARIABLES = /^(?:PROMPT_COMMAND|PROMPT_EOL_MARK|prompt|rprompt|PS[0-9]|SPROMPT|PROMPT[0-9]?|RPROMPT[0-9]?|RPS[0-9]|(?:precmd|preexec|chpwd|periodic|zshaddhistory|zshexit|zsh_directory_name)_functions|TRAP[A-Z]+|PATH|path|IFS|CDPATH|cdpath|FPATH|fpath|BASH_ENV|ENV|ZDOTDIR|HISTFILE|HISTCONTROL|HISTIGNORE|TMOUT|MAIL|MAILCHECK|MAILPATH|mailpath|PERIOD|LD_PRELOAD|LD_LIBRARY_PATH|DYLD_[A-Z_]+|__ave_\w*)$/u;
/** Executable registries must not be changed, even by command-scoped assignments. */
const EXECUTABLE_REGISTRY_VARIABLE = /^(?:(?:dis_)?(?:functions|functions_source|aliases|galiases|saliases|builtins|commands)|widgets|BASH_ALIASES|BASH_CMDS)$/u;
const ASSIGNMENT_WORD = /^([A-Za-z_][A-Za-z0-9_]*)(?:\[[^\]]*\])?\+?=/u;

/** The first reason `command` may not be typed into a terminal, or null when it may. */
export function terminalCommandTextProblem(command: string): TerminalCommandTextProblem | null {
  if (command.trim() === "") return "empty";
  if (command.length > MAX_TERMINAL_COMMAND_CHARS) return "too-long";
  if (LINE_BREAK.test(command)) return "multi-line";
  if (CONTROL_CHARACTER.test(command)) return "control-character";
  if (hasInvisibleCharacter(command)) return "invisible-character";
  if (new RegExp(`\\s{${MAX_TERMINAL_COMMAND_WHITESPACE_RUN + 1},}`, "u").test(command)) return "whitespace-run";
  if (hasHistoryExpansion(command) || command.trimStart().startsWith("^")) return "history-expansion";
  if (command.includes("__ave_")) return "shell-integration";
  // A parameter named at run time — zsh flags such as `${(P)name}` and
  // `${(e)…}`, bash's `${!name}` — could read any variable, the shell
  // integration's among them, whatever its spelling here.
  if (/\$\{[(!]/u.test(command)) return "unchecked-construct";
  const expansion = expansionProblem(command);
  if (expansion !== null) return expansion;
  // An odd run of trailing backslashes escapes the Enter that submits the line.
  const trailingBackslashes = /\\*$/u.exec(command)?.[0].length ?? 0;
  if (trailingBackslashes % 2 === 1) return "incomplete";
  let analysis: ReturnType<typeof analyzeShell>;
  try {
    analysis = analyzeShell(command, "bash");
  } catch {
    return "incomplete";
  }
  if (!analysis.ok) return "incomplete";
  if (hasUnquotedComment(command)) return "comment";
  return statementProblem(analysis.program);
}

/** True when `command` is free of every character this module refuses (the PTY write's re-check). */
export function hasOnlyTypeableCharacters(command: string): boolean {
  return !LINE_BREAK.test(command) && !CONTROL_CHARACTER.test(command) && !hasInvisibleCharacter(command);
}

function hasInvisibleCharacter(command: string): boolean {
  for (const ch of command) {
    if (ch !== " " && INVISIBLE_CHARACTER.test(ch)) return true;
  }
  return hasHiddenCombiningMark(command);
}

/**
 * A combining mark may follow a non-ASCII letter (or another such mark), as
 * in scripts that write vowels with marks. On anything else — an ASCII
 * letter, a digit, punctuation, a space — it changes how a character looks
 * without changing what the shell reads.
 */
function hasHiddenCombiningMark(command: string): boolean {
  let base: string | null = null;
  for (const ch of command) {
    if (COMBINING_MARK.test(ch)) {
      if (base === null || !/\p{L}/u.test(base) || !NON_ASCII.test(base)) return true;
      continue;
    }
    base = ch;
  }
  return false;
}

/**
 * An unquoted `#` at the start of a word: a comment to bash, text to a zsh
 * without `interactivecomments`. Inside a `${…}` parameter expansion a `#`
 * is an operator (`${#x}`, `${x#p}`, `${x##p}`), never a comment. A line
 * whose quotes or expansions this scan cannot close is counted as holding
 * one, so an odd construct never hides a comment from it.
 */
function hasUnquotedComment(command: string): boolean {
  const chars = [...command];
  /** Open double quotes and `${` expansions, innermost last. */
  const open: Array<"double-quote" | "parameter"> = [];
  let singleQuoted = false;
  /** Inside `$'…'`, where a backslash escapes the next character, `\'` included. */
  let ansiQuoted = false;
  let escaped = false;
  let wordStart = true;
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]!;
    const inside = open.at(-1);
    if (singleQuoted) {
      if (ch === "'") singleQuoted = false;
      continue;
    }
    if (ansiQuoted) {
      if (ch === "\\") i++;
      else if (ch === "'") ansiQuoted = false;
      continue;
    }
    if (escaped) {
      escaped = false;
      wordStart = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === "$" && chars[i + 1] === "'" && inside !== "double-quote") {
      ansiQuoted = true;
      i++;
      wordStart = false;
      continue;
    }
    if (ch === "$" && chars[i + 1] === "{") {
      open.push("parameter");
      i++;
      wordStart = false;
      continue;
    }
    if (inside === "double-quote") {
      if (ch === "\"") open.pop();
      continue;
    }
    if (ch === "\"") {
      open.push("double-quote");
      wordStart = false;
      continue;
    }
    if (ch === "'") {
      singleQuoted = true;
      wordStart = false;
      continue;
    }
    if (inside === "parameter") {
      if (ch === "}") open.pop();
      continue;
    }
    if (ch === "#" && wordStart) return true;
    wordStart = /[\s;&|()<>`{}]/u.test(ch);
  }
  return open.length > 0 || singleQuoted || ansiQuoted;
}

/**
 * Each character of `command` that the shell reads outside single quotes and
 * `$'…'`, and that no backslash escapes: where `$` expands and `!` recalls
 * history, in both zsh and bash (double quotes included).
 */
function* liveCharacters(command: string): Generator<{ readonly index: number; readonly char: string }> {
  let quote: "none" | "double" | "single" | "ansi" = "none";
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote === "single") {
      if (ch === "'") quote = "none";
      continue;
    }
    if (quote === "ansi") {
      if (ch === "\\") i++;
      else if (ch === "'") quote = "none";
      continue;
    }
    if (ch === "\\") {
      i++;
      continue;
    }
    if (quote === "double") {
      if (ch === "\"") {
        quote = "none";
        continue;
      }
    } else if (ch === "'") {
      quote = "single";
      continue;
    } else if (ch === "\"") {
      quote = "double";
      continue;
    } else if (ch === "$" && command[i + 1] === "'") {
      quote = "ansi";
      i++;
      continue;
    }
    yield { index: i, char: ch };
  }
}

/**
 * A `!` the shell would read as history expansion (`!!`, `!$`, `!name`): one
 * outside single quotes, unescaped, not before whitespace, `=`, `(` or the
 * end of the line, where no interactive shell expands it.
 */
function hasHistoryExpansion(command: string): boolean {
  for (const { index, char } of liveCharacters(command)) {
    if (char === "!" && !/^(?:[\s=(]|$)/u.test(command.slice(index + 1, index + 2))) return true;
  }
  return false;
}

/**
 * The first problem with a `$` expansion the shell would perform:
 *  - zsh's parameter flags (`$=x` splits, `$+x` tests, `$~x` globs, `$^x`
 *    distributes; also in `${…}` form), which bash reads as the text `$=x`,
 *    and the rules with it;
 *  - bash's `${…@X}` transformations, which expand a prompt (`@P`) or print
 *    declarations (`@A`, `@K`);
 *  - any reference to the prompt, its hooks or the line editor's settings.
 */
function expansionProblem(command: string): TerminalCommandTextProblem | null {
  for (const { index, char } of liveCharacters(command)) {
    if (char !== "$") continue;
    const rest = command.slice(index + 1);
    if (/^\{?[=+~^]/u.test(rest)) return "shell-divergent";
    if (/^\{[^{}]*@[A-Za-z]\}/u.test(rest)) return "shell-introspection";
    if (PROMPT_VARIABLE.test(rest)) return "shell-introspection";
    const name = /^\{?#?([A-Za-z_][A-Za-z0-9_]*)/u.exec(rest)?.[1];
    if (name && EXECUTABLE_REGISTRY_VARIABLE.test(name)) return "shell-introspection";
  }
  return null;
}

/** zsh's `=cmd` path lookup: an unquoted word starting with `=` and more. */
function startsWithEquals(word: ShellWord): boolean {
  return /^=./u.test(word.source.raw);
}

/**
 * A redirect target zsh reads differently: `=cmd`, or the `!` of zsh's
 * clobbering `>!`/`>>!` (bash writes to a file named `!` and passes the
 * next word to the command).
 */
function zshRedirectTarget(redirect: ShellRedirect): boolean {
  return redirect.target !== undefined && (startsWithEquals(redirect.target) || redirect.target.source.raw.startsWith("!"));
}

function statementProblem(statement: ShellStatement): TerminalCommandTextProblem | null {
  switch (statement.kind) {
    case "command":
      return commandProblem(statement);
    case "function":
      return "shell-state";
    case "sequence":
    case "pipeline":
      for (const child of statement.statements) {
        const problem = statementProblem(child);
        if (problem !== null) return problem;
      }
      return null;
    case "and":
    case "or":
      return statementProblem(statement.left) ?? statementProblem(statement.right);
    case "subshell":
    case "background":
    case "negate":
      return statementProblem(statement.body);
    case "redirected":
      if (statement.body.kind === "command" && statement.body.words.length === 0) return "shell-divergent";
      if (statement.redirects.some(zshRedirectTarget)) return "shell-divergent";
      return statementProblem(statement.body) ?? firstWordsProblem(statement.redirects.flatMap((r) => [r.target, r.data].filter((w): w is ShellWord => w !== undefined)));
    case "for":
      if (SHELL_STATE_VARIABLES.test(statement.name) || EXECUTABLE_REGISTRY_VARIABLE.test(statement.name)) return "shell-state";
      if ((statement.values ?? []).some(startsWithEquals)) return "shell-divergent";
      return firstWordsProblem(statement.values ?? []) ?? statementProblem(statement.body);
    case "if":
      return statementProblem(statement.condition) ?? statementProblem(statement.consequent) ?? statementProblem(statement.alternate);
    case "while":
      return statementProblem(statement.condition) ?? statementProblem(statement.body);
    case "unsupported":
      // A construct the analysis does not model (case, declare/typeset/local,
      // let, ((…)), select, coproc) cannot be checked for the rules above;
      // neither can a command name taken from a variable (commandProblem).
      return "unchecked-construct";
  }
}

/**
 * Command substitutions inside words run commands too. So does a glob with
 * parentheses in zsh: `*(e:'cmd':)` and `*(+cmd)` are glob qualifiers that
 * run code for each match, where bash reads an extended glob (shell-analysis
 * leaves an ExtGlob word unanalysed).
 */
function firstWordsProblem(words: readonly ShellWord[]): TerminalCommandTextProblem | null {
  for (const word of words) {
    for (const part of word.parts) {
      if (part.kind === "substitution") {
        const problem = statementProblem(part.body);
        if (problem !== null) return problem;
      } else if (part.kind === "parameter-choice") {
        const problem = firstWordsProblem([part.operand]);
        if (problem !== null) return problem;
      } else if (part.kind === "unknown" && (/\bExtGlob$/u.test(part.reason) || part.reason === "Unsupported arithmetic effects")) {
        return "unchecked-construct";
      }
    }
  }
  return null;
}

function commandProblem(command: Extract<ShellStatement, { kind: "command" }>): TerminalCommandTextProblem | null {
  const nested = firstWordsProblem([
    ...command.words,
    ...command.assignments.map((a) => a.value),
    ...command.assignments.flatMap((a) => a.elements ?? []),
    ...command.redirects.flatMap((r) => [r.target, r.data].filter((w): w is ShellWord => w !== undefined)),
  ]);
  if (nested !== null) return nested;
  // Redirections alone: zsh runs `$NULLCMD`/`$READNULLCMD` (cat, a pager).
  if (command.words.length === 0 && command.redirects.length > 0) return "shell-divergent";
  // `[[ … ]]` takes its words as operands; everywhere else zsh looks `=word` up.
  if (command.testForm !== "double-bracket" && command.words.some(startsWithEquals)) return "shell-divergent";
  if (command.redirects.some(zshRedirectTarget)) return "shell-divergent";
  // `NAME=value` with no command assigns in the shell itself and persists.
  if (command.assignmentScope === "current" && command.assignments.some((a) => SHELL_STATE_VARIABLES.test(a.name))) {
    return "shell-state";
  }
  if (command.assignments.some((a) => EXECUTABLE_REGISTRY_VARIABLE.test(a.name))) return "shell-state";
  const staticWords = command.words.map((word) => staticShellWord(word));
  const words = command.words.map((word, i) => staticWords[i] ?? word.source.raw);
  let index = 0;
  while (index < words.length && COMMAND_WRAPPERS.has(words[index]!)) {
    index++;
    while (index < words.length && words[index]!.startsWith("-")) index++;
  }
  const head = words[index];
  if (head === undefined) return null;
  // A command name taken from a variable could be any builtin
  // (`c=alias; $c ls=rm`), so none of the checks below could hold.
  if (staticWords[index] === undefined) return "unchecked-construct";
  if (head.startsWith("=") || DIVERGENT_COMMAND_WORDS.has(head)) return "shell-divergent";
  // `command NAME=v cmd`: zsh assigns and runs cmd, bash runs a program named `NAME=v`.
  if (index > 0 && ASSIGNMENT_WORD.test(head)) return "shell-divergent";
  if (STATE_CHANGING_COMMAND_WORDS.has(head)) return "shell-state";
  if (UNCHECKED_COMMAND_WORDS.has(head)) return "unchecked-construct";
  const args = words.slice(index + 1);
  const staticArgs = staticWords.slice(index + 1);
  if (head === "test" || head === "[") {
    const form = command.testForm ?? (head === "[" ? "bracket" : "test");
    if (!analyzeShellTestExpression(form, command.words.slice(index), staticWords.slice(index), "bash").ok) return "unchecked-construct";
  }
  // The callback is evaluated as shell text, including when -C is attached
  // or clustered after -t. Option operands such as -d C are only data.
  if ((head === "mapfile" || head === "readarray") && hasUncheckedArrayReadOptions(args)) return "shell-state";
  if (INTROSPECTION_COMMAND_WORDS.has(head)) return "shell-introspection";
  // `print -P` and `echo -P` expand prompt escapes; `print -z` pushes onto
  // the line editor's buffer stack and `print -s`/`-S` onto the history.
  if ((head === "print" || head === "echo") && leadingOptions(args).some((option) => /^-[A-Za-z]*[PzsS]/u.test(option))) {
    return "shell-introspection";
  }
  // Formatted print evaluates numeric arguments as arithmetic and %n as
  // an assignment; its option clusters are not a plain data-printing form.
  if (head === "print" && leadingOptions(args).some((option) => /^-[A-Za-z]*f/u.test(option))) return "unchecked-construct";
  // `export`, `readonly`, `integer`, `float` with nothing to declare, or with
  // `-p`, list every such variable with its value.
  if (LISTING_DECLARATION_WORDS.has(head)) {
    const options = leadingOptions(args);
    // The analysis lowers `NAME=value` and `NAME` operands to assignments.
    const declares = command.assignments.length > 0 || options.length < args.length;
    if (!declares || options.some((option) => /^-[A-Za-z]*p/u.test(option))) return "shell-introspection";
  }
  if (head === "printf" || head === "print") {
    // Only the `-v` operand names a variable; an option taken from a
    // variable could be `-v` itself.
    if (staticArgs[0] === undefined && args.length > 0) return "shell-state";
    const v = args.findIndex((arg, i) => i < leadingOptions(args).length && /^-[A-Za-z]*v$/u.test(arg));
    if (v >= 0 && staticArgs[v + 1] === undefined) return "shell-state";
    if (head === "printf" && hasUncheckedPrintfFormat(staticArgs)) return "shell-state";
  } else if (VARIABLE_SETTING_COMMAND_WORDS.has(head) || DECLARATION_COMMAND_WORDS.has(head)) {
    // A variable name only known at run time could be any of them.
    if (staticArgs.some((word) => word === undefined)) return "shell-state";
  }
  if (VARIABLE_SETTING_COMMAND_WORDS.has(head)) {
    return assignedVariableNames(head, args).some((name) => {
      // Subscripts are arithmetic, even when the name was single quoted:
      // assigning values[$(cmd)] runs cmd inside the builtin itself.
      if (/[\[\]$`]/u.test(name.replace(/\[[0-9]+\]$/u, ""))) return true;
      const base = name.split("[")[0]!;
      return SHELL_STATE_VARIABLES.test(base) || EXECUTABLE_REGISTRY_VARIABLE.test(base);
    }) ? "shell-state" : null;
  }
  if (DECLARATION_COMMAND_WORDS.has(head)) {
    for (const argument of words.slice(index + 1)) {
      const name = ASSIGNMENT_WORD.exec(argument)?.[1] ?? (/^-/u.test(argument) ? undefined : argument);
      if (name !== undefined && (SHELL_STATE_VARIABLES.test(name) || EXECUTABLE_REGISTRY_VARIABLE.test(name))) return "shell-state";
      if (/^-[A-Za-z]*f/u.test(argument)) return "shell-state";
    }
  }
  return null;
}

/** Read the options before the array operand, consuming each option's own argument. */
function hasUncheckedArrayReadOptions(args: readonly string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--" || arg === "-" || !arg.startsWith("-")) break;
    for (let j = 1; j < arg.length; j++) {
      const option = arg[j]!;
      if (option === "C") return true;
      if (option === "t") continue;
      if (!"dnOsuc".includes(option)) return true;
      if (j === arg.length - 1) i++;
      break;
    }
  }
  return false;
}

/** Formats may assign with %n or evaluate numeric operands as arithmetic. */
function hasUncheckedPrintfFormat(args: readonly (string | undefined)[]): boolean {
  let index = 0;
  while (index < args.length) {
    const arg = args[index];
    if (arg === undefined) return true;
    if (arg === "--") { index++; break; }
    if (arg === "-v") { index += 2; continue; }
    if (arg.startsWith("-v")) { index++; continue; }
    break;
  }
  if (index === args.length) return false;
  const format = args[index];
  if (format === undefined) return true;
  const conversions = format.replace(/%%/gu, "");
  if (/%(?:\d+\$)?[-+ #0'.\d*$hlLjzt]*n/u.test(conversions)) return true;
  if (/%(?:\d+\$)?[-+ #0'.\d*$hlLjzt]*[diouxXeEfFgGaA]/u.test(conversions) || /%[^%]*\*/u.test(conversions)) {
    // A static numeric literal cannot name or mutate another parameter.
    return args.slice(index + 1).some((arg) => arg === undefined
      || !/^(?:['"][\s\S]*|[+-]?(?:0[xX][\da-fA-F]+|(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?))$/u.test(arg));
  }
  return false;
}

/** The leading option words of a builtin's arguments, up to `--` or the first operand. */
function leadingOptions(args: readonly string[]): string[] {
  const options: string[] = [];
  for (const arg of args) {
    if (arg === "--" || !/^-[A-Za-z]/u.test(arg)) break;
    options.push(arg);
  }
  return options;
}

/**
 * The variables a {@link VARIABLE_SETTING_COMMAND_WORDS} builtin assigns.
 * Over-inclusive on purpose: for `read`, `mapfile`, `readarray` and `vared`
 * every word is a candidate (an option's argument such as a prompt or a
 * delimiter is judged too); zsh's `read 'name?prompt'` names `name`. `printf`
 * assigns only the name after `-v` (`-v NAME` or `-vNAME`); `getopts` the
 * second and later words.
 */
function assignedVariableNames(head: string, args: readonly string[]): string[] {
  const nameOf = (word: string): string => word.replace(/^-[A-Za-z]*/u, "").split("?")[0]!;
  if (head === "printf" || head === "print") {
    const names: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const arg = args[i]!;
      if (arg === "--") break;
      if (/^-[A-Za-z]*v$/u.test(arg) && args[i + 1] !== undefined) names.push(args[i + 1]!);
      else if (/^-v./u.test(arg)) names.push(arg.slice(2));
    }
    return names.map(nameOf);
  }
  if (head === "getopts") return args.slice(1).map(nameOf);
  if (head === "wait") return args.flatMap((arg, index) => {
    const target = /^-[nf]*p(.*)$/u.exec(arg)?.[1];
    return target === undefined ? [] : [target || args[index + 1] || ""];
  });
  if (head === "zparseopts") return args.map((arg) => arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : nameOf(arg));
  return args.map(nameOf);
}
