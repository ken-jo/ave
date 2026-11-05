import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryManager } from "../memory-manager.js";
import { MemoryUsageLog } from "../memory-usage-log.js";
import { readMemoryDetail } from "../memory-detail.js";
import type { GenericMessage } from "../../engine/llm/types.js";
import { serializeHistoryMessage } from "../../shared/chat-history.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";

let dir: string;
let manager: MemoryManager;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "ave-memory-detail-")); manager = new MemoryManager({ aveDir: dir }); });
afterEach(async () => { manager.stopPersistentContextWatcher(); manager.closeSearchIndex(); await cleanupTmpDir(dir); });

function saveMessages(sessionId: string, messages: GenericMessage[]): Promise<void> {
  return manager.saveSession(sessionId, messages);
}

describe("memory detail", () => {
  it("resolves live source text and ordinal, history, and only the requested memory's uses", async () => {
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
    expect(result).toMatchObject({ ok: true, origin: { status: "resolved", sessionId, messageId: "source", title: "Review request", quote: "Use small changes", messageOrdinal: 3 }, history: { entries: [{ op: "created" }] }, usage: { entries: [{ memoryId: entry.id!.toUpperCase(), via: "searched", title: "Review request" }] } });
    if (result.ok) {
      expect(result.usage.entries).toHaveLength(1);
      expect(result.origin).toMatchObject({ messageId: historyRow.messageId, quote: historyRow.content });
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
  it("returns a typed read failure and treats an unreadable source as unavailable", async () => {
    const { entry } = await manager.saveMemory("Unreadable", "Keep the memory", { origin: { v: 1, sessionId: "11111111-1111-4111-8111-111111111111" } }, "user");
    const source = { loadSession: () => { throw new Error("Unreadable source"); }, loadSessionMetadata: () => null };
    expect(await readMemoryDetail(manager, entry.id!, {}, { main: source })).toMatchObject({ ok: true, origin: { status: "unavailable" } });
    vi.spyOn(manager, "listMemoryEntries").mockImplementationOnce(() => { throw new Error("Unreadable memory directory"); });
    expect(await readMemoryDetail(manager, entry.id!, {}, { main: manager })).toEqual({ ok: false, error: "read-failed" });
  });
  it("reports damaged usage records instead of presenting a complete empty log", async () => {
    const { entry } = await manager.saveMemory("Usage", "Recorded", {}, "user");
    appendFileSync(join(dir, "memories", "usage.jsonl"), "{broken}\n");
    expect(await readMemoryDetail(manager, entry.id!, {}, { main: manager })).toMatchObject({ ok: true, usage: { entries: [], incomplete: true } });
  });
});
