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
    const alpha = await memoryManager.saveMemory("Release plan", "alpha-only rollout", {
      projectRoot: "C:\\workspace\\alpha",
      projectName: "alpha",
      kind: "goal",
    }, "user");
    const beta = await memoryManager.saveMemory("Release plan", "beta-only rollout", {
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

  it("keeps candidates and expired records out of normal reads, global profile inputs, and prompts", async () => {
    await memoryManager.saveMemory("Global preference", "Use concise status updates.", {
      kind: "preference",
      pinned: true,
    }, "user");
    await memoryManager.saveMemory("Candidate only", "Do not leak candidate detail.", {
      state: "candidate",
      source: "assistant",
    }, "assistant");
    await memoryManager.saveMemory("Expired", "Old migration detail.", {
      expiresAt: "2000-01-01T00:00:00.000Z",
    }, "user");
    await memoryManager.saveMemory("Project only", "Internal beta detail.", {
      projectRoot: "C:\\workspace\\beta",
      projectName: "beta",
    }, "user");

    expect(memoryManager.listGlobalMemoryEntries().map((entry) => entry.title)).toEqual(["Global preference"]);
    expect(memoryManager.listMemoryEntries({ includeCandidates: true }).map((entry) => entry.title))
      .toContain("Candidate only");
    const selection = memoryManager.selectRelevantMemories("candidate detail", {
      projectRoot: "C:\\workspace\\alpha",
      tokenBudget: 180,
    });
    expect(selection.context).toContain("Global preference");
    expect(selection.context).not.toContain("Candidate only");
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
    expect(memoryManager.listMemoryEntries({ includeCandidates: true }).map((entry) => entry.title))
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

  it("reviews only global plus the selected project's candidates and promotes by id", async () => {
    const global = await memoryManager.saveMemory("Global proposal", "global candidate", {
      source: "assistant", state: "candidate",
    }, "assistant");
    const alpha = await memoryManager.saveMemory("Alpha proposal", "alpha candidate", {
      projectRoot: "C:\\workspace\\alpha", source: "assistant", state: "candidate",
    }, "assistant");
    const beta = await memoryManager.saveMemory("Beta proposal", "beta candidate", {
      projectRoot: "C:\\workspace\\beta", source: "assistant", state: "candidate",
    }, "assistant");

    expect(memoryManager.listMemoryCandidates().map((entry) => entry.id)).toEqual([global.id]);
    expect(memoryManager.listMemoryCandidates({ projectRoot: "C:\\workspace\\alpha" }).map((entry) => entry.id))
      .toEqual(expect.arrayContaining([global.id, alpha.id]));
    expect(memoryManager.listMemoryCandidates({ projectRoot: "C:\\workspace\\alpha" }).map((entry) => entry.id))
      .not.toContain(beta.id);
    await expect(memoryManager.activateMemoryCandidate(beta.id!, { projectRoot: "C:\\workspace\\alpha" }, "user"))
      .rejects.toThrow(/not found/);

    const activated = await memoryManager.activateMemoryCandidate(alpha.id!, { projectRoot: "C:\\workspace\\alpha" }, "user");
    expect(activated.state).toBe("active");
    expect(activated.confirmedAt).toEqual(expect.any(String));
    expect(memoryManager.listMemoryCandidates({ projectRoot: "C:\\workspace\\alpha" }).map((entry) => entry.id))
      .not.toContain(alpha.id);
    expect(memoryManager.selectRelevantMemories("alpha candidate", { projectRoot: "C:\\workspace\\alpha" }).context)
      .toContain("alpha candidate");
  });

  it("activates local assistant memories without overwriting user, import, or legacy candidate records", async () => {
    const imported = await memoryManager.saveMemory("Release decision", "Imported decision record.", {
      source: "import",
    }, "import");
    const user = await memoryManager.saveMemory("Release decision", "The user chose a staged rollout.", {
      kind: "constraint",
    }, "user");
    const legacyCandidate = await memoryManager.saveMemory("Release decision", "Old proposal only.", {
      source: "assistant", state: "candidate",
    }, "assistant");
    const automatic = await memoryManager.saveMemory("Release decision", "Watch the canary dashboard.", {
      source: "assistant", state: "active",
    }, "assistant");
    const updated = await memoryManager.saveMemory("Release decision", "Keep the canary dashboard open.", {
      source: "assistant", state: "active",
    }, "assistant");

    expect(automatic.filename).not.toBe(user.filename);
    expect(user.filename).not.toBe(imported.filename);
    expect(automatic.filename).not.toBe(imported.filename);
    expect(automatic.filename).not.toBe(legacyCandidate.filename);
    expect(updated.filename).toBe(automatic.filename);
    expect(updated).toMatchObject({ state: "active", source: "assistant", confirmedAt: expect.any(String) });
    expect(memoryManager.listMemoryCandidates().some((entry) => entry.id === legacyCandidate.id)).toBe(true);
    expect(readFileSync(join(dir, "memories", user.filename), "utf-8")).toContain("The user chose a staged rollout.");
    expect(readFileSync(join(dir, "memories", imported.filename), "utf-8")).toContain("Imported decision record.");
    expect(memoryManager.selectRelevantMemories("canary dashboard").context)
      .toContain("Keep the canary dashboard open.");
  });

  it("does not demote an active memory when an explicit candidate has the same title", async () => {
    const active = await memoryManager.saveMemory("Release preference", "active content", { kind: "preference" }, "user");
    const candidate = await memoryManager.saveMemory("Release preference", "candidate content", {
      source: "assistant", state: "candidate",
    }, "assistant");

    expect(candidate.filename).not.toBe(active.filename);
    expect(memoryManager.listMemoryEntries().find((entry) => entry.id === active.id)?.state).toBe("active");
    expect(memoryManager.listMemoryCandidates().find((entry) => entry.id === candidate.id)?.state).toBe("candidate");
    await expect(memoryManager.saveMemory("Release preference", "bypass", { state: "active" }, "user"))
      .resolves.toMatchObject({ id: active.id, state: "active" });
  });

  it("rejects cross-project deletion and preserves legacy notes above the V1 write ceiling", async () => {
    const alpha = await memoryManager.saveMemory("Alpha private", "alpha-only", { projectRoot: "C:\\workspace\\alpha" }, "user");
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

  it("round-trips LLM-refined automatic and explicit capture provenance without crossing lineages", async () => {
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

    const automatic = await memoryManager.saveMemory("Deployment preference", "Use staged rollout.", {
      source: "capture",
      capture: automaticCapture,
    }, "capture");
    const explicit = await memoryManager.saveMemory("Deployment preference", "The user explicitly chose staged rollout.", {
      source: "user",
      capture: explicitCapture,
    }, "user");
    const updatedAutomatic = await memoryManager.saveMemory("Deployment preference", "Keep the staged rollout preference.", {
      source: "capture",
      capture: {
        ...automaticCapture,
        sourceDigest: "C".repeat(64),
        capturedAt: "2026-08-02T00:02:00.000Z",
      },
    }, "capture");
    const candidate = await memoryManager.saveMemory("Candidate preference", "Use accessible language.", {
      source: "capture",
      state: "candidate",
      capture: automaticCapture,
    }, "capture");
    const activated = await memoryManager.activateMemoryCandidate(candidate.id!, {}, "user");
    const ordinary = await memoryManager.saveMemory("Ordinary user note", "Keep the original user wording.", {}, "user");

    expect(explicit.filename).not.toBe(automatic.filename);
    expect(updatedAutomatic.filename).toBe(automatic.filename);
    expect(activated.capture).toEqual({ ...automaticCapture, sourceDigest: automaticCapture.sourceDigest.toLowerCase() });

    const restored = memoryManager.listMemoryEntries({ includeCandidates: true });
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

    const valid = await memoryManager.saveMemory("Persisted provenance", "valid source pairing", {
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

    expect(memoryManager.listMemoryEntries({ includeCandidates: true }).some((entry) => entry.id === valid.id)).toBe(false);
  });
  it("persists where a memory was learned, keeps the first origin on re-save, and fails closed on a tampered origin", async () => {
    const origin = {
      v: 1 as const,
      sessionId: "0b6f3f43-3c5e-4f5f-9a51-2b0b6c1e9d10",
      messageId: "7d1c2a4e-9f0b-4c3d-8e6f-5a4b3c2d1e0f",
      store: "main" as const,
    };
    const saved = await memoryManager.saveMemory("Learned rule", "Use pnpm.", { kind: "fact", origin }, "user");
    expect(saved.origin).toEqual(origin);
    const resaved = await memoryManager.saveMemory("Learned rule", "Use pnpm 9.", {
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
    const direct = await memoryManager.saveMemory("Direct rule", "Saved from the memory UI.", { kind: "fact" }, "user");
    const resaved = await memoryManager.saveMemory("Direct rule", "Updated from a conversation.", {
      kind: "fact",
      origin: { v: 1, sessionId: "0b6f3f43-3c5e-4f5f-9a51-2b0b6c1e9d10" },
    }, "user");
    expect(resaved.id).toBe(direct.id);
    expect(resaved.origin).toBeUndefined();
    expect(memoryManager.listMemoryEntries().find((entry) => entry.id === direct.id)?.origin).toBeUndefined();
  });
});
