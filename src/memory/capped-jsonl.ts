import { readFile, stat } from "node:fs/promises";
import { writeUtf8FileAtomic } from "../lib/atomic-file.js";
import { appendJsonlRecords } from "./session-turn-journal.js";

// Shared size cap for the memory side's append-only JSONL logs (use log, change history). One owner keeps rotation identical across them.

export interface CappedJsonlAppendResult {
  /** True when older rows were dropped to keep the file under its cap. */
  rotated: boolean;
}

/**
 * Append rows, first dropping the oldest complete rows when the file would pass `maxBytes`. Rotation keeps the newest rows that fit
 * in half the cap so it runs rarely; a torn trailing fragment is discarded with the old rows. Callers serialize appends per path.
 */
export async function appendJsonlCapped(
  path: string,
  records: readonly unknown[],
  maxBytes: number,
): Promise<CappedJsonlAppendResult> {
  if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
    throw new Error(`appendJsonlCapped: maxBytes must be a positive integer, got ${String(maxBytes)}`);
  }
  if (records.length === 0) return { rotated: false };
  const payloadBytes = Buffer.byteLength(records.map((record) => `${JSON.stringify(record)}\n`).join(""), "utf-8");
  let size = 0;
  try {
    size = (await stat(path)).size;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  let rotated = false;
  if (size > 0 && size + payloadBytes > maxBytes) {
    const raw = await readFile(path, "utf-8");
    const lines = raw.split("\n");
    // The last segment is empty after a final newline, or a torn fragment without one; drop it either way.
    lines.pop();
    const budget = Math.max(0, Math.floor(maxBytes / 2) - payloadBytes);
    const kept: string[] = [];
    let keptBytes = 0;
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index]!;
      if (line.length === 0) continue;
      const lineBytes = Buffer.byteLength(line, "utf-8") + 1;
      if (keptBytes + lineBytes > budget) break;
      kept.push(line);
      keptBytes += lineBytes;
    }
    kept.reverse();
    await writeUtf8FileAtomic(path, kept.length > 0 ? `${kept.join("\n")}\n` : "");
    rotated = true;
  }
  await appendJsonlRecords(path, records);
  return { rotated };
}
