import type { MemoryHistoryRead } from "../memory/memory-history.js";
import type { MemoryUseStore, MemoryUseVia } from "../memory/memory-usage-log.js";
import type { MemoryKind, NoteEntry } from "../memory/memory-manager.js";

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
  /** Session-only sources have no message fields. A message link uses its durable id, never a row position. */
  | { status: "resolved"; sessionId: string; messageId?: string; title?: string; quote?: string };

export type MemoryOriginSummary =
  | { status: "absent" }
  /** A recorded location and optional live title; the transcript is read only when opening its detail. */
  | { status: "recorded"; sessionId: string; messageId?: string; title?: string }
  | { status: "unavailable"; sessionId: string; messageId?: string };

export interface MemoryListSummary {
  id: string;
  kind?: MemoryKind;
  origin: MemoryOriginSummary;
  /** All matching retained use rows, rather than the 200-row detail page. */
  useCount: number;
  lastUsedAt?: string;
  createdAt?: string;
  updatedAt?: string;
}

export type MemorySummariesResult =
  | {
      ok: true;
      notes: NoteEntry[];
      entries: MemoryListSummary[];
      scopeCounts: { project: number; global: number; defaultProject: number; defaultProjectApplicable: boolean };
      incomplete?: true;
      limited?: true;
    }
  | { ok: false; error: "project-not-allowed" | "read-failed" | "unauthorized-frame" };

export type MemoryDetailResult =
  | { ok: true; history: MemoryHistoryRead; origin: MemoryResolvedOrigin; usage: MemoryUsageRead }
  | { ok: false; error: "invalid-input" | "project-not-allowed" | "not-found" | "read-failed" | "unauthorized-frame" };
