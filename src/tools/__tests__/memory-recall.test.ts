import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { MemoryManager } from "../../memory/memory-manager.js";
import { createMemoryRecallTools } from "../memory-recall.js";
import type { Tool, ToolExecutionContext } from "../base.js";

let aveDir: string;
let projectRoot: string;
let manager: MemoryManager;
let tools: Map<string, Tool>;

function ctx(cwd = projectRoot): ToolExecutionContext {
  return { cwd, extraAllowedDirectories: [], metadata: {} };
}

async function call(name: string, input: unknown, context = ctx()) {
  const result = await tools.get(name)!.execute(input, context);
  return { ...result, body: result.isError ? undefined : JSON.parse(result.output) };
}

beforeEach(() => {
  aveDir = mkdtempSync(join(tmpdir(), "ave-memory-recall-"));
  projectRoot = join(aveDir, "project");
  manager = new MemoryManager({ aveDir });
  manager.load();
  tools = new Map(createMemoryRecallTools({ memoryManager: manager }).map((tool) => [tool.name, tool]));
});

afterEach(async () => {
  manager.closeSearchIndex();
  await cleanupTmpDir(aveDir);
});

describe("memory recall tools", () => {
  it("expose read tools as read-only and delete as a write tool", () => {
    expect(tools.get("memory_search")).toMatchObject({ category: "read" });
    expect(tools.get("memory_read")).toMatchObject({ category: "read" });
    expect(tools.get("memory_delete")).toMatchObject({ category: "write" });
    expect(tools.get("memory_search")!.isReadOnly({})).toBe(true);
    expect(tools.get("memory_delete")!.isReadOnly({})).toBe(false);
  });

  it("finds active memories in the project and global scope, never another project's", async () => {
    await manager.saveMemory("Package manager", "Use bun for installs in this repo.", { projectRoot, state: "active" });
    await manager.saveMemory("Reply language", "Answer in Korean.", { state: "active" });
    await manager.saveMemory("Other project tool", "Use bun elsewhere.", { projectRoot: join(aveDir, "other"), state: "active" });

    const found = await call("memory_search", { query: "bun" });
    expect(found.isError).toBe(false);
    expect(found.body.memories.map((m: { title: string }) => m.title)).toEqual(["Package manager"]);
    expect(found.body.memories[0]).toMatchObject({ scope: "project", excerpt: "Use bun for installs in this repo." });

    const all = await call("memory_search", {});
    expect(all.body.memories.map((m: { title: string }) => m.title).sort()).toEqual(["Package manager", "Reply language"]);
  });

  it("lists pending candidates by title only and refuses to read them", async () => {
    const candidate = await manager.saveMemory("Draft fact", "Unreviewed candidate body.", {
      projectRoot,
      source: "assistant",
      state: "candidate",
    });
    const found = await call("memory_search", { query: "draft" });
    expect(found.body.memories).toEqual([]);
    expect(found.body.pendingCandidates).toEqual([{ id: candidate.id, title: "Draft fact", state: "candidate" }]);
    expect(JSON.stringify(found.body)).not.toContain("Unreviewed candidate body");

    const read = await call("memory_read", { id: candidate.id });
    expect(read.isError).toBe(true);
    expect(read.output).toContain("awaiting the user's review");
    expect(read.output).not.toContain("Unreviewed candidate body");
  });

  it("reads an active memory in full and scrubs credentials from legacy content", async () => {
    // Assembled at runtime so the fixture is not itself a credential-shaped literal.
    const fakeToken = ["ghp", "_", "x".repeat(36)].join("");
    const entry = await manager.saveMemory("Deploy note", `Deploy with token ${fakeToken} then verify.`, {
      projectRoot,
      state: "active",
    });
    const read = await call("memory_read", { id: entry.id });
    expect(read.isError, read.output).toBe(false);
    expect(read.body).toMatchObject({ id: entry.id, title: "Deploy note", scope: "project" });
    expect(read.body.content).toContain("then verify.");
    expect(read.output).not.toContain(fakeToken);
  });

  it("withdraws a pending candidate but refuses an active memory", async () => {
    const candidate = await manager.saveMemory("Duplicate", "Same as an existing fact.", {
      projectRoot,
      source: "assistant",
      state: "candidate",
    });
    const active = await manager.saveMemory("Confirmed", "User-confirmed fact.", { projectRoot, state: "active" });

    const refused = await call("memory_delete", { id: active.id });
    expect(refused.isError).toBe(true);
    expect(refused.output).toContain("cannot be deleted by the model");
    expect(manager.searchModelVisibleMemories("", { projectRoot }).map((m) => m.title)).toEqual(["Confirmed"]);

    const deleted = await call("memory_delete", { id: candidate.id });
    expect(deleted.body).toEqual({ deleted: true, id: candidate.id, state: "candidate" });
    expect(manager.listMemoryCandidates({ projectRoot })).toEqual([]);

    const again = await call("memory_delete", { id: candidate.id });
    expect(again.isError).toBe(true);
    expect(again.output).toContain("no pending candidate");
  });

  it("does not reach another project's candidate", async () => {
    const elsewhere = await manager.saveMemory("Foreign", "Other project candidate.", {
      projectRoot: join(aveDir, "other"),
      source: "assistant",
      state: "candidate",
    });
    const result = await call("memory_delete", { id: elsewhere.id });
    expect(result.isError).toBe(true);
    expect(manager.listMemoryCandidates({ projectRoot: join(aveDir, "other") })).toHaveLength(1);
  });

  it("requires an id for read and delete", async () => {
    for (const name of ["memory_read", "memory_delete"]) {
      const result = await call(name, {});
      expect(result.isError).toBe(true);
      expect(result.output).toContain("`id` is required");
    }
  });
});
