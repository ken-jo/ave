/**
 * Which app window a conversation's workspace tools (terminal_read, the
 * browser tools) may reach: its own window when a window hosts it, else its
 * parent's when it is a running sub-agent (walking up through nested
 * children), else none. Never a default — an unresolved session reaches
 * nothing, so a routine, a work-board run or any session no window hosts gets
 * no terminals and no browser.
 */

/** Nested sub-agent levels walked to find the conversation a child belongs to. */
const MAX_SCOPE_DEPTH = 8;

export interface SessionWindowScopeDeps {
  /** The window id hosting this interactive session, or null when none does. */
  windowIdForHostedSession: (sessionId: string) => number | null;
  /** The spawning session of a running sub-agent, or undefined for any other session. */
  liveOriginSessionId: (sessionId: string) => string | undefined;
}

/** The hosting window of `sessionId` (or of its nearest hosted ancestor), and that ancestor. */
export function resolveSessionWindow(
  sessionId: string | undefined,
  deps: SessionWindowScopeDeps,
): { windowId: number; hostSessionId: string } | null {
  const seen = new Set<string>();
  let current = sessionId;
  for (let depth = 0; current !== undefined && depth <= MAX_SCOPE_DEPTH; depth++) {
    if (seen.has(current)) return null;
    seen.add(current);
    const windowId = deps.windowIdForHostedSession(current);
    if (windowId !== null) return { windowId, hostSessionId: current };
    current = deps.liveOriginSessionId(current);
  }
  return null;
}

export function resolveSessionWindowId(
  sessionId: string | undefined,
  deps: SessionWindowScopeDeps,
): number | null {
  return resolveSessionWindow(sessionId, deps)?.windowId ?? null;
}
