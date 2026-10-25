/** Keep tab labels after view unmount so hidden-tab approvals use the visible name; other windows' tabs are absent. */
const labels = new Map<string, string>();

export function noteTerminalTabLabel(tabId: string, label: string): void {
  labels.set(tabId, label);
}

/** The tab's visible name, or undefined when this window never showed it. */
export function terminalTabLabel(tabId: string): string | undefined {
  return labels.get(tabId);
}
