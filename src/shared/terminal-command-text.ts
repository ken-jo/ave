/** Terminal input is keystrokes, not a script: reject invisible editing controls, history expansion, shell-dependent syntax, and persistent shell-state changes. Tool approval and PTY write share this admission rule. */
import { analyzeShell, shellWordHasSingleField, staticShellWord, type ShellRedirect, type ShellStatement, type ShellWord } from "./shell-analysis.js";
import { analyzeShellTestExpression } from "./shell-test-expression.js";

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
/** Reject invisible formats, default-ignorables, non-ASCII separators, and braille blanks that can conceal the executed text. */
const INVISIBLE_CHARACTER = /[\p{Cf}\p{Default_Ignorable_Code_Point}\p{Zs}\u2800]/u;
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
/** Treat argument-based variable writes like assignment syntax, including read, mapfile, getopts, and printf -v. */
const VARIABLE_SETTING_COMMAND_WORDS: ReadonlySet<string> = new Set(["read", "mapfile", "readarray", "getopts", "printf", "zparseopts", "wait"]);
/** Builtins that list the shell's variables or completions, or edit a variable in the line editor. */
const INTROSPECTION_COMMAND_WORDS: ReadonlySet<string> = new Set(["compgen", "vared"]);
/** Declaration builtins that list every variable (and its value) when given nothing to declare, or `-p`. */
const LISTING_DECLARATION_WORDS: ReadonlySet<string> = new Set(["export", "readonly", "integer", "float"]);
/** Prompt, hook, and editor variables may contain integration state; commands must neither read nor expand them. */
const PROMPT_VARIABLE = /^\{?#?(?:PS[0-9]|SPROMPT|PROMPT[0-9]?|RPROMPT[0-9]?|RPS[0-9]|PROMPT_COMMAND|PROMPT_EOL_MARK|prompt|rprompt|(?:precmd|preexec|chpwd|periodic|zshaddhistory|zshexit|zsh_directory_name)_functions|zle_[A-Za-z_]+|widgets)(?![A-Za-z0-9_])/u;
const COMMAND_WRAPPERS: ReadonlySet<string> = new Set(["builtin", "command", "time"]);
const DECLARATION_COMMAND_WORDS: ReadonlySet<string> = new Set(["export", "declare", "typeset", "local", "readonly", "integer", "float"]);
/** These variables can alter later command execution, resolution, splitting, or startup. */
const SHELL_STATE_VARIABLES = /^(?:PROMPT_COMMAND|PROMPT_EOL_MARK|prompt|rprompt|PS[0-9]|SPROMPT|PROMPT[0-9]?|RPROMPT[0-9]?|RPS[0-9]|(?:precmd|preexec|chpwd|periodic|zshaddhistory|zshexit|zsh_directory_name)_functions|TRAP[A-Z]+|PATH|path|IFS|CDPATH|cdpath|FPATH|fpath|BASH_ENV|ENV|ZDOTDIR|HISTFILE|HISTCONTROL|HISTIGNORE|TMOUT|MAIL|MAILCHECK|MAILPATH|mailpath|PERIOD|LD_PRELOAD|LD_LIBRARY_PATH|DYLD_[A-Z_]+|__ave_\w*)$/u;
/** Executable registries must not be changed, even by command-scoped assignments. */
const EXECUTABLE_REGISTRY_VARIABLE = /^(?:(?:dis_)?(?:functions|functions_source|aliases|galiases|saliases|builtins|commands)|widgets|BASH_ALIASES|BASH_CMDS)$/u;
const ASSIGNMENT_WORD = /^([A-Za-z_][A-Za-z0-9_]*)(?:\[[^\]]*\])?\+?=/u;

export function terminalCommandTextProblem(command: string): TerminalCommandTextProblem | null {
  if (command.trim() === "") return "empty";
  if (command.length > MAX_TERMINAL_COMMAND_CHARS) return "too-long";
  if (LINE_BREAK.test(command)) return "multi-line";
  if (CONTROL_CHARACTER.test(command)) return "control-character";
  if (hasInvisibleCharacter(command)) return "invisible-character";
  if (new RegExp(`\\s{${MAX_TERMINAL_COMMAND_WHITESPACE_RUN + 1},}`, "u").test(command)) return "whitespace-run";
  if (hasHistoryExpansion(command) || command.trimStart().startsWith("^")) return "history-expansion";
  if (command.includes("__ave_")) return "shell-integration";
  // Runtime-indirect parameter names can reach any variable, including protected integration state.
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

export function hasOnlyTypeableCharacters(command: string): boolean {
  return !LINE_BREAK.test(command) && !CONTROL_CHARACTER.test(command) && !hasInvisibleCharacter(command);
}

function hasInvisibleCharacter(command: string): boolean {
  for (const ch of command) {
    if (ch !== " " && INVISIBLE_CHARACTER.test(ch)) return true;
  }
  return hasHiddenCombiningMark(command);
}

/** Combining marks may follow non-ASCII letters or their marks; on ASCII, digits, punctuation, or spaces they can disguise shell text. */
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

/** Word-leading unquoted # differs between interactive shells; parameter-expansion # is an operator. Unclosed syntax fails closed. */
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

/** Scan unescaped characters outside single and ANSI-C quotes; double quotes still permit parameter and history expansion. */
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

/** History expansion excludes only unescaped ! before whitespace, =, (, or end of line. */
function hasHistoryExpansion(command: string): boolean {
  for (const { index, char } of liveCharacters(command)) {
    if (char === "!" && !/^(?:[\s=(]|$)/u.test(command.slice(index + 1, index + 2))) return true;
  }
  return false;
}

/** Reject shell-specific parameter flags, prompt/declaration transformations, and references to protected prompt or editor variables. */
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

/** Path lookup and clobbering redirect syntax can resolve differently across shells. */
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
      // Unmodeled constructs and dynamic command names cannot prove the admission rules.
      return "unchecked-construct";
  }
}

/** Substitutions and parenthesized glob qualifiers can execute nested code; an unanalyzed extended glob grants no proof. */
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
  // A dynamic command name could resolve to any forbidden builtin.
  if (staticWords[index] === undefined) return "unchecked-construct";
  if (head.startsWith("=") || DIVERGENT_COMMAND_WORDS.has(head)) return "shell-divergent";
  // `command NAME=v cmd`: zsh assigns and runs cmd, bash runs a program named `NAME=v`.
  if (index > 0 && ASSIGNMENT_WORD.test(head)) return "shell-divergent";
  if (STATE_CHANGING_COMMAND_WORDS.has(head)) return "shell-state";
  if (UNCHECKED_COMMAND_WORDS.has(head)) return "unchecked-construct";
  const args = words.slice(index + 1);
  const staticArgs = staticWords.slice(index + 1);
  if (head === "print") return printOptionsProblem(staticArgs, command.words.slice(index + 1));
  if (head === "test" || head === "[") {
    const form = command.testForm ?? (head === "[" ? "bracket" : "test");
    if (!analyzeShellTestExpression(form, command.words.slice(index), staticWords.slice(index), "bash").ok) return "unchecked-construct";
  }
  // Completion callbacks evaluate shell text, including attached or clustered options; option operands remain data.
  if ((head === "mapfile" || head === "readarray") && hasUncheckedArrayReadOptions(args)) return "shell-state";
  if (INTROSPECTION_COMMAND_WORDS.has(head)) return "shell-introspection";
  // Prompt-print options expand protected state; buffer-stack and history options persist text beyond this command.
  if (head === "echo" && leadingOptions(args).some((option) => /^-[A-Za-z]*[PzsS]/u.test(option))) {
    return "shell-introspection";
  }
  // Bare declaration builtins or -p print variables and their values.
  if (LISTING_DECLARATION_WORDS.has(head)) {
    const options = leadingOptions(args);
    const declares = command.assignments.length > 0 || options.length < args.length;
    if (!declares || options.some((option) => /^-[A-Za-z]*p/u.test(option))) return "shell-introspection";
  }
  if (head === "printf") {
    // Only -v identifies printf assignment targets; a dynamic option could itself be -v.
    if (staticArgs[0] === undefined && args.length > 0) return "shell-state";
    const v = args.findIndex((arg, i) => i < leadingOptions(args).length && /^-[A-Za-z]*v$/u.test(arg));
    if (v >= 0 && staticArgs[v + 1] === undefined) return "shell-state";
    if (hasUncheckedPrintfFormat(staticArgs, command.words.slice(index + 1))) return "shell-state";
  } else if (VARIABLE_SETTING_COMMAND_WORDS.has(head) || DECLARATION_COMMAND_WORDS.has(head)) {
    // A variable name only known at run time could be any of them.
    if (staticArgs.some((word) => word === undefined)) return "shell-state";
  }
  if (VARIABLE_SETTING_COMMAND_WORDS.has(head)) {
    return assignedVariableNames(head, args).some(isUnsafeAssignedVariableName) ? "shell-state" : null;
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

function printOptionsProblem(args: readonly (string | undefined)[], words: readonly ShellWord[]): TerminalCommandTextProblem | null {
  let echoOptions = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    // The restricted mode applies to later words, not the rest of this cluster.
    if (echoOptions && (arg === undefined || !/^-[en]+$/u.test(arg))) break;
    if (arg === undefined) return "shell-state";
    if (arg === "--" || arg === "-" || !arg.startsWith("-")) break;
    for (let offset = 1; offset < arg.length; offset++) {
      const option = arg[offset]!;
      if (option === "f") return "unchecked-construct";
      if ("PzsS".includes(option)) return "shell-introspection";
      if (option === "R") { echoOptions = true; continue; }
      if ("uCvxX".includes(option)) {
        let operand: string | undefined = arg.slice(offset + 1);
        if (offset === arg.length - 1) {
          index++;
          if (index >= args.length || !shellWordHasSingleField(words[index]!)) return "shell-state";
          operand = args[index];
        }
        if (option === "v" && (operand === undefined || isUnsafeAssignedVariableName(operand))) return "shell-state";
        break;
      }
      if (!"abcDeilmnNoOpr".includes(option)) return "unchecked-construct";
    }
  }
  return null;
}

function isUnsafeAssignedVariableName(name: string): boolean {
  // Array subscripts evaluate arithmetic even in quoted variable names and may execute substitutions.
  if (/[\[\]$`]/u.test(name.replace(/\[[0-9]+\]$/u, ""))) return true;
  const base = name.split("[")[0]!;
  return SHELL_STATE_VARIABLES.test(base) || EXECUTABLE_REGISTRY_VARIABLE.test(base);
}

/** Formats may assign with %n or evaluate numeric operands as arithmetic. */
function hasUncheckedPrintfFormat(args: readonly (string | undefined)[], words: readonly ShellWord[]): boolean {
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
  const operands: Array<"field" | "number" | "text"> = [];
  for (let offset = 0; offset < format.length; offset++) {
    if (format[offset] !== "%") continue;
    if (format[offset + 1] === "%") { offset++; continue; }
    // Unknown or unfinished format directives and non-shared extensions fail closed.
    const directive = /^%[-+ #0']*(\*|[0-9]+)?(?:\.(\*|[0-9]*))?[hlL]?([diouxXeEfFgGaAbcsqn])/u.exec(format.slice(offset));
    if (directive === null || directive[3] === "n") return true;
    if (directive[1] === "*") operands.push("field");
    if (directive[2] === "*") operands.push("field");
    operands.push(/[diouxXeEfFgGaA]/u.test(directive[3]!) ? "number" : "text");
    offset += directive[0].length - 1;
  }
  if (operands.every((operand) => operand === "text")) return false;
  for (let argument = index + 1; argument < args.length; argument++) {
    // Splitting text operands may shift later data into numeric slots; surplus arguments repeat the format.
    if (!shellWordHasSingleField(words[argument]!)) return true;
    const operand = operands[(argument - index - 1) % operands.length];
    if (operand === "text") continue;
    const value = args[argument];
    if (value === undefined) return true;
    // Width and precision are arithmetic; quote-prefixed character literals apply only to conversions.
    if (operand === "field") {
      if (!/^[+-]?(?:0[xX][\da-fA-F]+|[0-9]+)$/u.test(value)) return true;
    } else if (!/^(?:['"][\s\S]*|[+-]?(?:0[xX][\da-fA-F]+|(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?))$/u.test(value)) return true;
  }
  return false;
}

function leadingOptions(args: readonly string[]): string[] {
  const options: string[] = [];
  for (const arg of args) {
    if (arg === "--" || !/^-[A-Za-z]/u.test(arg)) break;
    options.push(arg);
  }
  return options;
}

/** Over-approximate assignment targets rather than miss a write; printf uses -v targets, getopts uses its second and later words, and read-like builtins treat every word as a candidate. */
function assignedVariableNames(head: string, args: readonly string[]): string[] {
  const nameOf = (word: string): string => word.replace(/^-[A-Za-z]*/u, "").split("?")[0]!;
  if (head === "printf") {
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
