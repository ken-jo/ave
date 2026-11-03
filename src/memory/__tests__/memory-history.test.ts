import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    }, "user");
    // The actor is whoever saves now, not the stored source: Ave updating a user's memory is recorded as Ave.
    await memoryManager.saveMemory("Review style", "Prefer small, reviewed diffs.", {
      projectRoot: ALPHA, projectName: "alpha", kind: "preference",
    }, "assistant");

    const history = await memoryManager.getMemoryHistory(created.id!, { projectRoot: ALPHA });
    expect(history.historyIncomplete).toBeUndefined();
    expect(history.truncatedBefore).toBeUndefined();
    expect(history.entries.map((row) => [row.op, row.actor])).toEqual([
      ["created", "user"],
      ["updated", "assistant"],
    ]);
    expect(history.entries[0]).toMatchObject({ fields: { title: "Review style", scope: "project" } });
    expect(history.entries[0]!.fields!.contentDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(history.entries[1]).toMatchObject({
      before: expect.stringContaining("Prefer small diffs."),
      after: expect.stringContaining("Prefer small, reviewed diffs."),
    });

    await memoryManager.deleteMemory(created.filename, { projectRoot: ALPHA }, "user");
    expect(historyRows().at(-1)).toMatchObject({ memoryId: created.id, op: "deleted", actor: "user" });
  });

  it("removes a deleted memory's text from the history file, keeping only what happened", async () => {
    const created = await memoryManager.saveMemory("Partner codename Bluebird", "Launch partner is Bluebird Corp.", { kind: "fact" }, "user");
    await memoryManager.saveMemory("Partner codename Bluebird", "Launch partner is Bluebird Holdings.", { kind: "fact" }, "assistant");
    const other = await memoryManager.saveMemory("Unrelated", "Keep this text.", { kind: "fact" }, "user");

    await memoryManager.deleteMemory(created.filename, {}, "user");

    const raw = readFileSync(join(dir, "memories", "history.jsonl"), "utf-8");
    expect(raw).not.toContain("Bluebird");
    expect(raw).toContain("Unrelated");
    expect(historyRows().filter((row) => row.memoryId === created.id).map((row) => row.op))
      .toEqual(["created", "updated", "deleted"]);
    expect(historyRows().find((row) => row.memoryId === created.id && row.op === "updated"))
      .toMatchObject({ actor: "assistant", fields: { contentDigest: expect.stringMatching(/^[0-9a-f]{64}$/) } });
    expect((await memoryManager.getMemoryHistory(other.id!, {})).entries).toHaveLength(1);
  });

  it("removes a discarded candidate's text from the history file too", async () => {
    const candidate = await memoryManager.saveMemory("Candidate Bluebird", "Bluebird detail.", { state: "candidate", source: "assistant" }, "assistant");
    await memoryManager.deleteMemoryCandidate(candidate.id!, {}, "user");
    expect(readFileSync(join(dir, "memories", "history.jsonl"), "utf-8")).not.toContain("Bluebird");
  });

  it("refuses the delete, keeping the memory, when the history text cannot be removed", async () => {
    const created = await memoryManager.saveMemory("Keep me", "Body.", { kind: "fact" }, "user");
    const historyPath = join(dir, "memories", "history.jsonl");
    rmSync(historyPath);
    mkdirSync(historyPath);

    await expect(memoryManager.deleteMemory(created.filename, {}, "user")).rejects.toThrow();
    expect(memoryManager.listMemoryEntries().map((entry) => entry.id)).toContain(created.id);
  });

  it("masks the title it records", async () => {
    const created = await memoryManager.saveMemory("token sk-abcdefghijklmnopqrstuvwx", "Body.", { kind: "fact" }, "user");
    const history = await memoryManager.getMemoryHistory(created.id!, {});
    expect(history.entries[0]!.fields!.title).not.toContain("sk-abcdefghijklmnopqrstuvwx");
  });

  it("records candidate approval and discard with the party that acted", async () => {
    const approved = await memoryManager.saveMemory("Candidate A", "Approve me.", { state: "candidate", source: "assistant" }, "assistant");
    const discarded = await memoryManager.saveMemory("Candidate B", "Discard me.", { state: "candidate", source: "assistant" }, "assistant");
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
    const created = await memoryManager.saveMemory("Long note", `Old body ${secret}`, { kind: "fact" }, "user");
    await memoryManager.saveMemory("Long note", `${"new body ".repeat(700)}`, { kind: "fact" }, "user");

    const history = await memoryManager.getMemoryHistory(created.id!, {});
    const update = history.entries.find((row) => row.op === "updated")!;
    expect(update.before).not.toContain("sk-abcdefghijklmnopqrstuvwx");
    expect(update.after!.length).toBeLessThanOrEqual(MAX_HISTORY_TEXT_CHARS);
    expect(JSON.stringify(history)).not.toContain("sk-abcdefghijklmnopqrstuvwx");
  });

  it("does not fail the change when the history write fails, and reports the gap on the next read", async () => {
    mkdirSync(join(dir, "memories", "history.jsonl"));
    const created = await memoryManager.saveMemory("Still saved", "The memory write must succeed.", { kind: "fact" }, "user");
    expect(memoryManager.listMemoryEntries().map((entry) => entry.id)).toContain(created.id);

    const history = await memoryManager.getMemoryHistory(created.id!, {});
    expect(history).toMatchObject({ entries: [], historyIncomplete: true });
  });

  it("reads history only for a memory visible in the caller's scope", async () => {
    const local = await memoryManager.saveMemory("Alpha only", "Alpha detail.", { projectRoot: ALPHA, projectName: "alpha" }, "user");
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

  it("keeps a broken row's gap on its own memory and clears a failure once rotation passes it", async () => {
    const OTHER = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
    const history = new MemoryHistory(dir, { maxBytes: 1_200 });
    await history.record({ memoryId: ID, op: "created", actor: "user", at: "2026-01-01T00:00:00.000Z" });
    appendFileSync(join(dir, "history.jsonl"), `{"v":1,"memoryId":"${OTHER}","op":"renamed"}\n`);
    expect((await history.read(ID)).historyIncomplete).toBeUndefined();
    expect((await history.read(OTHER)).historyIncomplete).toBe(true);

    // A failed append for ID (the file is briefly a directory) marks ID only.
    const historyPath = join(dir, "history.jsonl");
    const saved = readFileSync(historyPath, "utf-8");
    rmSync(historyPath);
    mkdirSync(historyPath);
    await history.record({ memoryId: ID, op: "updated", actor: "user", at: "2026-01-01T00:01:00.000Z" });
    rmSync(historyPath, { recursive: true });
    writeFileSync(historyPath, saved);
    expect((await history.read(ID)).historyIncomplete).toBe(true);
    expect((await history.read(OTHER)).historyIncomplete).toBe(true);

    for (let index = 0; index < 20; index += 1) {
      await history.record({ memoryId: OTHER, op: "updated", actor: "user", at: new Date(Date.UTC(2026, 0, 2, 0, index)).toISOString() });
    }
    const afterRotation = await history.read(ID);
    expect(afterRotation.truncatedBefore).toBeDefined();
    expect(afterRotation.historyIncomplete).toBeUndefined();
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
