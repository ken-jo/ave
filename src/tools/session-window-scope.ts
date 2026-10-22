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

/**
 * Walks a session up through its live sub-agent origins, nearest first,
 * starting with the session itself. Stops at a cycle or past
 * {@link MAX_SCOPE_DEPTH}; `complete` says whether the walk reached a session
 * with no live origin.
 */
function walkLiveOrigins(
  sessionId: string,
  liveOriginSessionId: SessionWindowScopeDeps["liveOriginSessionId"],
): { chain: string[]; complete: boolean } {
  const chain: string[] = [];
  let current: string | undefined = sessionId;
  for (let depth = 0; current !== undefined && depth <= MAX_SCOPE_DEPTH; depth++) {
    if (chain.includes(current)) return { chain, complete: false };
    chain.push(current);
    current = liveOriginSessionId(current);
  }
  return { chain, complete: current === undefined };
}

/**
 * The root conversation of `sessionId`: the session itself when it is not a
 * running sub-agent, else the conversation its sub-agent chain was spawned
 * from. A cycle or an over-deep chain is a broken registry and throws.
 */
export function resolveRootSessionId(
  sessionId: string,
  liveOriginSessionId: SessionWindowScopeDeps["liveOriginSessionId"],
): string {
  const { chain, complete } = walkLiveOrigins(sessionId, liveOriginSessionId);
  if (!complete) throw new Error(`Sub-agent origin chain for ${sessionId} is cyclic or deeper than ${MAX_SCOPE_DEPTH}`);
  return chain[chain.length - 1]!;
}

/** The hosting window of `sessionId` (or of its nearest hosted ancestor), and that ancestor. */
export function resolveSessionWindow(
  sessionId: string | undefined,
  deps: SessionWindowScopeDeps,
): { windowId: number; hostSessionId: string } | null {
  if (sessionId === undefined) return null;
  for (const candidate of walkLiveOrigins(sessionId, deps.liveOriginSessionId).chain) {
    const windowId = deps.windowIdForHostedSession(candidate);
    if (windowId !== null) return { windowId, hostSessionId: candidate };
  }
  return null;
}

export function resolveSessionWindowId(
  sessionId: string | undefined,
  deps: SessionWindowScopeDeps,
): number | null {
  return resolveSessionWindow(sessionId, deps)?.windowId ?? null;
}
