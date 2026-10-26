import { describe, expect, it, vi } from "vitest";
import { SubAgentRunner } from "../subagent-runner.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryManager } from "../../memory/memory-manager.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";

// Transcript ownership requires a subagent session with this exact host-recorded origin.
function runnerWith(metadataById: Record<string, unknown>) {
  const subAgentMemoryManager = {
    loadSessionMetadata: vi.fn((id: string) => metadataById[id] ?? null),
  };
  return new SubAgentRunner({ subAgentMemoryManager } as never);
}

const PARENT = "11111111-1111-4111-8111-111111111111";
const OTHER_PARENT = "22222222-2222-4222-8222-222222222222";
const CHILD = "sub-11111111-33333333-3333-4333-8333-333333333333";

describe("SubAgentRunner persisted session existence", () => {
  it("uses the transcript rather than requiring display-row metadata", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ave-child-existence-"));
    try {
      const memory = new MemoryManager({ aveDir: directory });
      const runner = new SubAgentRunner({ subAgentMemoryManager: memory } as never);
      await memory.saveSession(CHILD, [{ role: "user", content: "Child task" }]);
      expect(runner.listPersistedSpawnsForOrigin(PARENT)).toEqual([]);
      expect(runner.hasPersistedSession(CHILD)).toBe(true);
      await memory.deleteSession(CHILD);
      expect(runner.hasPersistedSession(CHILD)).toBe(false);
      expect(runner.hasPersistedSession("../missing")).toBe(false);
    } finally {
      await cleanupTmpDir(directory);
    }
  });
});

describe("SubAgentRunner.isPersistedSpawnOfOrigin", () => {
  it("accepts a sub-agent whose originSessionId names this parent", () => {
    const runner = runnerWith({
      [CHILD]: { sessionKind: "subagent", originSessionId: PARENT },
    });
    expect(runner.isPersistedSpawnOfOrigin(PARENT, CHILD)).toBe(true);
  });

  it("rejects a sub-agent owned by a different parent", () => {
    const runner = runnerWith({
      [CHILD]: { sessionKind: "subagent", originSessionId: OTHER_PARENT },
    });
    expect(runner.isPersistedSpawnOfOrigin(PARENT, CHILD)).toBe(false);
  });

  it("rejects a session that is not a sub-agent even if origin matches", () => {
    // Main sessions must never be readable through child transcripts, regardless of claimed origin.
    const runner = runnerWith({
      [CHILD]: { sessionKind: "main", originSessionId: PARENT },
    });
    expect(runner.isPersistedSpawnOfOrigin(PARENT, CHILD)).toBe(false);
  });

  it("rejects a child with no recorded origin", () => {
    // Missing legacy origin metadata grants no ownership; use transcript scanning instead.
    const runner = runnerWith({ [CHILD]: { sessionKind: "subagent" } });
    expect(runner.isPersistedSpawnOfOrigin(PARENT, CHILD)).toBe(false);
  });

  it("rejects an unknown child", () => {
    expect(runnerWith({}).isPersistedSpawnOfOrigin(PARENT, CHILD)).toBe(false);
  });

  it("rejects malformed ids without touching storage", () => {
    const metadata = { [CHILD]: { sessionKind: "subagent", originSessionId: PARENT } };
    const subAgentMemoryManager = { loadSessionMetadata: vi.fn(() => metadata[CHILD]) };
    const runner = new SubAgentRunner({ subAgentMemoryManager } as never);

    expect(runner.isPersistedSpawnOfOrigin("../escape", CHILD)).toBe(false);
    expect(runner.isPersistedSpawnOfOrigin(PARENT, "../escape")).toBe(false);
    expect(runner.isPersistedSpawnOfOrigin("", "")).toBe(false);
    expect(subAgentMemoryManager.loadSessionMetadata).not.toHaveBeenCalled();
  });
});
