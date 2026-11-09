import { projectRootEquals } from "./project-identity.js";
import type { SessionListRow } from "./session-lookup.js";

/** Resolve listed, same-project parents once for both pagination and rendering. */
export function sessionListParents(rows: readonly SessionListRow[]): ReadonlyMap<string, string> {
  const sessions = new Map(rows.map((row) => [row.id, row]));
  const parentOf = new Map<string, string>();
  for (const [id, session] of sessions) {
    const origin = session.family === "subagent" ? session.originSessionId : undefined;
    const parent = origin ? sessions.get(origin) : undefined;
    if (origin && parent && origin !== id && (session.projectRoot === undefined && parent.projectRoot === undefined || projectRootEquals(session.projectRoot, parent.projectRoot))) parentOf.set(id, origin);
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
  return parentOf;
}
