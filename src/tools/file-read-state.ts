// Permit session edits only when current bytes match the last read or tool write; timestamps explain refusals, never authorize.
// Records are bounded and memory-only, so eviction or restart safely requires another read.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export interface FileReadRecord {
  readonly mtimeMs: number;
  readonly size: number;
  // Workload reads expose only a window, so the host cannot verify unchanged bytes.
  readonly sha256: string | null;
}

const MAX_TRACKED_SESSIONS = 64;
const MAX_TRACKED_PATHS_PER_SESSION = 2_000;

const sessions = new Map<string, Map<string, FileReadRecord>>();

function touchSession(sessionId: string): Map<string, FileReadRecord> {
  let records = sessions.get(sessionId);
  if (records) {
    sessions.delete(sessionId);
  } else {
    records = new Map();
  }
  sessions.set(sessionId, records);
  while (sessions.size > MAX_TRACKED_SESSIONS) {
    const oldest = sessions.keys().next().value;
    if (oldest === undefined) break;
    sessions.delete(oldest);
  }
  return records;
}

// Canonicalize aliases to one file identity; missing targets use the resolved parent.
export async function fileReadKey(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    try {
      return join(await realpath(dirname(path)), basename(path));
    } catch {
      return path;
    }
  }
}

/** Key for a path inside the disposable workload; never equal to a host key. */
export function workloadFileReadKey(guestPath: string): string {
  return `workload:${guestPath}`;
}

export function recordFileRead(sessionId: string, key: string, record: FileReadRecord): void {
  const records = touchSession(sessionId);
  records.delete(key);
  records.set(key, record);
  while (records.size > MAX_TRACKED_PATHS_PER_SESSION) {
    const oldest = records.keys().next().value;
    if (oldest === undefined) break;
    records.delete(oldest);
  }
}

export function lookupFileRead(sessionId: string, key: string): FileReadRecord | undefined {
  return sessions.get(sessionId)?.get(key);
}

export function forgetFileRead(sessionId: string, key: string): void {
  sessions.get(sessionId)?.delete(key);
}

export function disposeSessionFileReads(sessionId: string): void {
  sessions.delete(sessionId);
}

export function sha256Hex(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// Count CR, LF, and CRLF consistently with the line-window reader while hashing in one pass.
export async function hashAndCountLines(path: string): Promise<{ sha256: string; lineCount: number; size: number }> {
  const hash = createHash("sha256");
  let separators = 0;
  let size = 0;
  let previous = -1;
  for await (const chunk of createReadStream(path)) {
    const bytes = chunk as Buffer;
    hash.update(bytes);
    size += bytes.length;
    if (bytes.length === 0) continue;
    for (let at = bytes.indexOf(0x0d); at !== -1; at = bytes.indexOf(0x0d, at + 1)) {
      separators += 1;
    }
    for (let at = bytes.indexOf(0x0a); at !== -1; at = bytes.indexOf(0x0a, at + 1)) {
      // The LF of a CRLF pair was already counted with its CR.
      const before = at > 0 ? bytes[at - 1] : previous;
      if (before !== 0x0d) separators += 1;
    }
    previous = bytes[bytes.length - 1]!;
  }
  const endsWithSeparator = previous === 0x0a || previous === 0x0d;
  const lineCount = size === 0 ? 0 : separators + (endsWithSeparator ? 0 : 1);
  return { sha256: hash.digest("hex"), lineCount, size };
}
