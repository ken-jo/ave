import type { SavedSurface } from "../../../shared/main-layout.js";

/**
 * The renderer's half of saving and restoring the main window's layout
 * (`shared/main-layout.ts` is the shape and its rules).
 *
 * Restoring happens in steps that do not run in the same place. The window
 * puts back its panes and main-area surfaces itself. Each pane's side tabs go
 * to that pane's tab store when its conversation mounts, which can be later.
 * A restored terminal learns, when its view first spawns a shell, that it is
 * a NEW shell in the saved directory, and says so. This module holds what
 * those later steps take. It also collects the facts a save needs that no
 * store owns: a terminal's reported directory, and when something worth saving
 * changed.
 */

const pendingSideTabs = new Map<string, SavedSurface[]>();
const restoredTerminals = new Map<string, string | null>();
const terminalCwds = new Map<string, string>();
const changeListeners = new Set<() => void>();

/**
 * Hold the restored side tabs and terminals for the views that take them.
 * Called once per window, before the restored panes render.
 */
export function stageRestoredLayout(restored: {
  sideTabs: Readonly<Record<string, SavedSurface[]>>;
  terminals: Iterable<SavedSurface>;
}): void {
  for (const [groupId, tabs] of Object.entries(restored.sideTabs)) if (tabs.length > 0) pendingSideTabs.set(groupId, tabs);
  for (const terminal of restored.terminals) {
    restoredTerminals.set(terminal.tabId, terminal.cwd);
    if (terminal.cwd) terminalCwds.set(terminal.tabId, terminal.cwd);
  }
}

/** A pane's restored side tabs, handed over once to the store that mounts for it. */
export function takeRestoredSideTabs(groupId: string): SavedSurface[] {
  const tabs = pendingSideTabs.get(groupId) ?? [];
  pendingSideTabs.delete(groupId);
  return tabs;
}

/**
 * When `tabId` is a restored terminal, its saved directory (null: none was
 * known) — handed over once, to the view that starts its new shell.
 */
export function takeRestoredTerminal(tabId: string): { cwd: string | null } | null {
  if (!restoredTerminals.has(tabId)) return null;
  const cwd = restoredTerminals.get(tabId) ?? null;
  restoredTerminals.delete(tabId);
  return { cwd };
}

/** A terminal's shell reported its working directory. */
export function noteTerminalCwd(tabId: string, cwd: string): void {
  if (terminalCwds.get(tabId) === cwd) return;
  terminalCwds.set(tabId, cwd);
  emitMainLayoutChange();
}

export function terminalCwd(tabId: string): string | null {
  return terminalCwds.get(tabId) ?? null;
}

/** Something a saved layout records changed; the window's writer saves soon after. */
export function emitMainLayoutChange(): void {
  for (const listener of [...changeListeners]) listener();
}

export function subscribeMainLayoutChange(listener: () => void): () => void {
  changeListeners.add(listener);
  return () => {
    changeListeners.delete(listener);
  };
}

/** Test-only. */
export function resetMainLayoutRestoreForTest(): void {
  pendingSideTabs.clear();
  restoredTerminals.clear();
  terminalCwds.clear();
}
