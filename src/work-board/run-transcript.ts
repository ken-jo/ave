/** Append each run to its own JSONL path and preserve older runs indexed by board history; storage uses read-modify-write. */
import type { WorkBoardStorage } from "./storage.js";
import type { RunTranscriptEvent } from "../shared/work-board-types.js";
import { parseJsonlLines } from "../audit/jsonl-reader.js";

export type { RunTranscriptEvent };

export type TranscriptStorage = Pick<WorkBoardStorage, "readText" | "write" | "exists" | "mkdir">;

export function runTranscriptPath(itemId: number, runId: string): string {
  return `sessions/${itemId}/${runId}.jsonl`;
}

/** The caller must serialize and await appends for each run; storage adds no separate lock. */
export interface RunTranscriptWriter {
  append(event: Omit<RunTranscriptEvent, "ts"> & { ts?: string }): Promise<void>;
}

export function createRunTranscript(
  storage: TranscriptStorage,
  itemId: number,
  runId: string,
  now: () => number = Date.now,
): RunTranscriptWriter {
  const path = runTranscriptPath(itemId, runId);
  return {
    async append(event) {
      const full: RunTranscriptEvent = { ...event, ts: event.ts ?? new Date(now()).toISOString() };
      const line = JSON.stringify(full) + "\n";
      const prior = (await storage.exists(path)) ? await storage.readText(path) : "";
      await storage.write(path, prior + line);
    },
  };
}

/** Read oldest first; missing files are empty and torn lines do not abort replay. */
export async function readRunTranscript(
  storage: TranscriptStorage,
  itemId: number,
  runId: string,
): Promise<RunTranscriptEvent[]> {
  // Validate run ids before interpolating paths so every caller preserves namespace containment.
  if (!/^[A-Za-z0-9_-]+$/.test(runId)) return [];
  const path = runTranscriptPath(itemId, runId);
  if (!(await storage.exists(path))) return [];
  const text = await storage.readText(path);
  const events: RunTranscriptEvent[] = [];
  for (const line of parseJsonlLines(text)) {
    try {
      events.push(JSON.parse(line) as RunTranscriptEvent);
    } catch {
      // Skip a torn final line.
    }
  }
  return events;
}
