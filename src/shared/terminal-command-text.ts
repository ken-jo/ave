/**
 * What may be typed into the user's terminal as one agent command
 * (`terminal_run`).
 *
 * The text reaches an interactive shell's line editor as keystrokes, so the
 * characters themselves are instructions: a newline submits a second command
 * the approval card never showed as its own line, a tab triggers completion,
 * ESC starts an editor or terminal sequence (bracketed-paste markers among
 * them), and Ctrl-C/Ctrl-U/Ctrl-D signal the shell or rewrite the line.
 * Invisible formatting characters (zero-width, bidirectional overrides) make
 * the card show a different command from the one the shell reads. All of
 * these are refused; there is no escape or "paste mode" that lets them
 * through.
 *
 * The line must also be one the shell runs exactly as approved and at once:
 *  - history expansion (`!!`, `!$`, `!name`, a leading `^old^new`) would run
 *    text the user never saw, so a `!` may only precede whitespace, `=`, `(`
 *    or the end of the line, where no interactive shell expands it;
 *  - an unfinished construct (an open quote, a here-document, a trailing
 *    operator or backslash) leaves the shell waiting at a continuation prompt
 *    with the terminal half-typed, so the line must parse as a complete shell
 *    command.
 *
 * Pure: shared by the tool (before any approval is asked) and the PTY write
 * (which re-checks the characters it is handed).
 */
import { analyzeShell } from "./shell-analysis.js";

/** Characters one command may hold — the length a block records (terminal-blocks.ts). */
export const MAX_TERMINAL_COMMAND_CHARS = 4096;

export type TerminalCommandTextProblem =
  | "empty"
  | "too-long"
  | "multi-line"
  | "control-character"
  | "invisible-character"
  | "history-expansion"
  | "incomplete";

/** C0 controls (tab, LF and CR included), DEL and the C1 controls. */
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/u;
const LINE_BREAK = /[\n\r\u2028\u2029]/u;
/**
 * Zero-width and joiner characters, bidirectional embeddings, overrides and
 * isolates, invisible operators and the byte-order mark.
 */
const INVISIBLE_CHARACTER = /[\u00ad\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u206f\ufeff]/u;
/** A `!` an interactive bash or zsh would expand. */
const HISTORY_EXPANSION = /!(?![\s=(]|$)/u;

/** The first reason `command` may not be typed into a terminal, or null when it may. */
export function terminalCommandTextProblem(command: string): TerminalCommandTextProblem | null {
  if (command.trim() === "") return "empty";
  if (command.length > MAX_TERMINAL_COMMAND_CHARS) return "too-long";
  if (LINE_BREAK.test(command)) return "multi-line";
  if (CONTROL_CHARACTER.test(command)) return "control-character";
  if (INVISIBLE_CHARACTER.test(command)) return "invisible-character";
  if (HISTORY_EXPANSION.test(command) || command.trimStart().startsWith("^")) return "history-expansion";
  // An odd run of trailing backslashes escapes the Enter that submits the line.
  const trailingBackslashes = /\\*$/u.exec(command)?.[0].length ?? 0;
  if (trailingBackslashes % 2 === 1) return "incomplete";
  let complete: boolean;
  try {
    complete = analyzeShell(command, "bash").ok;
  } catch {
    complete = false;
  }
  return complete ? null : "incomplete";
}

/** True when `command` is free of every character this module refuses (the PTY write's re-check). */
export function hasOnlyTypeableCharacters(command: string): boolean {
  return !LINE_BREAK.test(command) && !CONTROL_CHARACTER.test(command) && !INVISIBLE_CHARACTER.test(command);
}
