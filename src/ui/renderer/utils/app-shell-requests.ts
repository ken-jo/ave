/** Requests a view deep in the tree makes to the app shell, which owns panes and surfaces. The shell registers the one
 * handler; a request made while no shell is mounted is refused (false), never queued. */
export interface TerminalAtRequest {
  /** The folder the terminal starts in. */
  dir: string;
  /** The project the terminal belongs to. */
  projectRoot: string;
}

let terminalAtHandler: ((request: TerminalAtRequest) => void) | null = null;

/** The shell's side: handle "open a terminal in this folder". Returns the unregister. */
export function handleTerminalAtRequests(handler: (request: TerminalAtRequest) => void): () => void {
  terminalAtHandler = handler;
  return () => {
    if (terminalAtHandler === handler) terminalAtHandler = null;
  };
}

/** Ask the shell to open a terminal in `dir`. False when no shell is there to do it. */
export function requestTerminalAt(request: TerminalAtRequest): boolean {
  if (terminalAtHandler === null) return false;
  terminalAtHandler(request);
  return true;
}
