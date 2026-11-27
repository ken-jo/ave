import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { deferred } from "../../__tests__/support/deferred.js";
import { useTempDirs } from "../../__tests__/test-helpers.js";
import * as journal from "../session-turn-journal.js";
import { WindowsSessionRepository } from "../session-repository-win32.js";
import { SessionSearchIndex, type SessionSearchIndexPolicy } from "../session-search-index.js";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemoryManager } from "../memory-manager.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";

describe("MemoryManager boot index verification", () => {
  let aveDir: string;

  beforeEach(async () => {
    aveDir = await mkdtemp(join(tmpdir(), "ave-memory-boot-index-"));
  });

  afterEach(async () => {
    await cleanupTmpDir(aveDir);
  });

  it("does not enumerate session JSONL files when the index is healthy and populated", async () => {
    const manager = new MemoryManager({ aveDir });
    const close = vi.fn();
    const internals = manager.sessions as unknown as {
      searchIndex: {
        open(): boolean;
        rowCount(): number;
        close(): void;
      };
      listSessionJsonlFiles(): string[];
    };
    internals.searchIndex = {
      open: vi.fn(() => true),
      rowCount: vi.fn(() => 3),
      close,
    };
    const listSessionJsonlFiles = vi.fn(() => {
      throw new Error("healthy index must not scan the sessions directory");
    });
    internals.listSessionJsonlFiles = listSessionJsonlFiles;

    await expect(manager.sessions.verifyOrRebuildSearchIndex()).resolves.toBeUndefined();

    expect(listSessionJsonlFiles).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });
});

describe("queued session index repair", () => {
  const sessionId = "aaaaaaaa-1111-2222-3333-444444444444";
  const retainedId = "bbbbbbbb-1111-2222-3333-444444444444";
  const projectRoot = "C:/example/workspace";
  const current = () => "enabled-with-recovery" as const;
  const stores = ["main", "side-chat", "subagent"] as const;
  const mutations = ["save", "metadata", "delete"] as const;
  const makeDir = useTempDirs("ave-index-restart-");

  async function seed(aveDir: string): Promise<void> {
    const repository = new WindowsSessionRepository({ aveDir });
    await repository.saveSession(sessionId, [{ role: "user", content: "original searchable transcript" }]);
    await repository.saveSessionMetadata(sessionId, { projectRoot });
    await repository.saveSession(retainedId, [{ role: "user", content: "retained searchable transcript" }]);
    expect(repository.searchSessions("searchable")).toHaveLength(2);
    repository.closeSearchIndex();
  }

  it.each(stores.flatMap(store => mutations.map(mutation => [store, mutation] as const)))(
    "repairs a populated %s index after an acknowledged %s and an interrupted probe", async (store, mutation) => {
      const aveDir = join(makeDir(), store);
      await seed(aveDir);
      const waiting = deferred<() => SessionSearchIndexPolicy>();
      const interrupted = new WindowsSessionRepository({
        aveDir, getSearchIndexPolicy: current, refreshSearchIndexPolicy: () => waiting.promise,
      });
      const marker = join(aveDir, "sessions", ".search-repair.json");
      const recovered = new WindowsSessionRepository({ aveDir, getSearchIndexPolicy: current, refreshSearchIndexPolicy: async () => current });
      try {
        if (mutation === "save") await interrupted.saveSession(sessionId, [{ role: "user", content: "replacement transcript" }]);
        if (mutation === "metadata") await interrupted.saveSessionMetadata(sessionId, {});
        if (mutation === "delete") await interrupted.deleteSession(sessionId);
        expect.soft(existsSync(marker)).toBe(true);
        // Open the store again before any shutdown handler or pending index work can run.
        await recovered.verifyOrRebuildSearchIndex();
        expect.soft(await recovered.searchSessionsWithCurrentPolicy("retained searchable transcript")).toHaveLength(1);
        expect.soft(await recovered.searchSessionsWithCurrentPolicy("original searchable transcript", { projectRoot })).toEqual([]);
        expect.soft(await recovered.searchSessionsWithCurrentPolicy("original searchable transcript")).toHaveLength(mutation === "metadata" ? 1 : 0);
        expect.soft(await recovered.searchSessionsWithCurrentPolicy("replacement transcript")).toHaveLength(mutation === "save" ? 1 : 0);
        expect(existsSync(marker)).toBe(false);
      } finally {
        interrupted.closeSearchIndex();
        waiting.resolve(() => "inactive");
        await interrupted.searchIndexIdle();
        recovered.closeSearchIndex();
      }
    },
  );

  it("retains intent after a failed apply and includes a write that arrives while repair waits", async () => {
    const aveDir = makeDir();
    await seed(aveDir);
    const firstProbe = deferred<() => SessionSearchIndexPolicy>();
    const repairProbe = deferred<() => SessionSearchIndexPolicy>();
    const refresh = vi.fn().mockReturnValueOnce(firstProbe.promise).mockReturnValueOnce(repairProbe.promise).mockResolvedValue(current);
    const repository = new WindowsSessionRepository({ aveDir, getSearchIndexPolicy: current, refreshSearchIndexPolicy: refresh });
    const marker = join(aveDir, "sessions", ".search-repair.json");
    const apply = vi.spyOn(SessionSearchIndex.prototype, "upsertSessionAdmitted").mockImplementationOnce(() => false);
    try {
      await repository.saveSession(sessionId, [{ role: "user", content: "saved before failed apply" }]);
      firstProbe.resolve(current);
      await repository.searchIndexIdle();
      expect.soft(apply).toHaveBeenCalledOnce();
      expect.soft(existsSync(marker)).toBe(true);
      const repair = repository.verifyOrRebuildSearchIndex();
      await repository.saveSession(retainedId, [{ role: "user", content: "saved during repair" }]);
      expect.soft(existsSync(marker)).toBe(true);
      repairProbe.resolve(current);
      await repair;
      await repository.searchIndexIdle();
      expect(await repository.searchSessionsWithCurrentPolicy("saved before failed apply")).toHaveLength(1);
      expect(await repository.searchSessionsWithCurrentPolicy("saved during repair")).toHaveLength(1);
      expect(existsSync(marker)).toBe(false);
    } finally {
      apply.mockRestore();
      firstProbe.resolve(current);
      repairProbe.resolve(current);
      await repository.searchIndexIdle();
      repository.closeSearchIndex();
    }
  });
});

describe("interrupted progress on a populated index", () => {
  const makeDir = useTempDirs("ave-index-progress-");
  const sessionId = "aaaaaaaa-1111-2222-3333-444444444444";
  const current = () => "enabled-with-recovery" as const;
  const cases = ["main", "side-chat", "subagent"].flatMap(store => ["appended", "rewritten"].map(mode => [store, mode] as const));
  it.each(cases)("records repair for acknowledged progress in %s through %s", async (store, mode) => {
    const aveDir = join(makeDir(), store);
    const seeded = new WindowsSessionRepository({ aveDir });
    const old = { role: "user", content: "old indexed message", meta: { messageId: "old-row" } };
    await seeded.saveSession(sessionId, [old]);
    expect(seeded.searchSessions("old indexed message")).toHaveLength(1);
    seeded.closeSearchIndex();
    const held = deferred<() => SessionSearchIndexPolicy>();
    const repository = new WindowsSessionRepository({ aveDir, getSearchIndexPolicy: current, refreshSearchIndexPolicy: () => held.promise });
    const recovered = new WindowsSessionRepository({ aveDir });
    try {
      const row = { role: "assistant", content: "new persisted progress", meta: { messageId: "new-row" } };
      expect(await repository.appendSessionProgress(sessionId, mode === "appended" ? [old, row] : [row])).toBe(mode);
      expect(repository.loadSession(sessionId)).toContainEqual(expect.objectContaining({ content: "new persisted progress" }));
      expect.soft(existsSync(join(aveDir, "sessions", ".search-repair.json"))).toBe(true);
      await recovered.verifyOrRebuildSearchIndex();
      expect.soft(recovered.searchSessions("new persisted progress")).toHaveLength(1);
    } finally {
      repository.closeSearchIndex();
      held.resolve(() => "inactive");
      await repository.searchIndexIdle();
      recovered.closeSearchIndex();
    }
  });

  it("keeps repair intent while an asynchronous append races an older boot repair", async () => {
    const aveDir = makeDir();
    const old = { role: "user", content: "old indexed message", meta: { messageId: "old-row" } };
    const next = { role: "assistant", content: "content from a delayed append", meta: { messageId: "new-row" } };
    const seeded = new WindowsSessionRepository({ aveDir });
    await seeded.saveSession(sessionId, [old]);
    seeded.closeSearchIndex();
    const firstProbe = deferred<() => SessionSearchIndexPolicy>();
    const probe = vi.fn().mockReturnValueOnce(firstProbe.promise).mockResolvedValue(current);
    const repository = new WindowsSessionRepository({ aveDir, refreshSearchIndexPolicy: probe });
    const marker = join(aveDir, "sessions", ".search-repair.json");
    const writing = deferred<void>();
    const allowWrite = deferred<void>();
    const append = journal.appendJsonlRecords;
    const spy = vi.spyOn(journal, "appendJsonlRecords").mockImplementationOnce(async (...args) => {
      writing.resolve();
      await allowWrite.promise;
      return append(...args);
    });
    const repair = repository.verifyOrRebuildSearchIndex();
    const progress = repository.appendSessionProgress(sessionId, [old, next]);
    try {
      await writing.promise;
      firstProbe.resolve(current);
      await repair;
      expect.soft(existsSync(marker)).toBe(true);
      allowWrite.resolve();
      await expect(progress).resolves.toBe("appended");
      expect(await repository.searchSessionsWithCurrentPolicy("content from a delayed append")).toHaveLength(1);
    } finally {
      spy.mockRestore();
      firstProbe.resolve(current);
      allowWrite.resolve();
      await progress;
      repository.closeSearchIndex();
    }
  });

  it("keeps a live partial sidecar recoverable after a populated index was repaired", async () => {
    const aveDir = makeDir();
    const seeded = new WindowsSessionRepository({ aveDir });
    const row = { role: "user", content: "already indexed", meta: { messageId: "user-row" } };
    await seeded.saveSession(sessionId, [row]);
    seeded.closeSearchIndex();
    const repository = new WindowsSessionRepository({ aveDir, refreshSearchIndexPolicy: async () => current });
    const marker = join(aveDir, "sessions", ".search-repair.json");
    await repository.beginTurnJournal(sessionId, 1000);
    try {
      await repository.writeTurnPartial(sessionId, 1000, {
        messageId: "partial-row", content: "recoverable partial response", updatedAt: 1001,
      });
      expect(await repository.searchSessionsWithCurrentPolicy("recoverable partial response")).toEqual([]);
      expect.soft(existsSync(marker)).toBe(true);
    } finally {
      repository.endTurnJournal(sessionId);
      repository.closeSearchIndex();
    }
    const reopened = new WindowsSessionRepository({ aveDir });
    try {
      await reopened.verifyOrRebuildSearchIndex();
      expect(reopened.searchSessions("recoverable partial response")).toHaveLength(1);
      expect(existsSync(marker)).toBe(false);
    } finally {
      reopened.closeSearchIndex();
    }
  });

  it("rebuilds the indexed timestamp after a transcript touch", async () => {
    const aveDir = makeDir();
    const seeded = new WindowsSessionRepository({ aveDir });
    await seeded.saveSession(sessionId, [{ role: "user", content: "transcript with changed timestamp" }]);
    const [before] = seeded.searchSessions("changed timestamp");
    seeded.closeSearchIndex();
    const repository = new WindowsSessionRepository({ aveDir, refreshSearchIndexPolicy: async () => current });
    try {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(before.timestamp).getTime() + 5000);
      repository.touchSessionTranscript(sessionId, { bump: true });
      const [after] = await repository.searchSessionsWithCurrentPolicy("changed timestamp");
      expect(new Date(after.timestamp).getTime()).toBeGreaterThan(new Date(before.timestamp).getTime());
    } finally {
      vi.useRealTimers();
      repository.closeSearchIndex();
    }
  });
});
