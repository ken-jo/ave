import { isSavedTerminalOrPage, type MainLayoutSnapshot, type SavedMainSurface, type SavedSurface } from "../../../shared/main-layout.js";
import { projectRootEquals } from "../../../shared/project-identity.js";

/** Restore pane geometry first and let later-mounted tab stores consume saved surfaces; restored terminals start new shells
 * in saved directories. */

/** A saved main surface this window can put back. */
type RestorableSurface = SavedSurface & { projectRoot: string };

export interface RestorableLayout extends Omit<MainLayoutSnapshot, "surfaces" | "openSurfaces"> {
  surfaces: Record<string, RestorableSurface>;
  openSurfaces: RestorableSurface[];
}

/** The part of a checked layout this window can restore: main surfaces whose project is still open (compared by root
 * identity), of a kind this window shows. Each dropped surface is named with its reason (tab ids only; roots can carry the
 * user's home path). A pane whose surface is dropped shows its conversation. */
export function restorableLayout(layout: MainLayoutSnapshot, liveRoots: readonly string[]): { layout: RestorableLayout; dropped: string[] } {
  const dropped: string[] = [];
  const reasons = new Map<string, string>();
  const keep = (surface: SavedMainSurface): surface is RestorableSurface => {
    let reason: string | null = null;
    if (!liveRoots.some((root) => projectRootEquals(root, surface.projectRoot))) reason = "its project is not open";
    else if (!isSavedTerminalOrPage(surface)) reason = `this window does not show ${surface.kind} surfaces`;
    if (reason === null) return true;
    if (!reasons.has(surface.tabId)) {
      reasons.set(surface.tabId, reason);
      dropped.push(`${surface.tabId}: ${reason}`);
    }
    return false;
  };
  const surfaces: Record<string, RestorableSurface> = {};
  const openSurfaces = layout.openSurfaces.filter(keep);
  for (const [paneId, surface] of Object.entries(layout.surfaces)) if (keep(surface)) surfaces[paneId] = surface;
  return { layout: { ...layout, surfaces, openSurfaces }, dropped };
}

const pendingSideTabs = new Map<string, SavedSurface[]>();
const restoredTerminals = new Map<string, string | null>();
const terminalCwds = new Map<string, string>();
const changeListeners = new Set<() => void>();

/** Hold the restored side tabs and terminals for the views that take them. Called once per window, before the restored
 * panes render. */
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

/** When `tabId` is a restored terminal, its saved directory (null: none was known) — handed over once, to the view that
 * starts its new shell. */
export function takeRestoredTerminal(tabId: string): { cwd: string | null } | null {
  if (!restoredTerminals.has(tabId)) return null;
  const cwd = restoredTerminals.get(tabId) ?? null;
  restoredTerminals.delete(tabId);
  return { cwd };
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
