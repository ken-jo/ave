import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { deferred } from "../../__tests__/support/deferred.js";
import { useTempDirs } from "../../__tests__/test-helpers.js";
import { SessionRepository } from "../session-repository.js";
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
    const repository = new SessionRepository({ aveDir });
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
      const interrupted = new SessionRepository({
        aveDir, getSearchIndexPolicy: current, refreshSearchIndexPolicy: () => waiting.promise,
      });
      const marker = join(aveDir, "sessions", ".search-repair.json");
      const recovered = new SessionRepository({ aveDir, getSearchIndexPolicy: current, refreshSearchIndexPolicy: async () => current });
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
    const repository = new SessionRepository({ aveDir, getSearchIndexPolicy: current, refreshSearchIndexPolicy: refresh });
    const marker = join(aveDir, "sessions", ".search-repair.json");
    const apply = vi.spyOn(SessionSearchIndex.prototype, "upsertSession").mockImplementationOnce(() => false);
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
