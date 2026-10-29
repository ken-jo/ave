/** Partial-ID lookup spans all persisted kinds, not recency. Main and renderer share the match rule and IPC page ceiling. */

/**
 * Largest page `ave:chat:sessions` will return. The handler clamps to this,
 * so asking for more is indistinguishable from asking for exactly this.
 */
export const SESSION_LIST_MAX_LIMIT = 100;

export type SessionKind = "main" | "routine" | "subagent";

/** The main store lists main and routine kinds only; subagent runs arrive through the work-board family. */
export type SessionListKindFilter = Exclude<SessionKind, "subagent"> | "all";

/** Key by the union so a new filter cannot be omitted from runtime validation. */
const SESSION_LIST_KIND_FILTER_TABLE: Readonly<Record<SessionListKindFilter, true>> = Object.freeze({
  "main": true,
  "routine": true,
  "all": true,
});

export function isSessionListKindFilter(value: unknown): value is SessionListKindFilter {
  return typeof value === "string" && Object.hasOwn(SESSION_LIST_KIND_FILTER_TABLE, value);
}

/** Main and routine use the main store; work-board and side-chat rows come from separate stores. */
export type SessionFamily = "main" | "routine" | "work-board" | "side-chat";

/** Key by the union so adding a family cannot leave runtime validation silently incomplete. */
const SESSION_FAMILY_TABLE: Readonly<Record<SessionFamily, true>> = Object.freeze({
  "main": true,
  "routine": true,
  "work-board": true,
  "side-chat": true,
});

export const SESSION_FAMILIES: readonly SessionFamily[] = Object.freeze(
  Object.keys(SESSION_FAMILY_TABLE) as SessionFamily[],
);

/** Narrow untrusted renderer arrays with this guard instead of casting. */
export function isSessionFamily(value: unknown): value is SessionFamily {
  return typeof value === "string" && Object.hasOwn(SESSION_FAMILY_TABLE, value);
}

/** Main stamps family once for every consumer. originSessionId is a side-chat parent, distinct from checkpoint/fork parentSessionId. */
export interface SessionListRow {
  id: string;
  modifiedAt: string;
  title: string;
  sessionKind: SessionKind;
  family: SessionFamily;
  /** Present on a work-board run row — the item it opens. */
  workBoardItemId?: number;
  /**
   * Present on a side-chat row — the conversation it belongs to, so the
   * sidebar can draw it under that conversation instead of beside it.
   */
  originSessionId?: string;
  /** Host-recorded pane identity; current host bindings determine whether it is still live. */
  paneTabId?: string;
  routineId?: string;
  routineTitle?: string;
  routineFiredAt?: string;
  projectRoot?: string;
  projectName?: string;
  /** Compact sequence number this session was forked from. Only on true forks. */
  branchedFromCompactNum?: number;
  /** ISO timestamp when this session was branched. Only on true forks. */
  branchedAt?: string;
  /** ISO time the user archived this conversation. Absent = not archived. */
  archivedAt?: string;
  /** ISO time the user marked it unread. Absent = read. */
  unreadSince?: string;
}

export interface RoutineRunRow extends SessionListRow {
  preview: string;
}

/** Request all kinds at the IPC ceiling; renderer lookup remains capped while engine lookup sees all sessions. */
export const SESSION_ID_PREFIX_LOOKUP_QUERY = Object.freeze({
  kind: "all",
  limit: SESSION_LIST_MAX_LIMIT,
} as const);

/** An empty prefix must never select an arbitrary session. */
export function findSessionByIdPrefix<T extends { id: string }>(
  sessions: readonly T[],
  prefix: string,
): T | undefined {
  const requested = prefix.trim();
  if (requested.length === 0) return undefined;
  return sessions.find((session) => session.id.startsWith(requested));
}

/** Use the same displayed prefix length that users can type into /load. */
const SESSION_ID_DISPLAY_LENGTH = 8;

export function shortSessionId(sessionId: string): string {
  return sessionId.slice(0, SESSION_ID_DISPLAY_LENGTH);
}
