// Which live loop holds a session, and which project a schedule added from that session belongs to.

/** The slice of a conversation loop these lookups read. */
export interface SessionLiveLoop {
  getSessionId(): string;
  getSessionProjectRoot(): string | null;
}

/** Where live loops are found: main and chat-group tiles, the side chat, and pane chats. */
export interface SessionLiveLoopSources<L extends SessionLiveLoop> {
  findLoopBySessionId?: (sessionId: string) => L | undefined;
  sideChatConversationLoop?: L;
  paneChatLoops?: { all(): Iterable<L> };
}

/** The live loop that holds `sessionId`, or undefined when no loop holds it right now. */
export function findSessionLiveLoop<L extends SessionLiveLoop>(
  sources: SessionLiveLoopSources<L>,
  sessionId: string,
): L | undefined {
  const tile = sources.findLoopBySessionId?.(sessionId);
  if (tile) return tile;
  if (sources.sideChatConversationLoop?.getSessionId() === sessionId) return sources.sideChatConversationLoop;
  for (const loop of sources.paneChatLoops?.all() ?? []) {
    if (loop.getSessionId() === sessionId) return loop;
  }
  return undefined;
}

export interface RoutineProjectRootDeps<L extends SessionLiveLoop> extends SessionLiveLoopSources<L> {
  resolveRootSessionId(sessionId: string): string;
  loadSessionMetadata(sessionId: string): { projectRoot?: string } | null | undefined;
  defaultProjectRoot(): string;
}

/**
 * A schedule the agent adds is listed under its conversation's project. The live loop's project wins, then the saved
 * metadata, and a conversation outside any named project belongs to the default workspace. An unknown session has no
 * project, and the caller refuses rather than guess.
 */
export function createRoutineProjectRootResolver<L extends SessionLiveLoop>(
  deps: RoutineProjectRootDeps<L>,
): (requestingSessionId: string) => string | undefined {
  return (requestingSessionId) => {
    const sessionId = deps.resolveRootSessionId(requestingSessionId);
    const liveLoop = findSessionLiveLoop(deps, sessionId);
    const metadata = deps.loadSessionMetadata(sessionId);
    if (!liveLoop && !metadata) return undefined;
    return liveLoop?.getSessionProjectRoot() ?? metadata?.projectRoot ?? deps.defaultProjectRoot();
  };
}

export interface RoutineChatDeps<L extends SessionLiveLoop> extends SessionLiveLoopSources<L> {
  resolveRootSessionId(sessionId: string): string;
  /** The main conversation store's sidecar for `sessionId`, or undefined when the main store has never saved it. */
  loadMainChatMetadata(sessionId: string): { routineId?: string } | null | undefined;
}

/**
 * The chat 대화에 연결 binds: the calling conversation's root, when it is a main chat (open in a tile, or saved by the main
 * store). A side chat, a pane chat, a schedule item's own run and an unknown session have none, and the tool refuses.
 */
export function createRoutineChatResolver<L extends SessionLiveLoop>(
  deps: RoutineChatDeps<L>,
): (requestingSessionId: string) => string | undefined {
  return (requestingSessionId) => {
    const sessionId = deps.resolveRootSessionId(requestingSessionId);
    if (deps.sideChatConversationLoop?.getSessionId() === sessionId) return undefined;
    for (const loop of deps.paneChatLoops?.all() ?? []) {
      if (loop.getSessionId() === sessionId) return undefined;
    }
    const metadata = deps.loadMainChatMetadata(sessionId);
    // A run's session is deleted with its item, so a connection to it would not outlive that item.
    if (metadata?.routineId) return undefined;
    return deps.findLoopBySessionId?.(sessionId) || metadata ? sessionId : undefined;
  };
}
