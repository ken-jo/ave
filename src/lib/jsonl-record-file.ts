import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { withFileLock } from "./with-file-lock.js";
import { writeUtf8FileAtomicSync } from "./atomic-file.js";

/** Split LF lines and drop trailing CR, preserving all other bytes. */
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
    return this.parse(raw);
  }

  /** The accepted records of `raw`, text a caller already read (and, for a trusted store, verified). */
  parse(raw: string): T[] {
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
