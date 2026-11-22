/**
 * The window's live terminals by tab id (see `components/live-terminal.ts`). Kept apart from the xterm code so the tab
 * stores that close a terminal can release it without loading xterm.
 */
interface Disposable {
  dispose(): void;
}

const liveTerminals = new Map<string, Disposable>();

/** The tab's live terminal, created by its first view. */
export function liveTerminalFor<T extends Disposable>(tabId: string, create: () => T): T {
  const existing = liveTerminals.get(tabId);
  if (existing) return existing as T;
  const created = create();
  liveTerminals.set(tabId, created);
  return created;
}

/** A terminal tab closed: release its xterm. Called beside the `terminal.kill` that ends its shell. */
export function disposeLiveTerminal(tabId: string): void {
  focusRequests.delete(tabId);
  const terminal = liveTerminals.get(tabId);
  if (!terminal) return;
  liveTerminals.delete(tabId);
  terminal.dispose();
}

const focusRequests = new Set<string>();

/** The user opened this terminal themselves (a launcher, the new-tab menu): its view takes the keyboard once it mounts, whatever control started it. */
export function requestTerminalFocus(tabId: string): void {
  focusRequests.add(tabId);
}

/** Whether an open action asked for `tabId`'s focus; true once per request. */
export function takeTerminalFocusRequest(tabId: string): boolean {
  return focusRequests.delete(tabId);
}

/** Test-only. */
export function resetLiveTerminalsForTest(): void {
  for (const tabId of [...liveTerminals.keys()]) disposeLiveTerminal(tabId);
  focusRequests.clear();
}
