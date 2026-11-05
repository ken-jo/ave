import type { GenericMessage } from "../engine/llm/types.js";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { createLogger } from "../lib/logger.js";
import { isRecord } from "../shared/is-record.js";
import { UUID_PATTERN } from "../shared/uuid.js";
import { isValidSessionId } from "../shared/session-id.js";
import type { MemoryDetailResult, MemoryOriginSummary, MemoryResolvedOrigin, MemorySummariesResult, MemoryUsageRead, MemoryUsageRow } from "../shared/memory-detail.js";
import type { MemoryManager, MemoryOriginV1, ProjectScopedMemoryOptions } from "./memory-manager.js";
import { MEMORY_USAGE_LOG_FILENAME, type MemoryUseStore } from "./memory-usage-log.js";

const log = createLogger("memory-detail");
const MAX_USAGE_READ_BYTES = 2 * 1024 * 1024;
const MAX_USAGE_ROWS = 200;
const MAX_ORIGIN_QUOTE_CHARS = 2_048;
const FILESYSTEM_ERROR_CODES = new Set(["ENOENT", "EACCES", "EPERM", "ENOTDIR", "EISDIR", "EIO", "EMFILE", "ENFILE", "ESTALE", "EBUSY", "ETIMEDOUT"]);

interface MemoryConversationReader {
  /** Persistence is untrusted; source identity is decoded from the stored message metadata below. */
  loadSession: MemoryManager["loadSession"];
  loadSessionMetadata: (sessionId: string) => { title?: string } | null;
}

type MemoryConversationStores = Partial<Record<MemoryUseStore, MemoryConversationReader>>;
type UsageFileRead = { entries: MemoryUsageRow[]; incomplete?: true; limited?: true };

function isFilesystemError(error: unknown): boolean {
  return isRecord(error) && typeof error.code === "string" && FILESYSTEM_ERROR_CODES.has(error.code);
}

function logBoundaryFailure(error: unknown, operation: string): void {
  log.warn({ err: error, operation }, "Memory source could not be read");
}

function parseUsageRow(value: unknown): value is MemoryUsageRow & { v: 1 } {
  if (!isRecord(value) || value.v !== 1 || typeof value.memoryId !== "string" || !UUID_PATTERN.test(value.memoryId)) return false;
  if (value.via !== "injected" && value.via !== "searched" && value.via !== "read") return false;
  if (typeof value.sessionId !== "string" || !isValidSessionId(value.sessionId)) return false;
  if (value.store !== undefined && value.store !== "main" && value.store !== "side-chat" && value.store !== "subagent") return false;
  if (value.anchorMessageId !== undefined && (typeof value.anchorMessageId !== "string" || value.anchorMessageId.length === 0)) return false;
  return typeof value.at === "string" && Number.isFinite(Date.parse(value.at));
}

/** One bounded tail read, shared by the list aggregation and selected-memory detail paths. */
async function readUsageFile(path: string): Promise<UsageFileRead> {
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
    let damaged = 0;
    let firstCause: unknown;
    const entries: MemoryUsageRow[] = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      let row: unknown;
      try { row = JSON.parse(line); } catch (error) {
        incomplete = true;
        damaged += 1;
        firstCause ??= error;
        continue;
      }
      if (!parseUsageRow(row)) {
        incomplete = true;
        damaged += 1;
        firstCause ??= new Error("Invalid memory usage record");
        continue;
      }
      entries.push({
        memoryId: row.memoryId, via: row.via, sessionId: row.sessionId, at: row.at,
        ...(row.store ? { store: row.store } : {}),
        ...(row.anchorMessageId ? { anchorMessageId: row.anchorMessageId } : {}),
      });
    }
    if (damaged > 0) log.warn({ err: firstCause, damaged }, "Damaged memory usage records were omitted");
    return { entries, ...(incomplete ? { incomplete: true } : {}), ...(offset > 0 ? { limited: true } : {}) };
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

function sourceNamespaces(store: MemoryUseStore | undefined): MemoryUseStore[] {
  return store ? [store] : ["main", "side-chat", "subagent"];
}

function resolveOrigin(origin: MemoryOriginV1 | undefined, stores: MemoryConversationStores): MemoryResolvedOrigin {
  if (!origin) return { status: "absent" };
  const target = { sessionId: origin.sessionId, ...(origin.messageId ? { messageId: origin.messageId } : {}) };
  for (const namespace of sourceNamespaces(origin.store)) {
    const reader = stores[namespace];
    if (!reader) continue;
    let messages: unknown[] | null;
    let title: string | undefined;
    try {
      messages = reader.loadSession(origin.sessionId);
      title = reader.loadSessionMetadata(origin.sessionId)?.title;
    } catch (error) {
      if (!isFilesystemError(error) && !(error instanceof SyntaxError)) throw error;
      logBoundaryFailure(error, "origin");
      continue;
    }
    if (!messages) continue;
    const index = origin.messageId ? messages.findIndex((message) => sourceMessageId(message) === origin.messageId) : -1;
    if (origin.messageId && index < 0) {
      log.warn({ ...target, reason: "message-not-found" }, "Recorded memory source message is unavailable");
      return { status: "unavailable", ...target };
    }
    const message = index >= 0 ? messages[index] : undefined;
    const quote = isRecord(message) ? sourceQuote(message) : undefined;
    return { status: "resolved", ...target, ...(title ? { title } : {}), ...(quote !== undefined ? { quote } : {}) };
  }
  log.warn({ sessionId: origin.sessionId, reason: "source-not-found" }, "Recorded memory source is unavailable");
  return { status: "unavailable", ...target };
}

/** Cache only metadata; list summaries and use-row titles never load a transcript. */
function metadataReader(stores: MemoryConversationStores) {
  const cache = new Map<string, { metadata: { title?: string } | null; unavailable: boolean }>();
  return (sessionId: string, store?: MemoryUseStore): { metadata: { title?: string } | null; unavailable: boolean } => {
    let unavailable = false;
    for (const namespace of sourceNamespaces(store)) {
      const reader = stores[namespace];
      if (!reader) continue;
      const key = namespace + "\0" + sessionId;
      if (!cache.has(key)) {
        try { cache.set(key, { metadata: reader.loadSessionMetadata(sessionId), unavailable: false }); }
        catch (error) {
          if (!isFilesystemError(error) && !(error instanceof SyntaxError)) throw error;
          logBoundaryFailure(error, "conversation-metadata");
          cache.set(key, { metadata: null, unavailable: true });
        }
      }
      const cached = cache.get(key)!;
      unavailable ||= cached.unavailable;
      const metadata = cached.metadata;
      if (metadata) return { metadata, unavailable: false };
    }
    return { metadata: null, unavailable };
  };
}

function usageTitles(usage: MemoryUsageRead, stores: MemoryConversationStores): MemoryUsageRead {
  const readMetadata = metadataReader(stores);
  return { ...usage, entries: usage.entries.map((row) => {
    const title = readMetadata(row.sessionId, row.store).metadata?.title;
    return title ? { ...row, title } : row;
  }) };
}

/** Scope is checked before any provenance or log data is read; internal contract failures propagate. */
export async function readMemoryDetail(manager: MemoryManager, id: string, options: ProjectScopedMemoryOptions, stores: MemoryConversationStores): Promise<MemoryDetailResult> {
  if (!UUID_PATTERN.test(id)) return { ok: false, error: "invalid-input" };
  try {
    const entry = manager.listMemoryEntries(options).find((candidate) => candidate.id?.toLowerCase() === id.toLowerCase());
    if (!entry) return { ok: false, error: "not-found" };
    const [history, allUsage] = await Promise.all([manager.getMemoryHistory(id, options), readUsageFile(join(manager.getDir(), "memories", MEMORY_USAGE_LOG_FILENAME))]);
    const matching = allUsage.entries.filter((row) => row.memoryId.toLowerCase() === id.toLowerCase()).sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
    const usage: MemoryUsageRead = {
      entries: matching.slice(0, MAX_USAGE_ROWS),
      ...(allUsage.incomplete ? { incomplete: true } : {}),
      ...(allUsage.limited || matching.length > MAX_USAGE_ROWS ? { limited: true } : {}),
    };
    return { ok: true, history, usage: usageTitles(usage, stores), origin: resolveOrigin(entry.origin, stores) };
  } catch (error) {
    if (!isFilesystemError(error)) throw error;
    logBoundaryFailure(error, "detail");
    return { ok: false, error: "read-failed" };
  }
}

/** Aggregate retained use rows once for the entire scoped list, without history or transcript reads. */
export async function readMemorySummaries(manager: MemoryManager, options: ProjectScopedMemoryOptions, stores: MemoryConversationStores, defaultProjectRoot: string): Promise<MemorySummariesResult> {
  try {
    const { notes, scopeCounts } = manager.readMemoryPanelCatalog(options, defaultProjectRoot);
    const usage = await readUsageFile(join(manager.getDir(), "memories", MEMORY_USAGE_LOG_FILENAME));
    const uses = new Map<string, { useCount: number; lastUsedAt: string }>();
    for (const row of usage.entries) {
      const id = row.memoryId.toLowerCase();
      const previous = uses.get(id);
      uses.set(id, { useCount: (previous?.useCount ?? 0) + 1, lastUsedAt: previous && Date.parse(previous.lastUsedAt) > Date.parse(row.at) ? previous.lastUsedAt : row.at });
    }
    const readMetadata = metadataReader(stores);
    const entries = notes.flatMap((note) => {
      if (!note.id) return [];
      const origin: MemoryOriginSummary = note.origin ? (() => {
        const { metadata, unavailable } = readMetadata(note.origin.sessionId, note.origin.store);
        const location = { sessionId: note.origin.sessionId, ...(note.origin.messageId ? { messageId: note.origin.messageId } : {}) };
        return unavailable ? { status: "unavailable" as const, ...location } : { status: "recorded" as const, ...location, ...(metadata?.title ? { title: metadata.title } : {}) };
      })() : { status: "absent" };
      const use = uses.get(note.id.toLowerCase());
      return [{
        id: note.id,
        ...(note.kind ? { kind: note.kind } : {}),
        origin,
        useCount: use?.useCount ?? 0,
        ...(use ? { lastUsedAt: use.lastUsedAt } : {}),
        ...(note.createdAt ? { createdAt: note.createdAt } : {}),
        ...(note.updatedAt ? { updatedAt: note.updatedAt } : {}),
      }];
    });
    return { ok: true, notes, entries, scopeCounts, ...(usage.incomplete ? { incomplete: true } : {}), ...(usage.limited ? { limited: true } : {}) };
  } catch (error) {
    if (!isFilesystemError(error)) throw error;
    logBoundaryFailure(error, "summaries");
    return { ok: false, error: "read-failed" };
  }
}
