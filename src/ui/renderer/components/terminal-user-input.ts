import type { IDisposable, Terminal } from "@xterm/xterm";

/**
 * Tell the user's input from the terminal's own.
 *
 * Everything a terminal sends to its shell arrives through one data event: the keys, pastes and pointer reports the user causes, and the answers
 * the terminal itself gives a program that asked it something (where the cursor is, what it is). The two must be treated differently — an answer is
 * owed only to the program that asked, while what the user typed is theirs and must not be lost — and the data event does not say which it is.
 * The terminal's core does: it announces user input just before delivering it. `listener` runs then, immediately before the data event of every
 * piece of user input and of nothing else.
 */
export function onTerminalUserInput(term: Terminal, listener: () => void): IDisposable {
  const announce = (term as unknown as { _core?: { coreService?: { onUserInput?: (listener: () => void) => IDisposable } } })._core?.coreService?.onUserInput;
  if (typeof announce !== "function") throw new Error("the terminal's user-input announcement is not where the bundled xterm keeps it");
  return announce(listener);
}
