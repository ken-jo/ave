import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WorkBoardStore } from "../work-board-store.js";
import { BOARD_VERSION } from "../../work-board/board-file.js";
import type { BoardFile } from "../../work-board/board-file.js";
import { WorkflowTemplateError } from "../../work-board/template-graph.js";
let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "board-template-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
const stage = { stageId: "plan", attempt: 1, status: "awaiting_gate", output: "result", outputHash: "a".repeat(64), gate: { type: "human", status: "pending", revision: 0 } };
const item = () => ({ id: 1, title: "Work", status: "planned", priority: "medium", created_at: "2026-01-01", updated_at: "2026-01-01", templateId: "template-1", runId: "run-1", runTemplateVersion: 1, runTemplateGraphHash: "b".repeat(64), stageRuns: [stage], runHistory: [{ runId: "run-1", startedAt: "2026-01-01", status: "executing", templateVersion: 1, templateGraphHash: "b".repeat(64), stageRuns: [{ stageId: "plan", attempt: 1, status: "awaiting_gate" }] }] });
it("retains additive template fields in board version 1 across a read and write", async () => {
  expect(BOARD_VERSION).toBe(1); const path = join(dir, "board.json");
  await writeFile(path, JSON.stringify({ version: 1, nextId: 2, items: [item()] }));
  const store = new WorkBoardStore(path); const result = await store.get(1);
  expect(result.status).toBe("found"); if (result.status !== "found") throw new Error("missing");
  expect(result.item).toMatchObject(item());
  result.item.stageRuns![0].attempt = 3;
  expect((await store.get(1) as typeof result).item.stageRuns![0].attempt).toBe(1);
  await store.update(1, { title: "Updated" }); const saved = JSON.parse(await readFile(path, "utf8"));
  expect(saved.version).toBe(1); expect(saved.items[0]).toMatchObject({ ...item(), title: "Updated", updated_at: expect.any(String) });
});
it("accepts legacy items and persists only templateId from creation", async () => {
  const store = new WorkBoardStore(join(dir, "board.json"));
  const legacy = await store.create({ title: "Legacy" }); expect(legacy.status).toBe("created");
  const created = await store.create({ title: "From template", templateId: "template-1" });
  expect(created).toMatchObject({ status: "created", item: { templateId: "template-1" } });
  expect(await store.create({ title: "Bad", templateId: "" })).toMatchObject({ status: "invalid" });
  expect(await store.update(1, { stageRuns: [stage] } as never)).toMatchObject({ status: "invalid" });
});
it.each([
  { runTemplateVersion: 0 }, { runTemplateGraphHash: "bad" }, { stageRuns: [{ ...stage, attempt: 4 }] },
  { stageRuns: [{ ...stage, gate: { type: "human", status: "approved", revision: -1 } }] },
  { runHistory: [{ runId: "old", templateVersion: 1, templateGraphHash: "bad", stageRuns: [] }] },
])("refuses malformed persisted template state clearly %j", async patch => {
  const path = join(dir, "board.json"); await writeFile(path, JSON.stringify({ version: 1, nextId: 2, items: [{ ...item(), ...patch }] }));
  await expect(new WorkBoardStore(path).load()).rejects.toMatchObject({ code: "invalid-template-run" });
});

it("parks template execution until the scheduler owns run pinning", async () => {
  const store = new WorkBoardStore(join(dir, "board.json"));
  const templated = await store.create({ title: "Template", templateId: "template-1" });
  if (templated.status !== "created") throw new Error("missing");
  expect(await store.beginRun(templated.itemId, "run-1", "2026-01-01")).toMatchObject({ status: "invalid", reason: "template-run-unavailable" });
  expect((await store.get(templated.itemId))).toMatchObject({ status: "found", item: { templateId: "template-1" } });
  const ordinary = await store.create({ title: "Ordinary" });
  if (ordinary.status !== "created") throw new Error("missing");
  expect(await store.beginRun(ordinary.itemId, "run-2", "2026-01-01")).toMatchObject({ status: "updated", item: { runId: "run-2" } });
});

it.each([48_000, 48_001])("enforces the stored stage output bound on read at %i characters", async length => {
  const path = join(dir, "board.json");
  const output = "x".repeat(length);
  await writeFile(path, JSON.stringify({ version: 1, nextId: 2, items: [{ ...item(), stageRuns: [{ ...stage, output }] }] }));
  const before = await readFile(path, "utf8");
  const store = new WorkBoardStore(path);
  if (length === 48_000) {
    expect(await store.get(1)).toMatchObject({ status: "found", item: { stageRuns: [{ output }] } });
  } else {
    await expect(store.load()).rejects.toBeInstanceOf(WorkflowTemplateError);
    await expect(store.load()).rejects.toMatchObject({ code: "invalid-template-run", message: "Stage output exceeds 48000 characters" });
  }
  expect(await readFile(path, "utf8")).toBe(before);
});
it("enforces the output bound before a board write without changing disk or cache", async () => {
  const path = join(dir, "board.json");
  await writeFile(path, JSON.stringify({ version: 1, nextId: 2, items: [item()] }));
  const store = new WorkBoardStore(path);
  await store.load();
  const board: BoardFile = JSON.parse(await readFile(path, "utf8"));
  const output = "x".repeat(48_000);
  board.items[0].stageRuns![0].output = output;
  // All board mutations share this commit boundary.
  const writer = store as unknown as { commit(board: BoardFile): Promise<void> };
  await writer.commit(board);
  expect(JSON.parse(await readFile(path, "utf8")).items[0].stageRuns[0].output).toBe(output);
  const before = await readFile(path, "utf8");
  const oversized = structuredClone(board);
  oversized.items[0].stageRuns![0].output += "x";
  let changes = 0;
  store.boardChanged.subscribe(() => { changes++; });
  await expect(writer.commit(oversized)).rejects.toBeInstanceOf(WorkflowTemplateError);
  await expect(writer.commit(oversized)).rejects.toMatchObject({ code: "invalid-template-run", message: "Stage output exceeds 48000 characters" });
  expect(await readFile(path, "utf8")).toBe(before);
  expect(await store.get(1)).toMatchObject({ status: "found", item: { stageRuns: [{ output }] } });
  expect(changes).toBe(0);
});
