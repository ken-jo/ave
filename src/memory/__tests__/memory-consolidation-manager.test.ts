import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryManager } from "../memory-manager.js";
import { estimateTokens } from "../../shared/token-estimate.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";

let dir: string;
let memoryManager: MemoryManager;
const DEFAULT_WORKSPACE_ROOT = "C:\\workspace\\default";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ave-memory-consolidation-"));
  memoryManager = new MemoryManager({ aveDir: dir });
});

afterEach(async () => {
  memoryManager.stopPersistentContextWatcher();
  memoryManager.closeSearchIndex();
  await cleanupTmpDir(dir);
});

describe("MemoryManager long-term-memory consolidation", () => {
  it("keeps default-project memory out of the global overview and consolidates it as its own project", async () => {
    const { entry: defaultWorkspace } = await memoryManager.saveMemory(
      "Default workspace source",
      "Default raw source detail.",
      { projectRoot: DEFAULT_WORKSPACE_ROOT, projectName: "default", kind: "fact" }, "user",
    );
    await memoryManager.saveMemory("Global source", "Global raw source detail.", { kind: "fact" }, "user");
    // Legacy notes without an id or project marker stay global sources; this split does not move them.
    writeFileSync(join(dir, "memories", "legacy-note.md"), "# Legacy note\n\nLegacy unscoped detail.\n", "utf-8");

    const globalSnapshot = memoryManager.getConsolidationSnapshot();
    expect(globalSnapshot.scope).toEqual({ type: "global" });
    expect(globalSnapshot.sources.map((entry) => entry.title).sort()).toEqual(["Global source", "Legacy note"]);
    expect(globalSnapshot.sources.map((entry) => entry.content)).not.toContain(defaultWorkspace.content);

    const defaultSnapshot = memoryManager.getConsolidationSnapshot({
      projectRoot: DEFAULT_WORKSPACE_ROOT,
      projectName: "default",
    });
    expect(defaultSnapshot.scope).toMatchObject({ type: "project", projectRoot: DEFAULT_WORKSPACE_ROOT });
    expect(defaultSnapshot.sources.map((entry) => entry.title)).toEqual(["Default workspace source"]);

    await expect(memoryManager.upsertConsolidatedMemoryIfUnchanged(
      defaultSnapshot,
      "DEFAULT-PROJECT-OVERVIEW",
    )).resolves.toMatchObject({ status: "updated" });
    expect(memoryManager.getPromptLongTermMemoryOverview())
      .not.toContain("DEFAULT-PROJECT-OVERVIEW");
    expect(memoryManager.getPromptLongTermMemoryOverview({ projectRoot: DEFAULT_WORKSPACE_ROOT }))
      .toContain("DEFAULT-PROJECT-OVERVIEW");
  });

  it("uses a bounded exact scope, preserves source notes, and keeps a derived overview out of ordinary context", async () => {
    const { entry: global } = await memoryManager.saveMemory("Global source", "Global raw source detail.", {
      kind: "fact",
    }, "user");
    await memoryManager.saveMemory("Alpha source", "Alpha raw source detail.", {
      projectRoot: "C:\\workspace\\alpha",
      projectName: "alpha",
      kind: "fact",
    }, "user");
    await memoryManager.saveMemory("Beta source", "Beta raw source detail.", {
      projectRoot: "C:\\workspace\\beta",
      projectName: "beta",
      kind: "fact",
    }, "user");
    const globalSourceBefore = readFileSync(join(dir, "memories", global.filename), "utf-8");

    const globalSnapshot = memoryManager.getConsolidationSnapshot();
    const alphaSnapshot = memoryManager.getConsolidationSnapshot({
      projectRoot: "C:\\workspace\\alpha",
      projectName: "alpha",
    });
    expect(globalSnapshot.scope).toEqual({ type: "global" });
    expect(globalSnapshot.sources.map((entry) => entry.title)).toEqual(["Global source"]);
    expect(alphaSnapshot.scope).toMatchObject({ type: "project", projectRoot: "C:\\workspace\\alpha" });
    expect(alphaSnapshot.sources.map((entry) => entry.title)).toEqual(["Alpha source"]);

    const globalResult = await memoryManager.upsertConsolidatedMemoryIfUnchanged(
      globalSnapshot,
      "Consolidated global-only marker.",
    );
    const alphaResult = await memoryManager.upsertConsolidatedMemoryIfUnchanged(
      alphaSnapshot,
      "Consolidated alpha-only marker.",
    );
    expect(globalResult).toMatchObject({
      status: "updated",
      entry: {
        kind: "reference",
        source: "assistant",
        derivation: { type: "consolidated-overview", sourceFingerprint: globalSnapshot.sourceFingerprint },
      },
    });
    expect(alphaResult).toMatchObject({ status: "updated" });
    expect(readFileSync(join(dir, "memories", global.filename), "utf-8")).toBe(globalSourceBefore);

    expect(memoryManager.selectRelevantMemories("Consolidated global-only marker.").context)
      .not.toContain("Consolidated global-only marker.");
    expect(memoryManager.getMemoryContext()).not.toContain("Consolidated global-only marker.");
    expect(memoryManager.getPromptLongTermMemoryOverview())
      .toContain("Consolidated global-only marker.");
    const alphaOverview = memoryManager.getPromptLongTermMemoryOverview({ projectRoot: "c:/workspace/alpha/" });
    expect(alphaOverview).toContain("Consolidated global-only marker.");
    expect(alphaOverview).toContain("Consolidated alpha-only marker.");
    expect(alphaOverview).not.toContain("Beta raw source detail.");
  });

  it("suppresses stale overviews and does not let ordinary saves overwrite a derived overview", async () => {
    await memoryManager.saveMemory("Source", "Initial source detail.", { kind: "fact" }, "user");
    const snapshot = memoryManager.getConsolidationSnapshot();
    const result = await memoryManager.upsertConsolidatedMemoryIfUnchanged(
      snapshot,
      "Old derived overview marker.",
    );
    expect(result.status).toBe("updated");
    if (result.status !== "updated") throw new Error("expected derived overview");
    const derivedBefore = readFileSync(join(dir, "memories", result.entry.filename), "utf-8");

    const { entry: manual } = await memoryManager.saveMemory(
      "Long-term Memory Overview",
      "A normal user memory must not overwrite the derived overview.", {}, "user",
    );
    expect(manual.filename).not.toBe(result.entry.filename);
    expect(readFileSync(join(dir, "memories", result.entry.filename), "utf-8")).toBe(derivedBefore);

    const staleSnapshot = memoryManager.getConsolidationSnapshot();
    await memoryManager.upsertConsolidatedMemoryIfUnchanged(staleSnapshot, "Current overview marker.");
    await memoryManager.saveMemory("Changed source", "This makes the overview stale.", { kind: "fact" }, "user");

    expect(memoryManager.getConsolidatedMemoryOverview(staleSnapshot)).toBeUndefined();
    expect(memoryManager.getPromptLongTermMemoryOverview()).not.toContain("Current overview marker.");
    await expect(memoryManager.upsertConsolidatedMemoryIfUnchanged(staleSnapshot, "Must not be written."))
      .resolves.toEqual({ status: "sources-changed" });
  });

  it("reserves prompt space for both global and exact-project long-term overviews", async () => {
    await memoryManager.saveMemory("Global source", "global source", { kind: "fact" }, "user");
    await memoryManager.saveMemory("Project source", "project source", {
      projectRoot: "C:\\workspace\\alpha",
      projectName: "alpha",
      kind: "fact",
    }, "user");
    const globalSnapshot = memoryManager.getConsolidationSnapshot();
    const projectSnapshot = memoryManager.getConsolidationSnapshot({
      projectRoot: "C:\\workspace\\alpha",
      projectName: "alpha",
    });
    await memoryManager.upsertConsolidatedMemoryIfUnchanged(
      globalSnapshot,
      `GLOBAL-OVERVIEW-MARKER\n${"global detail ".repeat(500)}`,
    );
    await memoryManager.upsertConsolidatedMemoryIfUnchanged(
      projectSnapshot,
      `PROJECT-OVERVIEW-MARKER\n${"project detail ".repeat(450)}`,
    );

    const overview = memoryManager.getPromptLongTermMemoryOverview({ projectRoot: "C:\\workspace\\alpha" });
    expect(overview).toContain("GLOBAL-OVERVIEW-MARKER");
    expect(overview).toContain("PROJECT-OVERVIEW-MARKER");
    expect(estimateTokens(overview)).toBeLessThanOrEqual(400);
  });

  it("rejects a snapshot whose fingerprint is not the lowercase digest this manager mints", async () => {
    await memoryManager.saveMemory("Source", "Source detail.", { kind: "fact" }, "user");
    const snapshot = memoryManager.getConsolidationSnapshot();
    expect(snapshot.sourceFingerprint).toMatch(/^[0-9a-f]{64}$/);
    const uppercase = { ...snapshot, sourceFingerprint: snapshot.sourceFingerprint.toUpperCase() };

    expect(memoryManager.getConsolidatedMemoryOverview(uppercase)).toBeUndefined();
    await expect(memoryManager.upsertConsolidatedMemoryIfUnchanged(uppercase, "OVERVIEW"))
      .rejects.toThrow(/invalid snapshot/);
  });
});
