/** Tab IDs must survive restored layouts without colliding across windows or launches; use a random per-renderer scope plus a local counter, not reusable window IDs. */
const TAB_ID_PATTERN = /^([a-z][a-z-]*):([0-9a-f]{8})-([1-9]\d*)$/;

export function parseTabId(id: string): { kind: string; scope: string; n: number } | null {
  const match = TAB_ID_PATTERN.exec(id);
  return match ? { kind: match[1]!, scope: match[2]!, n: Number(match[3]) } : null;
}

export function isTerminalTabId(id: string): boolean {
  return parseTabId(id)?.kind === "terminal";
}
