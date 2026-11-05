import type { GenericMessage } from "../engine/llm/types.js";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { isRecord } from "../shared/is-record.js";
import { UUID_PATTERN } from "../shared/uuid.js";
import { isValidSessionId } from "../shared/session-id.js";
import type { MemoryDetailResult, MemoryResolvedOrigin, MemoryUsageRead, MemoryUsageRow } from "../shared/memory-detail.js";
import type { MemoryManager, MemoryOriginV1, ProjectScopedMemoryOptions } from "./memory-manager.js";
import type { MemoryUseStore } from "./memory-usage-log.js";

const MAX_USAGE_READ_BYTES = 2 * 1024 * 1024;
const MAX_USAGE_ROWS = 200;
const MAX_ORIGIN_QUOTE_CHARS = 2_048;

export interface MemoryConversationReader {
  /** Persistence is untrusted; source identity is decoded from the stored message metadata below. */
  loadSession: MemoryManager["loadSession"];
  loadSessionMetadata: (sessionId: string) => { title?: string } | null;
}

type MemoryConversationStores = Partial<Record<MemoryUseStore, MemoryConversationReader>>;

function parseUsageRow(value: unknown): value is MemoryUsageRow & { v: 1 } {
  if (!isRecord(value) || value.v !== 1 || typeof value.memoryId !== "string" || !UUID_PATTERN.test(value.memoryId)) return false;
  if (value.via !== "injected" && value.via !== "searched" && value.via !== "read") return false;
  if (typeof value.sessionId !== "string" || !isValidSessionId(value.sessionId)) return false;
  if (value.store !== undefined && value.store !== "main" && value.store !== "side-chat" && value.store !== "subagent") return false;
  if (value.anchorMessageId !== undefined && (typeof value.anchorMessageId !== "string" || value.anchorMessageId.length === 0)) return false;
  return typeof value.at === "string" && Number.isFinite(Date.parse(value.at));
}

/** Bounded tail read: a truncated first row and malformed records are explicitly reported. */
async function readUsage(path: string, memoryId: string): Promise<MemoryUsageRead> {
  let handle;
  try { handle = await open(path, "r"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { entries: [] };
    throw error;
  }
  try {
    const size = (await handle.stat()).size;
    const offset = Math.max(0, size - MAX_USAGE_READ_BYTES);
    const buffer = Buffer.alloc(Math.min(size, MAX_USAGE_READ_BYTES));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    const lines = (offset > 0 ? text.slice(text.indexOf("\n") + 1) : text).split("\n");
    let incomplete = offset > 0;
    const entries: MemoryUsageRow[] = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      let row: unknown;
      try { row = JSON.parse(line); } catch { incomplete = true; continue; }
      if (!parseUsageRow(row)) { incomplete = true; continue; }
      if (row.memoryId.toLowerCase() === memoryId.toLowerCase()) {
        entries.push({
          memoryId: row.memoryId, via: row.via, sessionId: row.sessionId, at: row.at,
          ...(row.store ? { store: row.store } : {}),
          ...(row.anchorMessageId ? { anchorMessageId: row.anchorMessageId } : {}),
        });
      }
    }
    entries.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
    return { entries: entries.slice(0, MAX_USAGE_ROWS), ...(incomplete ? { incomplete: true } : {}), ...(entries.length > MAX_USAGE_ROWS ? { limited: true } : {}) };
  } finally { await handle.close(); }
}

function sourceMessageId(message: unknown): NonNullable<GenericMessage["meta"]>["messageId"] {
  if (!isRecord(message) || !isRecord(message.meta)) return undefined;
  return typeof message.meta.messageId === "string" ? message.meta.messageId : undefined;
}

function sourceQuote(message: Record<string, unknown>): string | undefined {
  const content = message.content;
  if (typeof content === "string") return content.slice(0, MAX_ORIGIN_QUOTE_CHARS);
  if (!Array.isArray(content)) return undefined;
  const text = content.filter(isRecord).filter((part) => part.type === "text" && typeof part.text === "string").map((part) => part.text).join("\n");
  return text ? text.slice(0, MAX_ORIGIN_QUOTE_CHARS) : undefined;
}

function resolveOrigin(origin: MemoryOriginV1 | undefined, stores: MemoryConversationStores): MemoryResolvedOrigin {
  if (!origin) return { status: "absent" };
  const target = { sessionId: origin.sessionId, ...(origin.messageId ? { messageId: origin.messageId } : {}) };
  const namespaces: MemoryUseStore[] = origin.store ? [origin.store] : ["main", "side-chat", "subagent"];
  for (const namespace of namespaces) {
    const reader = stores[namespace];
    if (!reader) continue;
    let messages: unknown[] | null;
    let title: string | undefined;
    try {
      messages = reader.loadSession(origin.sessionId);
      title = reader.loadSessionMetadata(origin.sessionId)?.title;
    } catch { continue; }
    if (!messages) continue;
    const index = origin.messageId ? messages.findIndex((message) => sourceMessageId(message) === origin.messageId) : -1;
    if (origin.messageId && index < 0) return { status: "unavailable", ...target };
    const message = index >= 0 ? messages[index] : undefined;
    const quote = isRecord(message) ? sourceQuote(message) : undefined;
    return { status: "resolved", ...target, ...(title ? { title } : {}), ...(quote !== undefined ? { quote } : {}), ...(index >= 0 ? { messageOrdinal: index + 1 } : {}) };
  }
  return { status: "unavailable", ...target };
}

function usageTitles(usage: MemoryUsageRead, stores: MemoryConversationStores): MemoryUsageRead {
  const titles = new Map<string, string | undefined>();
  return { ...usage, entries: usage.entries.map((row) => {
    const key = (row.store ?? "") + "\0" + row.sessionId;
    if (!titles.has(key)) {
      let title: string | undefined;
      const namespaces: MemoryUseStore[] = row.store ? [row.store] : ["main", "side-chat", "subagent"];
      for (const namespace of namespaces) {
        const reader = stores[namespace];
        if (!reader) continue;
        try {
          const metadata = reader.loadSessionMetadata(row.sessionId);
          if (metadata) { title = metadata.title; break; }
        } catch { continue; }
      }
      titles.set(key, title);
    }
    const title = titles.get(key);
    return title ? { ...row, title } : row;
  }) };
}

/** Scope is checked before any provenance or log data is read. */
export async function readMemoryDetail(manager: MemoryManager, id: string, options: ProjectScopedMemoryOptions, stores: MemoryConversationStores): Promise<MemoryDetailResult> {
  if (!UUID_PATTERN.test(id)) return { ok: false, error: "invalid-input" };
  try {
    const entry = manager.listMemoryEntries(options).find((candidate) => candidate.id?.toLowerCase() === id.toLowerCase());
    if (!entry) return { ok: false, error: "not-found" };
    const [history, usage] = await Promise.all([manager.getMemoryHistory(id, options), readUsage(join(manager.getDir(), "memories", "usage.jsonl"), id)]);
    return { ok: true, history, usage: usageTitles(usage, stores), origin: resolveOrigin(entry.origin, stores) };
  } catch { return { ok: false, error: "read-failed" }; }
}
