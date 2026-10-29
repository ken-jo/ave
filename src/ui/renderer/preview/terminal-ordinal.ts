// Terminal labels share one window-wide sequence across main and side stores.
// Remember the tab's assignment so transfers preserve it and restored collisions
// receive a distinct number before they become visible.
const terminalOrdinals = new Map<string, number>();
let nextTerminalOrdinal = 1;

export function terminalOrdinal(tabId: string, preferred?: number): number {
  const assigned = terminalOrdinals.get(tabId);
  if (assigned !== undefined) return assigned;
  const ordinal = preferred !== undefined && preferred > 0 && ![...terminalOrdinals.values()].includes(preferred)
    ? preferred
    : nextTerminalOrdinal;
  terminalOrdinals.set(tabId, ordinal);
  nextTerminalOrdinal = Math.max(nextTerminalOrdinal, ordinal + 1);
  return ordinal;
}
