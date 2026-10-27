import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readSync, realpathSync, writeSync, type BigIntStats } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { OBSERVATION_LIMITS } from "../shared/agent-observation.js";
import { isDocumentEditJournalRecord, type DocumentEditJournalRecord } from "../shared/document-edit-journal.js";

function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function sameFile(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode
    && left.isFile() && right.isFile() && left.nlink === 1n && right.nlink === 1n;
}
function digest(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }
function clip(value: string, length: number = OBSERVATION_LIMITS.maxValueChars): string {
  const text = value.slice(0, length);
  return /[\uD800-\uDBFF]$/u.test(text) ? text.slice(0, -1) : text;
}

function openJournalFile(path: string): { descriptor: number; identity?: BigIntStats } {
  const flags = constants.O_RDWR | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
  try { return { descriptor: openSync(path, flags | constants.O_CREAT | constants.O_EXCL, 0o600) }; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const identity = lstatSync(path, { bigint: true });
  requireCondition(identity.isFile() && !identity.isSymbolicLink() && identity.nlink === 1n,
    "Invalid edit journal file.");
  return { descriptor: openSync(path, flags), identity };
}

export class WorkbookJournalCompletionError extends Error {
  constructor() {
    super("Workbook was saved, but the edit journal could not be completed.");
    this.name = "WorkbookJournalCompletionError";
  }
}

/** A configured journal is owned by the shell's isolated HOME, never by a workbook path. */
export class WorkbookEditJournal {
  private readonly descriptor: number;
  private readonly identity: BigIntStats;
  private readonly directoryIdentity: BigIntStats;
  private readonly editId = randomUUID();
  private cells = 0;
  private closed = false;
  private committed = false;

  constructor(private readonly path: string, target: string, before: Buffer) {
    const home = process.env.HOME;
    requireCondition(home && isAbsolute(home) && isAbsolute(path), "Invalid edit journal directory.");
    const directory = dirname(path);
    requireCondition(resolve(path) === path && basename(path) === "journal.jsonl"
      && directory === join(realpathSync.native(home), "document-observation"), "Invalid edit journal directory.");
    const initialDirectory = lstatSync(directory, { bigint: true });
    requireCondition(initialDirectory.isDirectory() && !initialDirectory.isSymbolicLink()
      && realpathSync.native(directory) === directory, "Invalid edit journal directory.");
    this.directoryIdentity = initialDirectory;
    const opened = openJournalFile(path);
    this.descriptor = opened.descriptor;
    try {
      this.identity = fstatSync(this.descriptor, { bigint: true });
      requireCondition(!opened.identity || sameFile(opened.identity, this.identity), "Edit journal identity changed.");
      this.assertLocation();
      const size = fstatSync(this.descriptor).size;
      requireCondition(size <= OBSERVATION_LIMITS.journalBytes, "Edit journal size limit exceeded.");
      if (size > 0) {
        const tail = Buffer.alloc(1);
        requireCondition(readSync(this.descriptor, tail, 0, 1, size - 1) === 1 && tail[0] === 10,
          "Edit journal has an incomplete record.");
      }
      this.append({ v: 1, kind: "begin", editId: this.editId, target: realpathSync.native(target), beforeHash: digest(before) });
    } catch (error) {
      closeSync(this.descriptor);
      this.closed = true;
      throw error;
    }
  }

  private assertLocation(): void {
    const directory = lstatSync(dirname(this.path), { bigint: true });
    const atPath = lstatSync(this.path, { bigint: true });
    requireCondition(!atPath.isSymbolicLink() && sameFile(this.identity, atPath)
      && sameFile(this.identity, fstatSync(this.descriptor, { bigint: true }))
      && directory.isDirectory() && !directory.isSymbolicLink()
      && directory.dev === this.directoryIdentity.dev && directory.ino === this.directoryIdentity.ino
      && realpathSync.native(dirname(this.path)) === dirname(this.path), "Edit journal identity changed.");
  }

  private append(record: DocumentEditJournalRecord): void {
    requireCondition(!this.closed && isDocumentEditJournalRecord(record), "Invalid edit journal record.");
    this.assertLocation();
    const line = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
    requireCondition(line.length <= OBSERVATION_LIMITS.journalLineBytes, "Edit journal line limit exceeded.");
    const size = fstatSync(this.descriptor).size;
    requireCondition(size + line.length <= OBSERVATION_LIMITS.journalBytes, "Edit journal size limit exceeded.");
    // Reject a short append rather than continuing inside a partial record.
    requireCondition(writeSync(this.descriptor, line) === line.length, "Incomplete edit journal write.");
  }

  cell(sheet: string, cell: string, before: string, after: string): void {
    requireCondition(!this.committed && this.cells < OBSERVATION_LIMITS.maxEditCells, "Edit journal cell limit exceeded.");
    const record: Extract<DocumentEditJournalRecord, { kind: "cell" }> = {
      v: 1, kind: "cell", editId: this.editId, sheet, cell, before: clip(before), after: clip(after),
    };
    while (Buffer.byteLength(`${JSON.stringify(record)}\n`, "utf8") > OBSERVATION_LIMITS.journalLineBytes) {
      const field = record.before.length >= record.after.length ? "before" : "after";
      requireCondition(record[field].length > 0, "Edit journal line limit exceeded.");
      record[field] = clip(record[field], Math.max(0, record[field].length - 128));
    }
    this.append(record);
    this.cells += 1;
  }

  commit(after: Buffer): void {
    requireCondition(!this.committed && this.cells > 0, "Invalid edit journal completion.");
    this.append({ v: 1, kind: "commit", editId: this.editId, afterHash: digest(after) });
    fsyncSync(this.descriptor);
    this.committed = true;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    closeSync(this.descriptor);
  }
}

export function openWorkbookEditJournal(target: string, before: Buffer): WorkbookEditJournal | null {
  const path = process.env.AVE_DOCUMENT_JOURNAL;
  return path === undefined ? null : new WorkbookEditJournal(path, target, before);
}
