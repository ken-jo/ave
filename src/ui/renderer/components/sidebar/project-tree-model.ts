import { projectRootEquals } from "../../../../shared/project-identity.js";
import type { SessionSummary } from "../../hooks/use-sessions.js";
import type { SidebarSurface } from "../../hooks/use-sidebar-items.js";

/** How many rows a project's list shows before "이전 항목 N개 더 보기" (case 18). Surfaces count toward it like conversations. */
export const TREE_PAGE_SIZE = 20;
/** The same, inside one all-projects group, so one long group cannot push its siblings below the fold (case 05). */
export const GROUP_PAGE_SIZE = 6;

const DAY_MS = 86_400_000;

/** The time headers of a project's list, in display order. Pinned conversations come first under their own header. */
export type TreeBucket = "pinned" | "last7Days" | "last30Days" | "older";

export type TreeEntry =
  | { kind: "session"; key: string; session: SessionSummary; at: number; children?: TreeEntry[] }
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

/** By age, not by calendar: the last seven days are "지난 7일", the rest of the last thirty "지난 30일". */
export function recencyBucket(at: number, now: number): Exclude<TreeBucket, "pinned"> {
  const age = now - at;
  if (age < 7 * DAY_MS) return "last7Days";
  if (age < 30 * DAY_MS) return "last30Days";
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

/** Group only listed parents in the same project. Missing parents and invalid cycles remain reachable roots. */
export function nestSessionEntries(entries: readonly TreeEntry[]): TreeEntry[] {
  const sessions = new Map(entries.flatMap((entry) => entry.kind === "session" ? [[entry.session.id, entry] as const] : []));
  const parentOf = new Map<string, string>();
  for (const [id, entry] of sessions) {
    const origin = entry.session.family === "subagent" ? entry.session.originSessionId : undefined;
    const parent = origin ? sessions.get(origin) : undefined;
    if (origin && parent && origin !== id && (entry.session.projectRoot === undefined && parent.session.projectRoot === undefined || projectRootEquals(entry.session.projectRoot, parent.session.projectRoot))) parentOf.set(id, origin);
  }
  for (const id of parentOf.keys()) {
    const seen = new Set([id]);
    let next = parentOf.get(id);
    while (next !== undefined) {
      if (seen.has(next)) { parentOf.delete(next); break; }
      seen.add(next);
      next = parentOf.get(next);
    }
  }
  const children = new Map<string, TreeEntry[]>();
  for (const entry of entries) {
    const parent = entry.kind === "session" ? parentOf.get(entry.session.id) : undefined;
    if (parent) children.set(parent, [...(children.get(parent) ?? []), entry]);
  }
  const nest = (entry: TreeEntry): TreeEntry => entry.kind === "session"
    ? { ...entry, children: (children.get(entry.session.id) ?? []).map(nest) }
    : entry;
  return entries.filter((entry) => entry.kind !== "session" || !parentOf.has(entry.session.id)).map(nest);
}

/** A selected or running descendant must remain visible through every ancestor. */
export function sessionBranchExpanded(entry: Extract<TreeEntry, { kind: "session" }>, selectedId: string | undefined, isRunning: (id: string) => boolean, requested?: boolean): boolean {
  const containsActive = (child: TreeEntry): boolean => child.kind === "session" &&
    (child.session.id === selectedId || isRunning(child.session.id) || (child.children ?? []).some(containsActive));
  return (entry.children ?? []).some(containsActive) || (requested ?? entry.session.id === selectedId);
}
