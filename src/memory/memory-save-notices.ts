// Every memory save, from any path, reaches the user as one live notice that can undo it. Undo stays simple: undoing a
// create deletes it, undoing an update puts the earlier bytes back, undoing a delete restores it, and each acts only while
// the memory still holds what that change wrote.
import { randomUUID } from "node:crypto";
import { createLogger } from "../lib/logger.js";
import type { MemoryManager, MemorySaveResult, NoteEntry } from "./memory-manager.js";
import type {
  MemorySaveNoticeResult,
  MemorySaveResultEvent,
  MemorySaveSkipReason,
  MemoryUndoResult,
} from "../shared/memory-save-result.js";

export type { MemorySaveSkipReason } from "../shared/memory-save-result.js";

const log = createLogger("memory-save-notices");

/** Undo records live only in this process and are lost on restart. */
const MAX_MEMORY_UNDO_RECORDS = 50;

export interface MemoryNoticeTarget {
  sessionId: string;
  anchorMessageId?: string;
}

// `memoryId` names the memory a record belongs to. A file name is reused by the next create of the same title, so only the
// id tells an earlier memory's records from a new one's.
type UndoRecord =
  | { kind: "created"; memoryId: string; filename: string; title: string; fileDigest: string }
  | { kind: "updated"; memoryId: string; filename: string; title: string; fileDigest: string; priorContent: string }
  | { kind: "deleted"; memoryId: string; filename: string; title: string; priorContent: string };

type UndoStore = Pick<MemoryManager, "deleteMemoryIfUnchanged" | "restoreMemoryIfUnchanged" | "restoreDeletedMemory">;

export class MemorySaveNotices {
  private readonly records = new Map<string, UndoRecord>();
  private sink: ((event: MemorySaveResultEvent) => void) | undefined;

  constructor(private readonly memoryManager: UndoStore, private readonly maxRecords = MAX_MEMORY_UNDO_RECORDS) {}

  /** Boot points this at the main window once it exists; events before then are dropped, as notices are live only. */
  setSink(sink: ((event: MemorySaveResultEvent) => void) | undefined): void {
    this.sink = sink;
  }

  /** A save landed; the returned token undoes it. An update whose earlier bytes could not be read has nothing to put back. */
  saved(target: MemoryNoticeTarget | undefined, result: Pick<MemorySaveResult, "op" | "entry" | "fileDigest" | "priorContent">): string | undefined {
    const { op, entry, fileDigest, priorContent } = result;
    const id = requireId(entry);
    const undoToken = op === "created"
      ? this.remember({ kind: "created", memoryId: id, filename: entry.filename, title: entry.title, fileDigest })
      : priorContent !== undefined
        ? this.remember({ kind: "updated", memoryId: id, filename: entry.filename, title: entry.title, fileDigest, priorContent })
        : undefined;
    this.emit(target, { status: "saved", op, entry: noticeEntry(id, entry), ...(undoToken ? { undoToken } : {}) });
    return undoToken;
  }

  /** A delete landed; the returned token restores it. Legacy notes without an id have nothing to restore. */
  deleted(target: MemoryNoticeTarget | undefined, entry: NoteEntry, priorContent: string | null): string | undefined {
    // Legacy notes without an id never got an undo record, so there is nothing to forget or restore.
    if (!entry.id) return undefined;
    // A delete scrubs the memory's history; its earlier undo records (with their old text) go too. This runs after the
    // delete's lock is released, so a new create may already hold the same file name; its records carry another id.
    this.forget(entry.id);
    if (priorContent === null) return undefined;
    const undoToken = this.remember({ kind: "deleted", memoryId: entry.id, filename: entry.filename, title: entry.title, priorContent });
    this.emit(target, { status: "saved", op: "deleted", entry: noticeEntry(entry.id, entry), undoToken });
    return undoToken;
  }

  skipped(target: MemoryNoticeTarget | undefined, reason: MemorySaveSkipReason): void {
    this.emit(target, { status: "skipped", reason });
  }

  /**
   * Each token undoes once. "changed" when the memory moved on since, so an undo never discards a newer edit; "not-found"
   * when the token is unknown (after a restart, or pushed out of the ring). A failed undo keeps its token for a retry.
   */
  async undo(token: string): Promise<MemoryUndoResult> {
    const record = this.records.get(token);
    if (!record) return { ok: false, error: "not-found" };
    this.records.delete(token);
    let outcome: "deleted" | "restored" | "changed";
    try {
      outcome = record.kind === "created"
        ? await this.memoryManager.deleteMemoryIfUnchanged(record.filename, record.fileDigest, "user")
        : record.kind === "updated"
          ? await this.memoryManager.restoreMemoryIfUnchanged(record.filename, record.fileDigest, record.priorContent, "user")
          : await this.memoryManager.restoreDeletedMemory(record.filename, record.priorContent, "user");
    } catch (error) {
      this.records.set(token, record);
      throw error;
    }
    if (outcome === "changed") return { ok: false, error: "changed" };
    // Undoing a create deletes the memory, which scrubs its history, so no earlier text is kept for it either.
    if (record.kind === "created") this.forget(record.memoryId);
    return { ok: true, undone: record.kind, title: record.title };
  }

  private forget(memoryId: string): void {
    for (const [token, record] of this.records) {
      if (record.memoryId === memoryId) this.records.delete(token);
    }
  }

  private remember(record: UndoRecord): string {
    const token = randomUUID();
    this.records.set(token, record);
    // Map keeps insertion order, so the first key is the oldest record.
    while (this.records.size > this.maxRecords) {
      const oldest = this.records.keys().next().value as string;
      this.records.delete(oldest);
    }
    return token;
  }

  private emit(target: MemoryNoticeTarget | undefined, result: MemorySaveNoticeResult): void {
    // A save outside a conversation (the memory panel) has no chat to show a notice in.
    if (!target || !this.sink) return;
    try {
      this.sink({
        sessionId: target.sessionId,
        ...(target.anchorMessageId !== undefined ? { anchorMessageId: target.anchorMessageId } : {}),
        result,
      });
    } catch (error) {
      log.warn("memory save notice could not be sent: %s", (error as Error).message);
    }
  }
}

function requireId(entry: NoteEntry): string {
  if (!entry.id) throw new Error("memory save notice: a saved memory always has an id");
  return entry.id;
}

function noticeEntry(id: string, entry: NoteEntry): { id: string; filename: string; title: string; scope: "project" | "global" } {
  return { id, filename: entry.filename, title: entry.title, scope: entry.projectRoot ? "project" : "global" };
}

/** Where a tool's notice goes: the conversation and the user row that opened the turn, both from host metadata. */
export function toolNoticeTarget(metadata: Record<string, unknown> | undefined): MemoryNoticeTarget | undefined {
  const sessionId = metadata?.sessionId;
  if (typeof sessionId !== "string") return undefined;
  const anchor = metadata?.turnMessageId;
  return { sessionId, ...(typeof anchor === "string" ? { anchorMessageId: anchor } : {}) };
}
