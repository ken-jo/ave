/**
 * Workspace tab ids: `<kind>:<scope>-<n>`, e.g. `terminal:3fa91c0e-2`.
 *
 * Main keys live resources by tab id across every window (the PTY map, the
 * browser-tab registry), and a window's tabs can outlive the window's launch
 * through the saved layout. So an id must be unique across windows AND across
 * launches. `scope` is minted at random once per renderer (one window, one
 * launch), and `n` counts within it. A window id would not do: Electron's
 * window ids restart with every launch, so a restored id could meet a new
 * window minting the same one.
 */
const TAB_ID_PATTERN = /^([a-z][a-z-]*):([0-9a-f]{8})-([1-9]\d*)$/;

export function parseTabId(id: string): { kind: string; scope: string; n: number } | null {
  const match = TAB_ID_PATTERN.exec(id);
  return match ? { kind: match[1]!, scope: match[2]!, n: Number(match[3]) } : null;
}

/** A terminal tab's id — what main accepts before it spawns a shell for one. */
export function isTerminalTabId(id: string): boolean {
  return parseTabId(id)?.kind === "terminal";
}
