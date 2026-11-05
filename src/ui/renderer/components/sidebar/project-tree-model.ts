import type { SessionSummary } from "../../hooks/use-sessions.js";
import type { SidebarSurface } from "../../hooks/use-sidebar-items.js";

/** How many rows a project's list shows before "이전 항목 N개 더 보기" (case 18). Surfaces count toward it like conversations. */
export const TREE_PAGE_SIZE = 20;
/** The same, inside one all-projects group, so one long group cannot push its siblings below the fold (case 05). */
export const GROUP_PAGE_SIZE = 6;

const DAY_MS = 86_400_000;

/** The time headers of a project's list, in display order. Pinned conversations come first under their own header. */
export type TreeBucket = "pinned" | "thisWeek" | "lastWeek" | "older";

export type TreeEntry =
  | { kind: "session"; key: string; session: SessionSummary; at: number }
  | { kind: "surface"; key: string; surface: SidebarSurface; at: number };

export function sessionEntryKey(sessionId: string): string {
  return `session:${sessionId}`;
}

function surfaceEntryKey(tabId: string): string {
  return `surface:${tabId}`;
}

function sessionTime(session: SessionSummary): number {
  const at = Date.parse(session.modifiedAt);
  if (!Number.isFinite(at)) throw new Error(`session-time-invalid: ${session.id} has no readable modifiedAt`);
  return at;
}

/** By age, not by calendar: anything from the last seven days is "이번 주", the seven before that "지난주". */
export function recencyBucket(at: number, now: number): Exclude<TreeBucket, "pinned"> {
  const age = now - at;
  if (age < 7 * DAY_MS) return "thisWeek";
  if (age < 14 * DAY_MS) return "lastWeek";
  return "older";
}

/**
 * One list of a project's conversations and open surfaces, newest first (case 18). Pinned conversations lead, in their own
 * recency order. Ties keep the order they arrived in, conversations before surfaces.
 */
export function treeEntries({ sessions, surfaces, isPinned, surfaceAt }: {
  sessions: readonly SessionSummary[];
  surfaces: readonly SidebarSurface[];
  isPinned: (sessionId: string) => boolean;
  surfaceAt: (tabId: string) => number;
}): TreeEntry[] {
  const entries: TreeEntry[] = [
    ...sessions.map((session): TreeEntry => ({ kind: "session", key: sessionEntryKey(session.id), session, at: sessionTime(session) })),
    ...surfaces.map((surface): TreeEntry => ({ kind: "surface", key: surfaceEntryKey(surface.tabId), surface, at: surfaceAt(surface.tabId) })),
  ];
  const pinned = (entry: TreeEntry) => entry.kind === "session" && isPinned(entry.session.id);
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => Number(pinned(b.entry)) - Number(pinned(a.entry)) || b.entry.at - a.entry.at || a.index - b.index)
    .map(({ entry }) => entry);
}

/** The entries under each time header, in order. Entries must already be in `treeEntries` order. */
export function bucketEntries(
  entries: readonly TreeEntry[],
  now: number,
  isPinned: (sessionId: string) => boolean,
): Array<{ bucket: TreeBucket; entries: TreeEntry[] }> {
  const out: Array<{ bucket: TreeBucket; entries: TreeEntry[] }> = [];
  for (const entry of entries) {
    const bucket: TreeBucket = entry.kind === "session" && isPinned(entry.session.id) ? "pinned" : recencyBucket(entry.at, now);
    const last = out.at(-1);
    if (last?.bucket === bucket) last.entries.push(entry);
    else out.push({ bucket, entries: [entry] });
  }
  return out;
}
