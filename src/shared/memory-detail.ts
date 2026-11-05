import type { MemoryHistoryRead } from "../memory/memory-history.js";
import type { MemoryUseStore, MemoryUseVia } from "../memory/memory-usage-log.js";

export interface MemoryUsageRow {
  memoryId: string;
  via: MemoryUseVia;
  sessionId: string;
  store?: MemoryUseStore;
  anchorMessageId?: string;
  at: string;
  /** Live conversation title, resolved by the host; never persisted in the usage log. */
  title?: string;
}

export interface MemoryUsageRead {
  /** Retained uses of this memory, newest first; different use kinds remain separate rows. */
  entries: MemoryUsageRow[];
  /** A damaged record or bounded tail read may have omitted uses. Can coexist with limited. */
  incomplete?: true;
  /** The reader returns at most the newest 200 matching uses. */
  limited?: true;
}

export type MemoryResolvedOrigin =
  /** No source location was recorded when this memory was saved. */
  | { status: "absent" }
  /** The recorded conversation or message could not be read; other detail data remains available. */
  | { status: "unavailable"; sessionId: string; messageId?: string }
  /** Session-only sources have no message fields. Ordinal counts all stored messages starting at one. */
  | { status: "resolved"; sessionId: string; messageId?: string; title?: string; quote?: string; messageOrdinal?: number };

export type MemoryDetailResult =
  | { ok: true; history: MemoryHistoryRead; origin: MemoryResolvedOrigin; usage: MemoryUsageRead }
  | { ok: false; error: "invalid-input" | "project-not-allowed" | "not-found" | "read-failed" | "unauthorized-frame" };
