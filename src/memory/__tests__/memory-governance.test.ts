import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryManager } from "../memory-manager.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";

let dir: string;
let memoryManager: MemoryManager;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ave-memory-governance-"));
  memoryManager = new MemoryManager({ aveDir: dir });
});

afterEach(async () => {
  memoryManager.stopPersistentContextWatcher();
  memoryManager.closeSearchIndex();
  await cleanupTmpDir(dir);
});

describe("MemoryManager — scoped long-term memory governance", () => {
  it("keeps same-titled project memories in separate files and projects", async () => {
    const { entry: alpha } = await memoryManager.saveMemory("Release plan", "alpha-only rollout", {
      projectRoot: "C:\\workspace\\alpha",
      projectName: "alpha",
      kind: "goal",
    }, "user");
    const { entry: beta } = await memoryManager.saveMemory("Release plan", "beta-only rollout", {
      projectRoot: "C:\\workspace\\beta",
      projectName: "beta",
      kind: "goal",
    }, "user");

    expect(alpha.filename).not.toBe(beta.filename);
    expect(existsSync(join(dir, "memories", alpha.filename))).toBe(true);
    expect(existsSync(join(dir, "memories", beta.filename))).toBe(true);
    expect(readFileSync(join(dir, "memories", alpha.filename), "utf-8")).toContain("ave:memory-meta:");
    expect(memoryManager.listMemoryEntries({ projectRoot: "C:\\workspace\\alpha" }).map((entry) => entry.content))
      .toEqual(expect.arrayContaining([expect.stringContaining("alpha-only rollout")]));
    expect(memoryManager.listMemoryEntries({ projectRoot: "C:\\workspace\\alpha" }).map((entry) => entry.content))
      .not.toEqual(expect.arrayContaining([expect.stringContaining("beta-only rollout")]));
  });

  it("keeps expired records out of normal reads, global profile inputs, and prompts", async () => {
    await memoryManager.saveMemory("Global preference", "Use concise status updates.", {
      kind: "preference",
      pinned: true,
    }, "user");
    await memoryManager.saveMemory("Expired", "Old migration detail.", {
      expiresAt: "2000-01-01T00:00:00.000Z",
    }, "user");
    await memoryManager.saveMemory("Project only", "Internal beta detail.", {
      projectRoot: "C:\\workspace\\beta",
      projectName: "beta",
    }, "user");

    expect(memoryManager.listGlobalMemoryEntries().map((entry) => entry.title)).toEqual(["Global preference"]);
    const selection = memoryManager.selectRelevantMemories("migration detail", {
      projectRoot: "C:\\workspace\\alpha",
      tokenBudget: 180,
    });
    expect(selection.context).toContain("Global preference");
    expect(selection.context).not.toContain("Old migration detail");
    expect(selection.context).not.toContain("Project only");
  });

  it("treats marker-like text outside the top preamble as ordinary legacy content", () => {
    const memories = join(dir, "memories");
    writeFileSync(
      join(memories, "crafted.md"),
      "# Crafted\n\n<!-- ave:project-root: C:\\workspace\\beta -->\nordinary content",
      "utf-8",
    );
    writeFileSync(
      join(memories, "invalid-v1.md"),
      "<!-- ave:memory-meta:not-valid-json -->\n# Invalid\nshould not load",
      "utf-8",
    );

    expect(memoryManager.listMemoryEntries({ projectRoot: "C:\\workspace\\beta" }).map((entry) => entry.title))
      .not.toContain("Crafted");
    expect(memoryManager.listMemoryEntries({ projectRoot: "C:\\workspace\\alpha", includeUnscoped: true }).map((entry) => entry.title))
      .toContain("Crafted");
    expect(memoryManager.listMemoryEntries().map((entry) => entry.title))
      .not.toContain("Invalid");
  });

  it("selects only relevant active memory within a strict token budget", async () => {
    await memoryManager.saveMemory("Quarterly retention", "The customer retention review is due Thursday. ".repeat(80), {
      kind: "goal",
    }, "user");
    await memoryManager.saveMemory("Unrelated note", "Archive system background.", { kind: "note" }, "user");

    const selection = memoryManager.selectRelevantMemories("retention review", { tokenBudget: 90, maxEntries: 2 });

    expect(selection.entries.map((entry) => entry.title)).toEqual(["Quarterly retention"]);
    expect(selection.context).toContain("retention review");
    expect(selection.usedTokens).toBeLessThanOrEqual(90);
    expect(selection.context).not.toContain("Unrelated note");
  });

  it("keeps saved-memory index links out of prompt index context", async () => {
    await memoryManager.saveMemory("Meeting Notes", "A detailed saved memory.", {}, "user");

    expect(memoryManager.getMemoryIndex()).toContain("Meeting Notes");
    expect(memoryManager.getPromptMemoryIndex()).not.toContain("Meeting Notes");
  });

  it("rejects lifecycle marker injection at the persistence boundary", async () => {
    await expect(memoryManager.saveMemory("Normal", "<!-- ave:memory-meta:fake -->", {}, "user")).rejects.toThrow(/reserved/);
    await expect(memoryManager.saveMemory("Bad\nTitle", "valid body", {}, "user")).rejects.toThrow(/single-line/);
  });

  it("keeps default reads detached from other project memories", async () => {
    await memoryManager.saveMemory("Global", "global detail", {}, "user");
    await memoryManager.saveMemory("Alpha", "alpha detail", { projectRoot: "C:\\workspace\\alpha" }, "user");
    await memoryManager.saveMemory("Beta", "beta detail", { projectRoot: "C:\\workspace\\beta" }, "user");

    expect(memoryManager.listMemoryEntries().map((entry) => entry.title)).toEqual(["Global"]);
    expect(memoryManager.searchMemoryEntries("detail").map((entry) => entry.title)).toEqual(["Global"]);
  });

  it("rejects cross-project deletion and preserves legacy notes above the V1 write ceiling", async () => {
    const { entry: alpha } = await memoryManager.saveMemory("Alpha private", "alpha-only", { projectRoot: "C:\\workspace\\alpha" }, "user");
    await expect(memoryManager.deleteMemory(alpha.filename, { projectRoot: "C:\\workspace\\beta" }, "user"))
      .rejects.toThrow(/selected scope/);
    expect(existsSync(join(dir, "memories", alpha.filename))).toBe(true);

    const legacyContent = `# Long legacy\n\n${"legacy ".repeat(12_000)}`;
    writeFileSync(join(dir, "memories", "long-legacy.md"), legacyContent, "utf-8");
    expect(memoryManager.listMemoryEntries().find((entry) => entry.filename === "long-legacy.md")?.content)
      .toContain("legacy legacy");
  });

  it("caps the user-preference prompt view without truncating the editable profile", async () => {
    const profile = `# User Preferences\n\n${"concise ".repeat(3_000)}`;
    await memoryManager.updateUserPreferences(profile);

    expect(memoryManager.getUserPreferences()).toBe(profile);
    expect(memoryManager.getPromptUserPreferences().length).toBeLessThan(profile.length);
  });

  it("round-trips LLM-refined automatic and explicit capture provenance, which follows the latest save", async () => {
    const automaticCapture = {
      v: 1 as const,
      method: "llm-refined" as const,
      trigger: "automatic" as const,
      sourceDigest: "A".repeat(64),
      capturedAt: "2026-08-02T00:00:00.000Z",
    };
    const explicitCapture = {
      v: 1 as const,
      method: "llm-refined" as const,
      trigger: "explicit" as const,
      sourceDigest: "B".repeat(64),
      capturedAt: "2026-08-02T00:01:00.000Z",
    };

    const { entry: automatic } = await memoryManager.saveMemory("Deployment preference", "Use staged rollout.", {
      source: "capture",
      capture: automaticCapture,
    }, "capture");
    const { entry: explicit } = await memoryManager.saveMemory("Deployment choice", "The user explicitly chose staged rollout.", {
      source: "user",
      capture: explicitCapture,
    }, "user");
    const { entry: updatedAutomatic } = await memoryManager.saveMemory("Deployment preference", "Keep the staged rollout preference.", {
      source: "capture",
      capture: {
        ...automaticCapture,
        sourceDigest: "C".repeat(64),
        capturedAt: "2026-08-02T00:02:00.000Z",
      },
    }, "capture");
    const { entry: ordinary } = await memoryManager.saveMemory("Ordinary user note", "Keep the original user wording.", {}, "user");

    expect(updatedAutomatic.filename).toBe(automatic.filename);
    const restored = memoryManager.listMemoryEntries();
    expect(restored.find((entry) => entry.id === automatic.id)?.capture).toEqual({
      ...automaticCapture,
      sourceDigest: "c".repeat(64),
      capturedAt: "2026-08-02T00:02:00.000Z",
    });
    expect(restored.find((entry) => entry.id === explicit.id)?.capture).toEqual({
      ...explicitCapture,
      sourceDigest: explicitCapture.sourceDigest.toLowerCase(),
    });
    expect(restored.find((entry) => entry.id === ordinary.id)?.capture).toBeUndefined();

    // An assistant rewrite of the captured memory carries no capture claim of its own.
    const { entry: rewritten } = await memoryManager.saveMemory("Deployment preference", "Roll out to 5% first.", { source: "assistant" }, "assistant");
    expect(rewritten.id).toBe(automatic.id);
    expect(memoryManager.listMemoryEntries().find((entry) => entry.id === automatic.id)).toMatchObject({ source: "assistant" });
    expect(memoryManager.listMemoryEntries().find((entry) => entry.id === automatic.id)?.capture).toBeUndefined();
  });

  it("applies one save rule: a same-title save in one scope updates that memory whatever wrote it before", async () => {
    const { op: firstOp, entry: imported } = await memoryManager.saveMemory("Release decision", "Imported decision record.", { source: "import" }, "import");
    const { op: userOp, entry: user } = await memoryManager.saveMemory("Release decision", "The user chose a staged rollout.", { kind: "constraint" }, "user");
    const { op: assistantOp, entry: assistant } = await memoryManager.saveMemory("Release decision", "Watch the canary dashboard.", { source: "assistant" }, "assistant");
    const { entry: project } = await memoryManager.saveMemory("Release decision", "Alpha keeps its own.", { projectRoot: "C:\\workspace\\alpha" }, "user");

    expect([firstOp, userOp, assistantOp]).toEqual(["created", "updated", "updated"]);
    expect(user.id).toBe(imported.id);
    expect(assistant.id).toBe(imported.id);
    expect(assistant.filename).toBe(imported.filename);
    expect(project.id).not.toBe(imported.id);
    expect(memoryManager.listMemoryEntries().filter((entry) => entry.title === "Release decision")).toHaveLength(1);
    expect(readFileSync(join(dir, "memories", imported.filename), "utf-8")).toContain("Watch the canary dashboard.");
    expect(memoryManager.listMemoryEntries().find((entry) => entry.id === imported.id)).toMatchObject({ source: "assistant", state: "active" });
  });

  it("updates only the newest of two same-title files and leaves the other untouched", async () => {
    const { utimesSync } = await import("node:fs");
    const { entry: first } = await memoryManager.saveMemory("Release decision", "Old copy.", {}, "user");
    // A second file with the same title and scope, as a copy from another device or an older build would leave.
    const stored = readFileSync(join(dir, "memories", first.filename), "utf-8");
    const header = /<!-- ave:memory-meta:([A-Za-z0-9_-]+) -->/.exec(stored)!;
    const metadata = JSON.parse(Buffer.from(header[1], "base64url").toString("utf-8")) as Record<string, unknown>;
    const secondId = "9e8d7c6b-5a49-4382-9716-0f1e2d3c4b5a";
    metadata.id = secondId;
    writeFileSync(join(dir, "memories", "release-decision-copy.md"),
      stored.replace(header[1], Buffer.from(JSON.stringify(metadata), "utf-8").toString("base64url")).replace("Old copy.", "Newer copy."), "utf-8");
    utimesSync(join(dir, "memories", first.filename), new Date(2000, 0, 1), new Date(2000, 0, 1));
    const olderBefore = readFileSync(join(dir, "memories", first.filename), "utf-8");

    const { op, entry } = await memoryManager.saveMemory("Release decision", "Final.", {}, "assistant");

    expect(op).toBe("updated");
    expect(entry.id).toBe(secondId);
    expect(readFileSync(join(dir, "memories", "release-decision-copy.md"), "utf-8")).toContain("Final.");
    // The older copy is never deleted by a save: the user cleans it up from the panel.
    expect(readFileSync(join(dir, "memories", first.filename), "utf-8")).toBe(olderBefore);
    expect(memoryManager.listMemoryEntries().filter((note) => note.title === "Release decision").map((note) => note.id).sort())
      .toEqual([first.id, secondId].sort());
    expect((await memoryManager.getMemoryHistory(secondId, {})).entries.at(-1)?.op).toBe("updated");
    const raw = readFileSync(join(dir, "memories", "history.jsonl"), "utf-8").trim().split("\n").map((line) => JSON.parse(line) as { memoryId: string; op: string });
    expect(raw.filter((row) => row.memoryId === first.id).map((row) => row.op)).toEqual(["created"]);
  });

  it("edits an older same-title copy that keeps its title, leaving the newer copy untouched", async () => {
    const { utimesSync } = await import("node:fs");
    const { entry: older } = await memoryManager.saveMemory("Release decision", "Old copy.", {}, "user");
    // A newer file with the same title and scope, as a copy from another device or an older build would leave.
    const stored = readFileSync(join(dir, "memories", older.filename), "utf-8");
    const header = /<!-- ave:memory-meta:([A-Za-z0-9_-]+) -->/.exec(stored)!;
    const metadata = JSON.parse(Buffer.from(header[1], "base64url").toString("utf-8")) as Record<string, unknown>;
    metadata.id = "9e8d7c6b-5a49-4382-9716-0f1e2d3c4b5a";
    const copy = join(dir, "memories", "release-decision-copy.md");
    writeFileSync(copy,
      stored.replace(header[1], Buffer.from(JSON.stringify(metadata), "utf-8").toString("base64url")).replace("Old copy.", "Newer copy."), "utf-8");
    utimesSync(join(dir, "memories", older.filename), new Date(2000, 0, 1), new Date(2000, 0, 1));
    const copyBefore = readFileSync(copy, "utf-8");

    const { op, entry } = await memoryManager.updateMemoryById(older.id!, "Release decision", "Edited old copy.", { source: "user" }, "user");

    expect(op).toBe("updated");
    expect(entry).toMatchObject({ id: older.id, filename: older.filename, title: "Release decision" });
    expect(readFileSync(join(dir, "memories", older.filename), "utf-8")).toContain("Edited old copy.");
    expect(readFileSync(copy, "utf-8")).toBe(copyBefore);
    // Moving the older copy to a scope where the title is taken still conflicts.
    const { entry: project } = await memoryManager.saveMemory("Release decision", "Project copy.", { projectRoot: "C:\\workspace\\alpha" }, "user");
    await expect(memoryManager.updateMemoryById(project.id!, "Release decision", "Moved.", {
      projectRoot: "C:\\workspace\\alpha", source: "user", scope: "global",
    }, "user")).rejects.toThrow(/title-conflict/);
  });

  it("refuses zero-width and bidi characters with the stable unsafe-text reason", async () => {
    for (const ch of ["\u200B", "\u200F", "\u202A", "\u202E", "\u2066", "\u2069", "\uFEFF"]) {
      await expect(memoryManager.saveMemory(`Ti${ch}tle`, "body", {}, "user")).rejects.toThrow(/unsafe-text/);
      await expect(memoryManager.saveMemory("Title", `body${ch}text`, {}, "user")).rejects.toThrow(/unsafe-text/);
    }
    await expect(memoryManager.saveMemory("Normal", "<!-- ave:memory-meta:fake -->", {}, "user")).rejects.toThrow(/unsafe-text/);
    await expect(memoryManager.saveMemory("Bad\u0007Title", "body", {}, "user")).rejects.toThrow(/unsafe-text/);
    expect(memoryManager.listMemoryEntries()).toEqual([]);
  });

  it("no longer reads a stored candidate: every memory has one active lifecycle", async () => {
    const { entry } = await memoryManager.saveMemory("Proposal", "proposal body", {}, "user");
    const filePath = join(dir, "memories", entry.filename);
    const stored = readFileSync(filePath, "utf-8");
    const header = /<!-- ave:memory-meta:([A-Za-z0-9_-]+) -->/.exec(stored)!;
    const metadata = JSON.parse(Buffer.from(header[1], "base64url").toString("utf-8")) as Record<string, unknown>;
    metadata.state = "candidate";
    writeFileSync(filePath, stored.replace(header[1], Buffer.from(JSON.stringify(metadata), "utf-8").toString("base64url")), "utf-8");

    expect(memoryManager.listMemoryEntries().some((note) => note.id === entry.id)).toBe(false);
  });

  it("updates a memory by id, title included, within the caller's scope", async () => {
    const { entry: alpha } = await memoryManager.saveMemory("Build tool", "Use npm.", { projectRoot: "C:\\workspace\\alpha" }, "user");
    await memoryManager.saveMemory("Taken title", "other", { projectRoot: "C:\\workspace\\alpha" }, "user");

    const { op, entry } = await memoryManager.updateMemoryById(alpha.id!, "Package manager", "Use pnpm.", {
      projectRoot: "C:\\workspace\\alpha", source: "assistant",
    }, "assistant");
    expect(op).toBe("updated");
    expect(entry).toMatchObject({ id: alpha.id, filename: alpha.filename, title: "Package manager", source: "assistant" });
    expect(memoryManager.listMemoryEntries({ projectRoot: "C:\\workspace\\alpha" }).map((note) => note.title).sort())
      .toEqual(["Package manager", "Taken title"]);
    // The model finds memories with memory_search, so a rename must reach the search index.
    expect(memoryManager.searchModelVisibleMemories("Package manager", { projectRoot: "C:\\workspace\\alpha" }).map((note) => note.id))
      .toContain(alpha.id);
    expect(memoryManager.searchModelVisibleMemories("Build tool", { projectRoot: "C:\\workspace\\alpha" }).map((note) => note.id))
      .not.toContain(alpha.id);

    await expect(memoryManager.updateMemoryById(alpha.id!, "x", "y", { projectRoot: "C:\\workspace\\beta", source: "assistant" }, "assistant"))
      .rejects.toThrow(/memory not found/);
    await expect(memoryManager.updateMemoryById(alpha.id!, "Taken title", "y", { projectRoot: "C:\\workspace\\alpha", source: "assistant" }, "assistant"))
      .rejects.toThrow(/title-conflict/);
    await expect(memoryManager.updateMemoryById(alpha.id!, "Package manager", "Use \u200Bpnpm.", { projectRoot: "C:\\workspace\\alpha", source: "assistant" }, "assistant"))
      .rejects.toThrow(/unsafe-text/);

    const { entry: moved } = await memoryManager.updateMemoryById(alpha.id!, "Package manager", "Use pnpm everywhere.", {
      projectRoot: "C:\\workspace\\alpha", source: "assistant", scope: "global",
    }, "assistant");
    expect(moved.projectRoot).toBeUndefined();
    expect(memoryManager.listMemoryEntries().map((note) => note.id)).toContain(alpha.id);
    const history = await memoryManager.getMemoryHistory(alpha.id!, {});
    expect(history.entries.map((row) => row.op)).toEqual(["created", "updated", "updated"]);
  });

  it("deletes a memory by id only within the caller's scope", async () => {
    const { entry: alpha } = await memoryManager.saveMemory("Alpha note", "alpha", { projectRoot: "C:\\workspace\\alpha" }, "user");
    await expect(memoryManager.deleteMemoryById(alpha.id!, { projectRoot: "C:\\workspace\\beta" }, "assistant"))
      .rejects.toThrow(/memory not found/);
    expect(existsSync(join(dir, "memories", alpha.filename))).toBe(true);

    const deleted = await memoryManager.deleteMemoryById(alpha.id!, { projectRoot: "C:\\workspace\\alpha" }, "assistant");
    expect(deleted.entry).toMatchObject({ id: alpha.id, title: "Alpha note" });
    // The removed bytes come back so an undo can restore them.
    expect(deleted.priorContent).toContain("alpha");
    expect(existsSync(join(dir, "memories", alpha.filename))).toBe(false);
  });

  it("enforces capture source/trigger pairing and fails closed for invalid persisted provenance", async () => {
    const automaticCapture = {
      v: 1 as const,
      method: "llm-refined" as const,
      trigger: "automatic" as const,
      sourceDigest: "d".repeat(64),
      capturedAt: "2026-08-02T00:00:00.000Z",
    };
    const explicitCapture = {
      ...automaticCapture,
      trigger: "explicit" as const,
    };

    await expect(memoryManager.saveMemory("Missing provenance", "content", { source: "capture" }, "capture"))
      .rejects.toThrow(/capture provenance/);
    await expect(memoryManager.saveMemory("Wrong automatic source", "content", {
      source: "user",
      capture: automaticCapture,
    }, "user")).rejects.toThrow(/does not match/);
    await expect(memoryManager.saveMemory("Wrong explicit source", "content", {
      source: "capture",
      capture: explicitCapture,
    }, "capture")).rejects.toThrow(/does not match/);
    await expect(memoryManager.saveMemory("Assistant cannot claim explicit capture", "content", {
      source: "assistant",
      capture: explicitCapture,
    }, "assistant")).rejects.toThrow(/does not match/);

    await expect(memoryManager.saveMemory("Invalid trigger", "content", {
      source: "capture",
      capture: { ...automaticCapture, trigger: "other" as never },
    }, "capture")).rejects.toThrow(/invalid capture provenance/);

    const { entry: valid } = await memoryManager.saveMemory("Persisted provenance", "valid source pairing", {
      source: "capture",
      capture: automaticCapture,
    }, "capture");
    const filePath = join(dir, "memories", valid.filename);
    const stored = readFileSync(filePath, "utf-8");
    const header = /<!-- ave:memory-meta:([A-Za-z0-9_-]+) -->/.exec(stored);
    expect(header).not.toBeNull();
    const metadata = JSON.parse(Buffer.from(header![1], "base64url").toString("utf-8")) as Record<string, unknown>;
    metadata.source = "user"; // automatic capture must never masquerade as a direct user record.
    const invalidHeader = Buffer.from(JSON.stringify(metadata), "utf-8").toString("base64url");
    writeFileSync(filePath, stored.replace(header![1], invalidHeader), "utf-8");

    expect(memoryManager.listMemoryEntries().some((entry) => entry.id === valid.id)).toBe(false);
  });
  it("persists where a memory was learned, keeps the first origin on re-save, and fails closed on a tampered origin", async () => {
    const origin = {
      v: 1 as const,
      sessionId: "0b6f3f43-3c5e-4f5f-9a51-2b0b6c1e9d10",
      messageId: "7d1c2a4e-9f0b-4c3d-8e6f-5a4b3c2d1e0f",
      store: "main" as const,
    };
    const { entry: saved } = await memoryManager.saveMemory("Learned rule", "Use pnpm.", { kind: "fact", origin }, "user");
    expect(saved.origin).toEqual(origin);
    const { entry: resaved } = await memoryManager.saveMemory("Learned rule", "Use pnpm 9.", {
      kind: "fact",
      origin: { v: 1, sessionId: "9e8d7c6b-5a49-4382-9716-0f1e2d3c4b5a" },
    }, "user");
    expect(resaved.origin).toEqual(origin);
    expect(memoryManager.listMemoryEntries().find((entry) => entry.id === saved.id)?.origin).toEqual(origin);

    await expect(memoryManager.saveMemory("Bad origin", "x", { origin: { v: 1, sessionId: "../escape" } as never }, "user"))
      .rejects.toThrow(/invalid origin/);
    await expect(memoryManager.saveMemory("Bad store", "x", { origin: { ...origin, store: "elsewhere" } as never }, "user"))
      .rejects.toThrow(/invalid origin/);

    const filePath = join(dir, "memories", saved.filename);
    const stored = readFileSync(filePath, "utf-8");
    const header = /<!-- ave:memory-meta:([A-Za-z0-9_-]+) -->/.exec(stored)!;
    const metadata = JSON.parse(Buffer.from(header[1], "base64url").toString("utf-8")) as Record<string, unknown>;
    metadata.origin = { v: 1, sessionId: origin.sessionId, messageId: 42 };
    writeFileSync(filePath, stored.replace(header[1], Buffer.from(JSON.stringify(metadata), "utf-8").toString("base64url")), "utf-8");
    expect(memoryManager.listMemoryEntries().some((entry) => entry.id === saved.id)).toBe(false);
  });

  it("never gives an origin to a memory first saved without one", async () => {
    const { entry: direct } = await memoryManager.saveMemory("Direct rule", "Saved from the memory UI.", { kind: "fact" }, "user");
    const { entry: resaved } = await memoryManager.saveMemory("Direct rule", "Updated from a conversation.", {
      kind: "fact",
      origin: { v: 1, sessionId: "0b6f3f43-3c5e-4f5f-9a51-2b0b6c1e9d10" },
    }, "user");
    expect(resaved.id).toBe(direct.id);
    expect(resaved.origin).toBeUndefined();
    expect(memoryManager.listMemoryEntries().find((entry) => entry.id === direct.id)?.origin).toBeUndefined();
  });
});
