import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createLogger } from "../lib/logger.js";
import type { SessionIdNamespaceKind } from "../shared/dlp-safe-id.js";
import { appendJsonlCapped } from "./capped-jsonl.js";

// Append-only record of which managed memory backed which answer: prompt injection, memory_search results, memory_read.
// Rows hold ids, the path, session/turn ids and a timestamp only — never memory text, queries, or user text — so the log
// cannot become a second copy of personal data. Legacy notes without a managed id are not recorded (the id is the identity).
// Work-board children build prompts from the isolated sub-agent store, so they never inject user memories; their
// memory_search/memory_read calls still reach the main store and are recorded as searched/read.

const log = createLogger("memory-usage");

export const MEMORY_USAGE_LOG_FILENAME = "usage.jsonl";
/** Rows are ~200 bytes, so this keeps on the order of ten thousand recent uses. */
const DEFAULT_MEMORY_USAGE_LOG_MAX_BYTES = 2 * 1024 * 1024;

const MEMORY_USE_VIAS = ["injected", "searched", "read"] as const;
export type MemoryUseVia = (typeof MEMORY_USE_VIAS)[number];

/** The session store the conversation lives in. Recorded only when known by construction; readers resolve the rest. */
const MEMORY_USE_STORES = ["main", "side-chat", "subagent"] as const;
export type MemoryUseStore = (typeof MEMORY_USE_STORES)[number];

export interface MemoryUseEvent {
  memoryIds: readonly string[];
  via: MemoryUseVia;
  sessionId: string;
  store?: MemoryUseStore;
  /** The user message that opened the turn. */
  anchorMessageId?: string;
}

interface MemoryUseRecordV1 {
  v: 1;
  memoryId: string;
  via: MemoryUseVia;
  sessionId: string;
  store?: MemoryUseStore;
  anchorMessageId?: string;
  at: string;
}

export interface MemoryUsageRecorder {
  /** Queue rows for the event. Throws only on an internal contract violation; disk failures never reach the caller. */
  record(event: MemoryUseEvent): void;
}

// Sub-agent children are minted as `sub-<tag>-<uuid>` (subagent-runner buildChildSessionId); `a2a-wire-` ids are origin labels, not sessions.
const SUBAGENT_SESSION_KIND: SessionIdNamespaceKind = "sub";

/** Only sub-agent child ids carry their store in the id; a plain id may be main or side-chat, so it is left unresolved. */
export function memoryUseStoreForSessionId(sessionId: string): MemoryUseStore | undefined {
  return sessionId.startsWith(`${SUBAGENT_SESSION_KIND}-`) ? "subagent" : undefined;
}

function requireNonEmpty(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`memory usage log: ${field} must be a non-empty string`);
  }
  return value;
}

function toRecords(event: MemoryUseEvent, at: string): MemoryUseRecordV1[] {
  if (!(MEMORY_USE_VIAS as readonly string[]).includes(event.via)) {
    throw new Error(`memory usage log: unknown via ${JSON.stringify(event.via)}`);
  }
  const sessionId = requireNonEmpty(event.sessionId, "sessionId");
  if (event.store !== undefined && !(MEMORY_USE_STORES as readonly string[]).includes(event.store)) {
    throw new Error(`memory usage log: unknown store ${JSON.stringify(event.store)}`);
  }
  if (event.anchorMessageId !== undefined) requireNonEmpty(event.anchorMessageId, "anchorMessageId");
  return event.memoryIds.map((memoryId) => ({
    v: 1,
    memoryId: requireNonEmpty(memoryId, "memoryId"),
    via: event.via,
    sessionId,
    ...(event.store !== undefined ? { store: event.store } : {}),
    ...(event.anchorMessageId !== undefined ? { anchorMessageId: event.anchorMessageId } : {}),
    at,
  }));
}

export class MemoryUsageLog implements MemoryUsageRecorder {
  readonly path: string;
  private readonly memoryDir: string;
  private readonly maxBytes: number;
  private readonly now: () => Date;
  private tail: Promise<void> = Promise.resolve();

  /** `aveDir` is the owning MemoryManager's root; the log lives in its `memories/` directory. */
  constructor(options: { aveDir: string; maxBytes?: number; now?: () => Date }) {
    this.memoryDir = join(options.aveDir, "memories");
    this.path = join(this.memoryDir, MEMORY_USAGE_LOG_FILENAME);
    this.maxBytes = options.maxBytes ?? DEFAULT_MEMORY_USAGE_LOG_MAX_BYTES;
    this.now = options.now ?? (() => new Date());
  }

  record(event: MemoryUseEvent): void {
    const records = toRecords(event, this.now().toISOString());
    if (records.length === 0) return;
    // Serialize appends so rows keep call order and rotation never races another write; the disk is an external boundary.
    this.tail = this.tail.then(async () => {
      try {
        await mkdir(this.memoryDir, { recursive: true, mode: 0o700 });
        await appendJsonlCapped(this.path, records, this.maxBytes);
      } catch (err) {
        log.warn("memory use not recorded (%s rows): %s", records.length, (err as NodeJS.ErrnoException).code ?? "error");
      }
    });
  }

  /** Resolves once every queued row is written or reported. */
  whenIdle(): Promise<void> {
    return this.tail;
  }
}
