import { appendFileSync, chmodSync, createReadStream, existsSync, mkdirSync, readFileSync, readSync } from "node:fs";
import { dirname, join } from "node:path";
import { finished } from "node:stream/promises";
import { StringDecoder } from "node:string_decoder";
import { createGunzip } from "node:zlib";
import { withFileLock } from "../lib/with-file-lock.js";
import { writeUtf8FileAtomicSync } from "../lib/atomic-file.js";

const AUDIT_SNAPSHOT_LOCK_FILE = ".audit-snapshot";
const AUDIT_SNAPSHOT_LOCK_OPTIONS = { stale: 5 * 60_000, retries: 20 };
const FD_READ_CHUNK_BYTES = 64 * 1024;

/** Serialize rotation and aggregate reads to avoid counting both raw and gzip versions, or neither. */
export function withAuditSnapshotLock<T>(
  auditDir: string,
  operation: () => Promise<T>,
): Promise<T> {
  return withFileLock(
    join(auditDir, AUDIT_SNAPSHOT_LOCK_FILE),
    operation,
    AUDIT_SNAPSHOT_LOCK_OPTIONS,
  );
}

/** Split LF lines and drop trailing CR, preserving all other bytes for exact HMAC verification. */
export function parseJsonlLines(raw: string): string[] {
  const lines: string[] = [];
  for (let line of raw.split("\n")) {
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (line.trim().length === 0) continue;
    lines.push(line);
  }
  return lines;
}

export interface JsonlRecordFileOptions<T> {
  accept: (parsed: unknown) => parsed is T;
  onMalformedLine: (line: string) => void;
  onReadFailure: (err: unknown) => void;
}

/** Lock append and rewrite across processes; atomic rewrites prevent truncated private record stores. */
export class JsonlRecordFile<T> {
  constructor(
    readonly filePath: string,
    private readonly options: JsonlRecordFileOptions<T>,
  ) {}

  loadSync(): T[] {
    if (!existsSync(this.filePath)) return [];
    let raw: string;
    try {
      raw = readFileSync(this.filePath, "utf-8");
    } catch (err) {
      this.options.onReadFailure(err);
      return [];
    }
    const records: T[] = [];
    for (const line of parseJsonlLines(raw)) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        this.options.onMalformedLine(line);
        continue;
      }
      if (this.options.accept(parsed)) records.push(parsed);
    }
    return records;
  }

  async append(record: T): Promise<void> {
    await withFileLock(this.filePath, async () => {
      mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
      appendFileSync(this.filePath, `${JSON.stringify(record)}\n`, { encoding: "utf-8", mode: 0o600 });
      try {
        // Append mode sets permissions only when creating a file.
        chmodSync(this.filePath, 0o600);
      } catch {
        // Mode repair failure must not block record writes.
      }
    });
  }

  async rewrite(records: readonly T[]): Promise<void> {
    await withFileLock(this.filePath, async () => {
      mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
      const body = records.map((record) => JSON.stringify(record)).join("\n") + (records.length > 0 ? "\n" : "");
      writeUtf8FileAtomicSync(this.filePath, body, 0o600);
    });
  }
}

/** Preserve the shared LF/CR line contract for pathname and descriptor readers. */
function createJsonlLineSplitter(maxLineBytes: number) {

  const decoder = new StringDecoder("utf-8");
  let pending = "";

  const assertLineSize = (line: string): void => {
    if (Number.isFinite(maxLineBytes) && Buffer.byteLength(line, "utf-8") > maxLineBytes) {
      throw new Error("JSONL line exceeds the maximum size");
    }
  };

  return {
    *push(chunk: Buffer): Generator<string> {
      pending += decoder.write(chunk);
      let newline = pending.indexOf("\n");
      while (newline >= 0) {
        let line = pending.slice(0, newline);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        assertLineSize(line);
        yield line;
        pending = pending.slice(newline + 1);
        newline = pending.indexOf("\n");
      }
      assertLineSize(pending);
    },
    *end(): Generator<string> {
      pending += decoder.end();
      if (pending.length > 0) {
        assertLineSize(pending);
        yield pending;
      }
    },
  };
}

/** Stream active or gzip JSONL without retaining lines; always tear down on early exit. */
export async function* iterateJsonlLines(
  filePath: string,
  maxLineBytes = Number.POSITIVE_INFINITY,
): AsyncGenerator<string> {
  const input = createReadStream(filePath);
  const gunzip = filePath.endsWith(".gz") ? createGunzip() : undefined;
  const content = gunzip ? input.pipe(gunzip) : input;
  const splitter = createJsonlLineSplitter(maxLineBytes);

  try {
    for await (const chunk of content) {
      yield* splitter.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    yield* splitter.end();
  } finally {
    content.destroy();
    if (content !== input) input.destroy();
    await Promise.all([
      finished(content, { cleanup: true }).catch(() => undefined),
      ...(content === input ? [] : [finished(input, { cleanup: true }).catch(() => undefined)]),
    ]);
  }
}

/** Read positional bytes through the caller's descriptor without closing or changing its offset, avoiding pathname replacement races. */
export async function* iterateJsonlLinesFromFd(
  fd: number,
  byteLength: number,
  maxLineBytes = Number.POSITIVE_INFINITY,
): AsyncGenerator<string> {
  const splitter = createJsonlLineSplitter(maxLineBytes);
  const chunk = Buffer.allocUnsafe(FD_READ_CHUNK_BYTES);
  let position = 0;
  while (position < byteLength) {
    const bytesRead = readSync(
      fd,
      chunk,
      0,
      Math.min(chunk.length, byteLength - position),
      position,
    );
    if (bytesRead === 0) throw new Error("JSONL descriptor ended before its expected length");
    position += bytesRead;
    yield* splitter.push(chunk.subarray(0, bytesRead));
  }
  yield* splitter.end();
}
