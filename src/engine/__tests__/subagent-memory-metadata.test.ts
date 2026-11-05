import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryManager } from "../../memory/memory-manager.js";
import { SubAgentRunner } from "../subagent-runner.js";
import { ToolRegistry } from "../../tools/registry.js";
import { makeSubagentLoopDeps } from "./support/subagent-loop-fixtures.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";

let dir: string;
let memory: MemoryManager;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "ave-child-title-")); memory = new MemoryManager({ aveDir: dir }); });
afterEach(async () => { memory.stopPersistentContextWatcher(); memory.closeSearchIndex(); await cleanupTmpDir(dir); });

describe("persisted child memory titles", () => {
  it("reads a child's title without reading or hydrating its transcript", async () => {
    const id = "74e2271f-1174-41dc-924d-6b5e1537a6cb";
    await memory.saveSessionMetadata(id, { sessionKind: "subagent", subAgentTitle: "Review payment timeout" });
    const load = vi.spyOn(memory, "loadSession").mockImplementation(() => { throw new Error("Transcript must remain unread"); });
    const hydrate = vi.spyOn(memory, "rehydrateToolResultArtifacts");
    const registry = new ToolRegistry();
    const runner = new SubAgentRunner({ parentDeps: makeSubagentLoopDeps(registry), toolRegistry: registry, subAgentMemoryManager: memory });
    expect(runner.getPersistedSessionMetadata(id)).toEqual({ title: "Review payment timeout" });
    expect(load).not.toHaveBeenCalled();
    expect(hydrate).not.toHaveBeenCalled();
    expect(runner.getPersistedSessionMetadata("../invalid")).toBeNull();
  });
});
