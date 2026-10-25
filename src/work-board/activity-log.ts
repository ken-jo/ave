/** Route append-only activity through feature storage, never raw filesystem or fallback paths. */
import type { WorkBoardStorage } from "./storage.js";
import { parseJsonlLines } from "../audit/jsonl-reader.js";

export const ACTIVITY_FILE = "activity.jsonl";

export interface ActivityEvent {
  ts: string;
  kind:
    | "created"
    | "updated"
    | "completed"
    | "reopened"
    | "transitioned"
    | "deleted"
    | "run-planned"
    | "run-executed"
    | "run-denied"
    | "run-failed";
  itemId?: number;
  title?: string;
  from?: string;
  to?: string;
}

/** Storage has no native append; use exists plus read-modify-write for JSONL. */
export type ActivityStorage = Pick<
  WorkBoardStorage,
  "readText" | "write" | "exists"
>;

/** Omitted event timestamps use now; the storage API requires read-modify-write. */
export async function appendActivity(
  storage: ActivityStorage,
  event: Omit<ActivityEvent, "ts"> & { ts?: string },
): Promise<void> {
  const full: ActivityEvent = {
    ...event,
    ts: event.ts ?? new Date().toISOString(),
  };
  const line = JSON.stringify(full) + "\n";
  // Only confirmed storage absence starts a new log; failed reads are not first-run signals.
  const prior = (await storage.exists(ACTIVITY_FILE))
    ? await storage.readText(ACTIVITY_FILE)
    : "";
  await storage.write(ACTIVITY_FILE, prior + line);
}

/** Keep file order and skip malformed or torn lines so partial writes cannot abort reports. */
export async function readActivity(
  storage: ActivityStorage,
  sinceIso?: string,
): Promise<ActivityEvent[]> {
  if (!(await storage.exists(ACTIVITY_FILE))) return [];
  const text = await storage.readText(ACTIVITY_FILE);
  const sinceMs = sinceIso !== undefined ? Date.parse(sinceIso) : undefined;
  const events: ActivityEvent[] = [];
  for (const line of parseJsonlLines(text)) {
    let parsed: ActivityEvent;
    try {
      parsed = JSON.parse(line) as ActivityEvent;
    } catch {
      continue;
    }
    if (sinceMs !== undefined && Date.parse(parsed.ts) < sinceMs) continue;
    events.push(parsed);
  }
  return events;
}
