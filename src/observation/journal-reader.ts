import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync, type BigIntStats } from "node:fs";
import { join, resolve } from "node:path";
import { TextDecoder } from "node:util";
import { OBSERVATION_LIMITS } from "../shared/agent-observation.js";
import { isDocumentEditJournalRecord, type DocumentEditJournalRecord } from "../shared/document-edit-journal.js";

const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

/** Reads only one registered action directory, never a path supplied by a record. */
export class DocumentJournalReader {
  private readonly home: string;
  private readonly directory: string;
  private readonly path: string;
  private readonly homeIdentity: BigIntStats;
  private readonly directoryIdentity: BigIntStats;
  private fileIdentity?: BigIntStats;
  private offset = 0;
  private highestObservedSize = 0n;
  private remainder = Buffer.alloc(0);
  private disposed = false;

  constructor(actionDirectory: string, private readonly onRecord: (record: DocumentEditJournalRecord) => void) {
    this.home = resolve(actionDirectory);
    this.directory = join(this.home, "document-observation");
    this.path = join(this.directory, "journal.jsonl");
    this.homeIdentity = lstatSync(this.home, { bigint: true });
    this.directoryIdentity = lstatSync(this.directory, { bigint: true });
    this.assertDirectory();
  }

  poll(): boolean {
    if (this.disposed) return false;
    this.assertDirectory();
    let atPath: BigIntStats;
    try { atPath = lstatSync(this.path, { bigint: true }); }
    catch (error) { if (missing(error) && !this.fileIdentity) return false; throw new Error("Document journal disappeared."); }
    if (!atPath.isFile() || atPath.isSymbolicLink() || atPath.nlink !== 1n
      || atPath.size > BigInt(OBSERVATION_LIMITS.journalBytes) || atPath.size < this.highestObservedSize
      || atPath.size < BigInt(this.offset)
      || (this.fileIdentity && !sameIdentity(atPath, this.fileIdentity))) {
      throw new Error("Invalid document journal identity or size.");
    }
    this.highestObservedSize = atPath.size;
    const descriptor = openSync(this.path, constants.O_RDONLY
      | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK));
    try {
      const opened = fstatSync(descriptor, { bigint: true });
      if (!sameIdentity(atPath, opened) || !opened.isFile() || opened.nlink !== 1n) throw new Error("Document journal changed while opening.");
      if (opened.size < this.highestObservedSize) throw new Error("Document journal truncated while opening.");
      this.highestObservedSize = opened.size;
      this.fileIdentity ??= opened;
      const available = Math.min(Number(opened.size) - this.offset, OBSERVATION_LIMITS.journalReadBytes);
      if (available < 0 || opened.size > BigInt(OBSERVATION_LIMITS.journalBytes)) throw new Error("Invalid document journal size.");
      if (available === 0) return false;
      const bytes = Buffer.allocUnsafe(available);
      const received = readSync(descriptor, bytes, 0, bytes.length, this.offset);
      if (received !== available) throw new Error("Document journal truncated while reading.");
      this.offset += received;
      this.assertDirectory();
      const afterPath = lstatSync(this.path, { bigint: true });
      const afterFile = fstatSync(descriptor, { bigint: true });
      if (!sameIdentity(afterPath, opened) || afterPath.isSymbolicLink() || afterPath.nlink !== 1n
        || afterPath.size < this.highestObservedSize || afterFile.size < afterPath.size
        || afterPath.size < BigInt(this.offset) || afterFile.size < BigInt(this.offset)
        || afterPath.size > BigInt(OBSERVATION_LIMITS.journalBytes)
        || afterFile.size > BigInt(OBSERVATION_LIMITS.journalBytes)) throw new Error("Document journal changed while reading.");
      this.highestObservedSize = afterFile.size;
      const combined = Buffer.concat([this.remainder, bytes]);
      let start = 0;
      for (let end = combined.indexOf(10); end !== -1; end = combined.indexOf(10, start)) {
        const line = combined.subarray(start, end);
        if (line.length === 0 || line.length > OBSERVATION_LIMITS.journalLineBytes) throw new Error("Invalid document journal line.");
        let record: unknown;
        try { record = JSON.parse(utf8Decoder.decode(line)); }
        catch { throw new Error("Invalid document journal record."); }
        if (!isDocumentEditJournalRecord(record)) throw new Error("Invalid document journal record.");
        this.onRecord(record);
        start = end + 1;
      }
      this.remainder = Buffer.from(combined.subarray(start));
      if (this.remainder.length > OBSERVATION_LIMITS.journalLineBytes) throw new Error("Document journal line limit exceeded.");
      return this.offset < Number(afterPath.size);
    } finally {
      closeSync(descriptor);
    }
  }

  /** Bounded synchronous drain runs before the shell removes its private HOME. */
  drain(): void {
    for (let poll = 0; poll <= Math.ceil(OBSERVATION_LIMITS.journalBytes / OBSERVATION_LIMITS.journalReadBytes); poll += 1) {
      if (!this.poll()) return;
    }
    throw new Error("Document journal read limit exceeded.");
  }

  dispose(): void { this.disposed = true; this.remainder = Buffer.alloc(0); }

  private assertDirectory(): void {
    const home = lstatSync(this.home, { bigint: true });
    const directory = lstatSync(this.directory, { bigint: true });
    if (!home.isDirectory() || home.isSymbolicLink() || !sameIdentity(home, this.homeIdentity)
      || !directory.isDirectory() || directory.isSymbolicLink() || !sameIdentity(directory, this.directoryIdentity)
      || realpathSync.native(this.home) !== this.home || realpathSync.native(this.directory) !== this.directory) {
      throw new Error("Invalid document journal action directory.");
    }
  }
}
