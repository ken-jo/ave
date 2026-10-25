/**
 * The visible name ("Terminal 2") of each workspace terminal tab this window
 * has shown, by tab id, so a surface that only has the tab id — the approval
 * lane's egress card while the tab is not on screen, Settings' "This tab"
 * grants — names the tab the way its strip does instead of printing the id.
 *
 * Per window: another window's tabs are not here, and the caller says so.
 * A name is kept after its view unmounts (the tab may still be running in
 * the background); the next view of the tab overwrites it.
 */
const labels = new Map<string, string>();

export function noteTerminalTabLabel(tabId: string, label: string): void {
  labels.set(tabId, label);
}

/** The tab's visible name, or undefined when this window never showed it. */
export function terminalTabLabel(tabId: string): string | undefined {
  return labels.get(tabId);
}
