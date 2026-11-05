import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendFileSync, mkdtempSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open } from "node:fs/promises";
import { MemoryManager } from "../memory-manager.js";
import { MemoryUsageLog } from "../memory-usage-log.js";
import { readMemoryDetail, readMemorySummaries } from "../memory-detail.js";
import type { GenericMessage } from "../../engine/llm/types.js";
import { serializeHistoryMessage } from "../../shared/chat-history.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open) };
});

let dir: string;
let manager: MemoryManager;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "ave-memory-detail-")); manager = new MemoryManager({ aveDir: dir }); });
afterEach(async () => { vi.restoreAllMocks(); manager.stopPersistentContextWatcher(); manager.closeSearchIndex(); await cleanupTmpDir(dir); });

function saveMessages(sessionId: string, messages: GenericMessage[]): Promise<void> {
  return manager.saveSession(sessionId, messages);
}

describe("memory detail", () => {
  it.each(["deleted", "missing-metadata", "invalid-metadata"] as const)("marks the list origin unavailable for a %s conversation source", async (state) => {
    const sessionId = "11111111-1111-4111-8111-111111111111";
    await saveMessages(sessionId, [{ role: "user", meta: { messageId: "source" }, content: "Remember this fact" }]);
    await manager.saveSessionMetadata(sessionId, { title: "Source conversation" });
    const { entry } = await manager.saveMemory("Fact", "Remembered", { origin: { v: 1, sessionId, messageId: "source", store: "main" } }, "user");
    if (state === "deleted") await manager.deleteSession(sessionId);
    else if (state === "missing-metadata") unlinkSync(join(dir, "sessions", `${sessionId}.meta.json`));
    else writeFileSync(join(dir, "sessions", `${sessionId}.meta.json`), "{invalid metadata}");
    expect(manager.loadSessionMetadata(sessionId)).toBeNull();
    const transcript = vi.spyOn(manager, "loadSession");
    const result = await readMemorySummaries(manager, {}, { main: manager }, "/workspace/default");
    expect(result).toMatchObject({ ok: true, entries: [{ id: entry.id, origin: { status: "unavailable", sessionId, messageId: "source" } }] });
    expect(transcript).not.toHaveBeenCalled();
    if (state === "deleted") {
      expect(await readMemoryDetail(manager, entry.id!, {}, { main: manager })).toMatchObject({ ok: true, origin: { status: "unavailable", sessionId } });
    }
  });

  it("resolves live source text and exact message identity without counting internal transcript rows", async () => {
    const sessionId = "11111111-1111-4111-8111-111111111111";
    const source: GenericMessage = { role: "user", meta: { messageId: "source" }, content: "Use small changes" };
    await saveMessages(sessionId, [
      { role: "user", meta: { messageId: "opening" }, content: "Earlier request" },
      { role: "assistant", content: "Earlier answer" },
      source,
    ]);
    expect(manager.loadSession(sessionId)?.[2]).toMatchObject({ meta: { messageId: "source" } });
    const historyRow = serializeHistoryMessage(source, 2);
    expect(historyRow.messageId).toBe("source");
    await manager.saveSessionMetadata(sessionId, { title: "Review request" });
    const { entry } = await manager.saveMemory("Review", "Small changes", { origin: { v: 1, sessionId, messageId: "source", store: "main" } }, "user");
    const usage = new MemoryUsageLog({ aveDir: dir });
    usage.record({ memoryIds: [entry.id!.toUpperCase(), "33333333-3333-4333-8333-333333333333"], via: "searched", sessionId });
    await usage.whenIdle();
    const result = await readMemoryDetail(manager, entry.id!, {}, { main: manager });
    expect(result).toMatchObject({ ok: true, origin: { status: "resolved", sessionId, messageId: "source", title: "Review request", quote: "Use small changes" }, history: { entries: [{ op: "created" }] }, usage: { entries: [{ memoryId: entry.id!.toUpperCase(), via: "searched", title: "Review request" }] } });
    if (result.ok) {
      expect(result.usage.entries).toHaveLength(1);
      expect(result.origin).toMatchObject({ messageId: historyRow.messageId, quote: historyRow.content });
      expect(result.origin).not.toHaveProperty("messageOrdinal");
    }
    await saveMessages(sessionId, [{ role: "user", meta: { messageId: "source" }, content: "Updated live source" }]);
    expect(await readMemoryDetail(manager, entry.id!, {}, { main: manager })).toMatchObject({ origin: { quote: "Updated live source" } });
    await saveMessages(sessionId, [{ role: "user", meta: { messageId: "different-message" }, content: "Compacted replacement" }]);
    expect(await readMemoryDetail(manager, entry.id!, {}, { main: manager })).toMatchObject({ origin: { status: "unavailable", messageId: "source" } });
  });
  it("distinguishes missing origins, unavailable sources and scope failures", async () => {
    const absent = await manager.saveMemory("Absent", "No source", {}, "user");
    expect(await readMemoryDetail(manager, absent.entry.id!, {}, { main: manager })).toMatchObject({ origin: { status: "absent" } });
    const gone = await manager.saveMemory("Gone", "Source gone", { projectRoot: "/workspace/alpha", origin: { v: 1, sessionId: "22222222-2222-4222-8222-222222222222" } }, "user");
    expect(await readMemoryDetail(manager, gone.entry.id!, { projectRoot: "/workspace/alpha" }, { main: manager })).toMatchObject({ origin: { status: "unavailable" } });
    expect(await readMemoryDetail(manager, gone.entry.id!, { projectRoot: "/workspace/beta" }, { main: manager })).toEqual({ ok: false, error: "not-found" });
    expect(await readMemoryDetail(manager, "../invalid", {}, { main: manager })).toEqual({ ok: false, error: "invalid-input" });
  });
  it("honors the recorded source store and bounds newest usage rows", async () => {
    const sessionId = "11111111-1111-4111-8111-111111111111";
    await saveMessages(sessionId, [{ role: "user", meta: { messageId: "main-message" }, content: "Different store" }]);
    const { entry } = await manager.saveMemory("Store", "Isolated source", { origin: { v: 1, sessionId, store: "side-chat" } }, "user");
    const records = Array.from({ length: 205 }, (_, index) => JSON.stringify({ v: 1, memoryId: entry.id, via: "read", sessionId, at: new Date(index * 1000).toISOString() }));
    appendFileSync(join(dir, "memories", "usage.jsonl"), records.join("\n") + "\n");
    const result = await readMemoryDetail(manager, entry.id!, {}, { main: manager });
    expect(result).toMatchObject({ ok: true, origin: { status: "unavailable" }, usage: { limited: true } });
    if (result.ok) {
      expect(result.usage.entries).toHaveLength(200);
      expect(result.usage.entries[0]!.at).toBe(new Date(204000).toISOString());
    }
  });
  it("logs a filesystem source failure and leaves the memory detail available", async () => {
    const { entry } = await manager.saveMemory("Unreadable", "Keep the memory", { origin: { v: 1, sessionId: "11111111-1111-4111-8111-111111111111" } }, "user");
    const failure = Object.assign(new Error("Source access denied"), { code: "EACCES" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const source = { loadSession: () => { throw failure; }, loadSessionMetadata: () => null };
    expect(await readMemoryDetail(manager, entry.id!, {}, { main: source })).toMatchObject({ ok: true, origin: { status: "unavailable" } });
    expect(warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ err: failure }));
    vi.spyOn(manager, "listMemoryEntries").mockImplementationOnce(() => { throw Object.assign(new Error("Memory directory access denied"), { code: "EACCES" }); });
    expect(await readMemoryDetail(manager, entry.id!, {}, { main: manager })).toEqual({ ok: false, error: "read-failed" });
  });
  it("propagates internal history and source-reader contract failures", async () => {
    const { entry } = await manager.saveMemory("Invariant", "Keep errors visible", { origin: { v: 1, sessionId: "11111111-1111-4111-8111-111111111111" } }, "user");
    const failure = new Error("getMemoryHistory: memory not found");
    vi.spyOn(manager, "getMemoryHistory").mockRejectedValueOnce(failure);
    await expect(readMemoryDetail(manager, entry.id!, {}, { main: manager })).rejects.toBe(failure);
    const sourceFailure = new TypeError("Reader violated its contract");
    const source = { loadSession: () => { throw sourceFailure; }, loadSessionMetadata: () => null };
    await expect(readMemoryDetail(manager, entry.id!, {}, { main: source })).rejects.toBe(sourceFailure);
  });
  it("reports damaged usage records instead of presenting a complete empty log", async () => {
    const { entry } = await manager.saveMemory("Usage", "Recorded", {}, "user");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    appendFileSync(join(dir, "memories", "usage.jsonl"), "{broken}\n");
    expect(await readMemoryDetail(manager, entry.id!, {}, { main: manager })).toMatchObject({ ok: true, usage: { entries: [], incomplete: true } });
    expect(warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ err: expect.any(SyntaxError), damaged: 1 }));
  });

  it("logs metadata parse failures but propagates metadata reader programming failures", async () => {
    const { entry } = await manager.saveMemory("Metadata", "A remembered fact", {}, "user");
    const usage = new MemoryUsageLog({ aveDir: dir });
    usage.record({ memoryIds: [entry.id!], via: "read", sessionId: "11111111-1111-4111-8111-111111111111", store: "main" });
    await usage.whenIdle();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const parseFailure = new SyntaxError("Malformed session metadata");
    const source = { loadSession: () => null, loadSessionMetadata: () => { throw parseFailure; } };
    expect(await readMemoryDetail(manager, entry.id!, {}, { main: source })).toMatchObject({ ok: true, usage: { entries: [{ via: "read" }] } });
    expect(warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ err: parseFailure, operation: "conversation-metadata" }));
    const failure = new TypeError("Invalid metadata reader result");
    source.loadSessionMetadata = () => { throw failure; };
    await expect(readMemoryDetail(manager, entry.id!, {}, { main: source })).rejects.toBe(failure);
  });

  it("aggregates sixty memories with one catalog and usage read, cached metadata and no transcript or history reads", async () => {
    const sessionId = "11111111-1111-4111-8111-111111111111";
    await saveMessages(sessionId, Array.from({ length: 200 }, (_, index) => ({ role: "user", meta: { messageId: `message-${index}` }, content: `Conversation message ${index}` })));
    await manager.saveSessionMetadata(sessionId, { title: "Shared origin title" });
    const notes = [];
    for (let index = 0; index < 60; index += 1) {
      notes.push((await manager.saveMemory(`Memory ${index}`, `Fact ${index}`, { kind: "fact", origin: { v: 1, sessionId, messageId: "message-99", store: "main" } }, "user")).entry);
    }
    const usageRows = notes.flatMap((note) => Array.from({ length: 10 }, (_, index) => JSON.stringify({ v: 1, memoryId: note.id, via: "injected", sessionId, store: "main", at: new Date(index * 1000).toISOString() })));
    appendFileSync(join(dir, "memories", "usage.jsonl"), usageRows.join("\n") + "\n");
    const catalog = vi.spyOn(manager, "readMemoryPanelCatalog");
    const history = vi.spyOn(manager, "getMemoryHistory");
    const transcript = vi.spyOn(manager, "loadSession");
    const metadata = vi.spyOn(manager, "loadSessionMetadata");
    vi.mocked(open).mockClear();
    const result = await readMemorySummaries(manager, {}, { main: manager }, "/workspace/default");
    expect(catalog).toHaveBeenCalledTimes(1);
    expect(vi.mocked(open).mock.calls.filter(([path]) => String(path).endsWith("usage.jsonl"))).toHaveLength(1);
    expect(history).not.toHaveBeenCalled();
    expect(transcript).not.toHaveBeenCalled();
    expect(metadata).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected memory summaries");
    expect(result.notes).toHaveLength(60);
    expect(result.entries).toHaveLength(60);
    expect(result.entries.every((entry) => entry.useCount === 10 && entry.lastUsedAt === new Date(9000).toISOString())).toBe(true);
    expect(result.entries[0]!.origin).toEqual({ status: "recorded", sessionId, messageId: "message-99", title: "Shared origin title" });
    expect(result.scopeCounts.global).toBe(60);
  });

  it("counts every retained use in summaries while detail remains bounded", async () => {
    const { entry } = await manager.saveMemory("Popular", "Frequently used", {}, "user");
    const records = Array.from({ length: 205 }, (_, index) => JSON.stringify({ v: 1, memoryId: entry.id, via: "read", sessionId: "11111111-1111-4111-8111-111111111111", at: new Date(index * 1000).toISOString() }));
    appendFileSync(join(dir, "memories", "usage.jsonl"), records.join("\n") + "\n");
    expect(await readMemorySummaries(manager, {}, { main: manager }, "/workspace/default")).toMatchObject({ ok: true, entries: [{ id: entry.id, useCount: 205, lastUsedAt: new Date(204000).toISOString() }] });
  });

  it("logs summary filesystem errors and propagates summary programming errors", async () => {
    const failure = Object.assign(new Error("Catalog access denied"), { code: "EACCES" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const catalog = vi.spyOn(manager, "readMemoryPanelCatalog").mockImplementationOnce(() => { throw failure; });
    expect(await readMemorySummaries(manager, {}, { main: manager }, "/workspace/default")).toEqual({ ok: false, error: "read-failed" });
    expect(warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ err: failure, operation: "summaries" }));
    const contractFailure = new TypeError("Invalid catalog contract");
    catalog.mockImplementationOnce(() => { throw contractFailure; });
    await expect(readMemorySummaries(manager, {}, { main: manager }, "/workspace/default")).rejects.toBe(contractFailure);
  });

  it("keeps a cached metadata read failure unavailable for every memory from that source", async () => {
    const sessionId = "11111111-1111-4111-8111-111111111111";
    for (const title of ["First source", "Second source"]) {
      await manager.saveMemory(title, "Remembered", { origin: { v: 1, sessionId, store: "main" } }, "user");
    }
    const failure = Object.assign(new Error("Session metadata access denied"), { code: "EACCES" });
    const metadata = vi.fn(() => { throw failure; });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await readMemorySummaries(manager, {}, { main: { loadSession: () => null, loadSessionMetadata: metadata } }, "/workspace/default");
    expect(metadata).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ err: failure }));
    if (!result.ok) throw new Error("Expected summaries despite unavailable source metadata");
    expect(result.entries.map((entry) => entry.origin)).toEqual([{ status: "unavailable", sessionId }, { status: "unavailable", sessionId }]);
  });
});
