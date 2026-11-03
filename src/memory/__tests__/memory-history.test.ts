import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryManager } from "../memory-manager.js";
import { MemoryHistory, MAX_HISTORY_TEXT_CHARS } from "../memory-history.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";

let dir: string;
let memoryManager: MemoryManager;
const ALPHA = "C:\\workspace\\alpha";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ave-memory-history-"));
  memoryManager = new MemoryManager({ aveDir: dir });
});

afterEach(async () => {
  memoryManager.stopPersistentContextWatcher();
  memoryManager.closeSearchIndex();
  await cleanupTmpDir(dir);
});

function historyRows(): Array<Record<string, unknown>> {
  return readFileSync(join(dir, "memories", "history.jsonl"), "utf-8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("MemoryManager change history", () => {
  it("appends one row per change, in order, with the acting party", async () => {
    const created = await memoryManager.saveMemory("Review style", "Prefer small diffs.", {
      projectRoot: ALPHA, projectName: "alpha", kind: "preference",
    });
    await memoryManager.saveMemory("Review style", "Prefer small, reviewed diffs.", {
      projectRoot: ALPHA, projectName: "alpha", kind: "preference",
    });
    await memoryManager.setMemoryActive(created.id!, false, { projectRoot: ALPHA }, "user");
    await memoryManager.setMemoryActive(created.id!, true, { projectRoot: ALPHA }, "user");
    await memoryManager.promoteToGlobal(created.id!, { projectRoot: ALPHA }, "user");

    const history = await memoryManager.getMemoryHistory(created.id!, { projectRoot: ALPHA });
    expect(history.historyIncomplete).toBeUndefined();
    expect(history.truncatedBefore).toBeUndefined();
    expect(history.entries.map((row) => [row.op, row.actor])).toEqual([
      ["created", "user"],
      ["updated", "user"],
      ["disabled", "user"],
      ["enabled", "user"],
      ["promoted", "user"],
    ]);
    expect(history.entries[0]).toMatchObject({ fields: { title: "Review style", scope: "project" } });
    expect(history.entries[0]!.fields!.contentDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(history.entries[1]).toMatchObject({
      before: expect.stringContaining("Prefer small diffs."),
      after: expect.stringContaining("Prefer small, reviewed diffs."),
    });
    expect(history.entries[4]).toMatchObject({ fields: { scope: "global" } });

    await memoryManager.deleteMemory(created.filename, {}, "user");
    expect(historyRows().at(-1)).toMatchObject({ memoryId: created.id, op: "deleted", actor: "user" });
  });

  it("records candidate approval and discard with the party that acted", async () => {
    const approved = await memoryManager.saveMemory("Candidate A", "Approve me.", { state: "candidate", source: "assistant" });
    const discarded = await memoryManager.saveMemory("Candidate B", "Discard me.", { state: "candidate", source: "assistant" });
    await memoryManager.activateMemoryCandidate(approved.id!, {}, "user");
    await memoryManager.deleteMemoryCandidate(discarded.id!, {}, "assistant");

    const rows = historyRows();
    expect(rows.filter((row) => row.memoryId === approved.id).map((row) => [row.op, row.actor]))
      .toEqual([["created", "assistant"], ["activated", "user"]]);
    expect(rows.filter((row) => row.memoryId === discarded.id).map((row) => [row.op, row.actor]))
      .toEqual([["created", "assistant"], ["discarded", "assistant"]]);
  });

  it("masks and bounds before/after text instead of copying whole bodies", async () => {
    const secret = "api_key=sk-abcdefghijklmnopqrstuvwx";
    const created = await memoryManager.saveMemory("Long note", `Old body ${secret}`, { kind: "fact" });
    await memoryManager.saveMemory("Long note", `${"new body ".repeat(700)}`, { kind: "fact" });

    const history = await memoryManager.getMemoryHistory(created.id!, {});
    const update = history.entries.find((row) => row.op === "updated")!;
    expect(update.before).not.toContain("sk-abcdefghijklmnopqrstuvwx");
    expect(update.after!.length).toBeLessThanOrEqual(MAX_HISTORY_TEXT_CHARS);
    expect(JSON.stringify(history)).not.toContain("sk-abcdefghijklmnopqrstuvwx");
  });

  it("does not fail the change when the history write fails, and reports the gap on the next read", async () => {
    mkdirSync(join(dir, "memories", "history.jsonl"));
    const created = await memoryManager.saveMemory("Still saved", "The memory write must succeed.", { kind: "fact" });
    expect(memoryManager.listMemoryEntries().map((entry) => entry.id)).toContain(created.id);

    const history = await memoryManager.getMemoryHistory(created.id!, {});
    expect(history).toMatchObject({ entries: [], historyIncomplete: true });
  });

  it("reads history only for a memory visible in the caller's scope", async () => {
    const local = await memoryManager.saveMemory("Alpha only", "Alpha detail.", { projectRoot: ALPHA, projectName: "alpha" });
    await expect(memoryManager.getMemoryHistory(local.id!, { projectRoot: "C:\\workspace\\beta" }))
      .rejects.toThrow(/memory not found/);
  });
});

describe("MemoryHistory file", () => {
  const ID = "0f1e2d3c-4b5a-4968-8776-655443322110";

  it("rotates the oldest rows past its cap and says where the history now starts", async () => {
    const history = new MemoryHistory(dir, { maxBytes: 1_200 });
    for (let index = 0; index < 20; index += 1) {
      await history.record({ memoryId: ID, op: "updated", actor: "user", at: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString() });
    }
    const read = await history.read(ID);
    expect(read.entries.length).toBeGreaterThan(0);
    expect(read.entries.length).toBeLessThan(20);
    expect(read.truncatedBefore).toBe(read.entries[0]!.at);
    expect(read.entries.at(-1)!.at).toBe(new Date(Date.UTC(2026, 0, 1, 0, 19)).toISOString());
    expect(read.historyIncomplete).toBeUndefined();
  });

  it("reports a malformed stored row instead of silently skipping it", async () => {
    const history = new MemoryHistory(dir);
    await history.record({ memoryId: ID, op: "created", actor: "user" });
    appendFileSync(join(dir, "history.jsonl"), `${JSON.stringify({ v: 1, memoryId: ID, at: "2026-01-01T00:00:00.000Z", op: "renamed", actor: "user" })}\n`);
    await history.record({ memoryId: ID, op: "updated", actor: "user" });

    const read = await history.read(ID);
    expect(read.entries.map((row) => row.op)).toEqual(["created", "updated"]);
    expect(read.historyIncomplete).toBe(true);
  });
});
