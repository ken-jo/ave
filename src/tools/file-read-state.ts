/**
 * Per-session record of which files `read_file` showed to the model, used by
 * the file edit tools to refuse an overwrite the model has not seen.
 *
 * An edit is admitted only when the file's current bytes hash to the value
 * recorded at the last read (or at the tool's own last write). The hash is the
 * authority; the modification time is kept so a refusal can say when the file
 * changed. Records live in memory only: a restarted app or a session evicted
 * from the bounded table simply asks the model to read again, which is the
 * safe direction.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { realpath } from "node:fs/promises";

export interface FileReadRecord {
  readonly mtimeMs: number;
  readonly size: number;
  readonly sha256: string;
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

/**
 * Key for a target path. Symlinks and case-insensitive spellings resolve to
 * the same file, so a read through one spelling admits an edit through
 * another. A path that does not exist yet keys by its lexical form.
 */
export async function fileReadKey(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
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

/** Drop every record of a session that has ended. */
export function disposeSessionFileReads(sessionId: string): void {
  sessions.delete(sessionId);
}

export function sha256Hex(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * One streaming pass over a file: its SHA-256 and its logical line count,
 * counting `\n`, `\r\n` and a lone `\r` as separators the way the line-window
 * reader does.
 */
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
