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
  const terminal = liveTerminals.get(tabId);
  if (!terminal) return;
  liveTerminals.delete(tabId);
  terminal.dispose();
}

/** Test-only. */
export function resetLiveTerminalsForTest(): void {
  for (const tabId of [...liveTerminals.keys()]) disposeLiveTerminal(tabId);
}
