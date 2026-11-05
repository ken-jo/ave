import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryManager } from "../memory-manager.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";

let dir: string;
let manager: MemoryManager;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "ave-memory-catalog-")); manager = new MemoryManager({ aveDir: dir }); });
afterEach(async () => { manager.stopPersistentContextWatcher(); manager.closeSearchIndex(); await cleanupTmpDir(dir); });

describe("memory panel scope inventory", () => {
  it("counts scopes without returning memories from another project or treating legacy notes as global", async () => {
    await manager.saveMemory("Shared", "Every project", {}, "user");
    await manager.saveMemory("Alpha", "Current project", { projectRoot: "/workspace/alpha" }, "user");
    await manager.saveMemory("Default", "Default project", { projectRoot: "/workspace/default" }, "user");
    await manager.saveMemory("Other", "Other project", { projectRoot: "/workspace/other" }, "user");
    writeFileSync(join(dir, "memories", "legacy.md"), "# Legacy\n\nUnscoped note\n");
    const catalog = manager.readMemoryPanelCatalog({ projectRoot: "/workspace/alpha" }, "/workspace/default");
    expect(catalog.notes.map((note) => note.title).sort()).toEqual(["Alpha", "Shared"]);
    expect(catalog.scopeCounts).toEqual({ project: 1, global: 1, defaultProject: 2, defaultProjectApplicable: false });
    const defaultCatalog = manager.readMemoryPanelCatalog({ projectRoot: "/workspace/default", includeUnscoped: true }, "/workspace/default");
    expect(defaultCatalog.notes.map((note) => note.title).sort()).toEqual(["Default", "Legacy", "Shared"]);
    expect(defaultCatalog.scopeCounts).toEqual({ project: 2, global: 1, defaultProject: 2, defaultProjectApplicable: true });
  });
});
