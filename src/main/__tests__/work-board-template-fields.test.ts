import { requiredValue } from "../../__tests__/support/required-value.js";
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
const stage = { stageId: "plan", attempt: 1, status: "awaiting_gate", output: "result", resultHash: "a".repeat(64), gate: { type: "human", status: "pending", revision: 0 } };
const item = () => ({ id: 1, title: "Work", status: "planned", priority: "medium", created_at: "2026-01-01", updated_at: "2026-01-01", templateId: "template-1", runId: "run-1", runTemplateVersion: 1, runTemplateGraphHash: "b".repeat(64), stageRuns: [stage], runHistory: [{ runId: "run-1", startedAt: "2026-01-01", status: "executing", templateVersion: 1, templateGraphHash: "b".repeat(64), stageRuns: [{ stageId: "plan", attempt: 1, status: "awaiting_gate" }] }] });
it("retains additive template fields in board version 1 across a read and write", async () => {
  expect(BOARD_VERSION).toBe(1); const path = join(dir, "board.json");
  await writeFile(path, JSON.stringify({ version: 1, nextId: 2, items: [item()] }));
  const store = new WorkBoardStore(path); const result = await store.get(1);
  expect(result.status).toBe("found"); if (result.status !== "found") throw new Error("missing");
  expect(result.item).toMatchObject(item());
  requiredValue(result.item.stageRuns)[0].attempt = 3;
  expect(requiredValue((await store.get(1) as typeof result).item.stageRuns)[0].attempt).toBe(1);
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
  const store = new WorkBoardStore(path);
  expect(await store.get(1)).toMatchObject({ status: "found", item: { templateRunError: "invalid-template-run" } });
  await expect(store.beginRun(1, "new-run", "2026-01-01")).rejects.toMatchObject({ code: "invalid-template-run" });
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
    expect(await store.get(1)).toMatchObject({ status: "found", item: { templateRunError: "invalid-template-run" } });
    await expect(store.beginRun(1, "new-run", "2026-01-01")).rejects.toMatchObject({ code: "invalid-template-run", message: "Stage output exceeds 48000 characters" });
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
  requiredValue(board.items[0].stageRuns)[0].output = output;
  // All board mutations share this commit boundary.
  const writer = store as unknown as { commit(board: BoardFile): Promise<void> };
  await writer.commit(board);
  expect(JSON.parse(await readFile(path, "utf8")).items[0].stageRuns[0].output).toBe(output);
  const before = await readFile(path, "utf8");
  const oversized = structuredClone(board);
  requiredValue(oversized.items[0].stageRuns)[0].output += "x";
  let changes = 0;
  store.boardChanged.subscribe(() => { changes++; });
  await expect(writer.commit(oversized)).rejects.toBeInstanceOf(WorkflowTemplateError);
  await expect(writer.commit(oversized)).rejects.toMatchObject({ code: "invalid-template-run", message: "Stage output exceeds 48000 characters" });
  expect(await readFile(path, "utf8")).toBe(before);
  expect(await store.get(1)).toMatchObject({ status: "found", item: { stageRuns: [{ output }] } });
  expect(changes).toBe(0);
});

const pin = { templateId: "template-1", version: 1, graphHash: "b".repeat(64) };
const source = { kind: "local-create-and-run", pin } as const;
const extras = () => ({
  runStartedBy: source, runWorkspace: { kind: "folder", runRoot: "/runs/example", outputDir: "/runs/example/_out" },
  stageJoins: [{ joinId: "join-a", stageIds: ["plan"], status: "conflict", conflict: { conflictHash: "a".repeat(64), reason: "same-path", files: [{ path: "report.txt", stageIds: ["plan"] }], excerpt: "untrusted" } }],
  stageRuns: [{ ...stage, failure: "budget", taint: "file-content", gate: { ...stage.gate, judgedBy: "host" }, workspace: { root: "/runs/example/plan", kind: "folder", manifest: [{ path: "report.txt", size: 10, sha256: "a".repeat(64) }] }, blocked: { code: "lane-unavailable", at: "2026-01-01" }, requestedOutputs: [{ id: "out", decl: { kind: "tool", tool: "media.send" }, args: "{}", summary: "Report", files: [{ path: "report.txt", size: 10, sha256: "a".repeat(64) }] }], outputExecutions: [{ id: "out", status: "pending" }], usage: { rounds: 1, startedAt: "2026-01-01", denials: 0, costUsd: 0 } }],
});
it("round trips complete additive fields while retaining unknown additive data", async () => {
  const path = join(dir, "board.json"); const value = { ...item(), ...extras(), futureField: { enabled: true } }; await writeFile(path, JSON.stringify({ version: 1, nextId: 2, items: [value] })); const store = new WorkBoardStore(path); await store.update(1, { title: "Updated" }); expect(JSON.parse(await readFile(path, "utf8")).items[0]).toEqual({ ...value, title: "Updated", updated_at: expect.any(String) });
});
it.each([
  { runStartedBy: { ...source, pin: { ...pin, version: 2 } } },
  { runStartedBy: { kind: "schedule-attachment", pin, firedAt: "2026-01-01" } },
  { runWorkspace: { kind: "folder" } }, { stageJoins: [{ joinId: "join-a", stageIds: [], status: "unknown" }] },
  ...[{ failure: "unknown" }, { taint: "unknown" }, { gate: { ...stage.gate, judgedBy: "unknown" } }, { workspace: { root: "/runs/a" } }, { blocked: { code: "unknown", at: "2026-01-01" } }, { requestedOutputs: [{ id: "out" }] }, { requestedOutputs: [{ ...extras().stageRuns[0].requestedOutputs[0], args: "bad-json" }] }, { outputExecutions: [{ id: "out", status: "unknown" }] }, { usage: { rounds: -1, startedAt: "2026-01-01", denials: 0 } }].map(patch => ({ stageRuns: [{ ...stage, ...patch }] })),
])("refuses malformed new fields without repairing them %j", async patch => {
  const path = join(dir, "board.json"); const bytes = JSON.stringify({ version: 1, nextId: 2, items: [{ ...item(), ...patch }] }); await writeFile(path, bytes); const store = new WorkBoardStore(path); expect(await store.get(1)).toMatchObject({ status: "found", item: { templateRunError: "invalid-template-run" } }); await expect(store.beginRun(1, "new-run", "2026-01-01")).rejects.toMatchObject({ code: "invalid-template-run" }); expect(await readFile(path, "utf8")).toBe(bytes);
});
it("begins from the supplied pin and refuses mismatched authority", async () => {
  const store = new WorkBoardStore(join(dir, "board.json")); const created = await store.create({ title: "Template", templateId: pin.templateId }); if (created.status !== "created") throw new Error("missing");
  await expect(store.beginRun(created.itemId, "run-a", "2026-01-01", { ...pin, source: { ...source, pin: { ...pin, version: 2 } }, stageRuns: [] })).rejects.toMatchObject({ code: "invalid-template-run" });
  expect(await store.beginRun(created.itemId, "run-a", "2026-01-01", { ...pin, source, stageRuns: [{ stageId: "plan", attempt: 1, status: "waiting" }] })).toMatchObject({ status: "updated", item: { runTemplateVersion: 1, runTemplateGraphHash: pin.graphHash, runStartedBy: source, stageRuns: [{ stageId: "plan" }] } });
});
it("updates stage state under one lock and never invokes a stale run mutation", async () => {
  const path = join(dir, "board.json"); await writeFile(path, JSON.stringify({ version: 1, nextId: 2, items: [item()] })); const store = new WorkBoardStore(path); let called = false;
  expect(await store.updateStageRun(1, "other-run", value => { called = true; return value; })).toMatchObject({ status: "invalid", reason: "run-mismatch" }); expect(called).toBe(false);
  await Promise.all([store.updateStageRun(1, "run-1", value => ({ ...value, stageRuns: requiredValue(value.stageRuns).map(s => ({ ...s, attempt: s.attempt + 1 })) })), store.updateStageRun(1, "run-1", value => ({ ...value, stageRuns: requiredValue(value.stageRuns).map(s => ({ ...s, attempt: s.attempt + 1 })) }))]);
  expect(await store.get(1)).toMatchObject({ status: "found", item: { stageRuns: [{ attempt: 3 }] } });
  const before = await readFile(path, "utf8"); await expect(store.updateStageRun(1, "run-1", value => ({ ...value, runId: "forged" }))).rejects.toMatchObject({ code: "invalid-template-run" }); expect(await readFile(path, "utf8")).toBe(before);
});
it("keeps legacy board rows byte-equivalent after a no-op engine mutation", async () => {
  const path = join(dir, "board.json"); const legacy = { id: 1, title: "Legacy", status: "planned", priority: "medium", created_at: "2026-01-01", updated_at: "2026-01-01", runId: "old" }; await writeFile(path, JSON.stringify({ version: 1, nextId: 2, items: [legacy] })); const store = new WorkBoardStore(path); await store.updateStageRun(1, "old", value => value); expect(JSON.parse(await readFile(path, "utf8")).items).toEqual([legacy]);
});

it.each([
  { stageJoins: Array(13).fill(extras().stageJoins[0]) },
  { stageJoins: [{ ...extras().stageJoins[0], conflict: { ...extras().stageJoins[0].conflict, files: Array(51).fill({ path: "report.txt", stageIds: ["plan"] }) } }] },
  ...[{ workspace: { root: "/runs/plan", kind: "folder", manifest: [{ path: "../report.txt", size: 1, sha256: "a".repeat(64) }] } }, { workspace: { root: "/runs/plan", kind: "folder", manifest: [{ path: "report.txt", size: 512 * 1024 * 1024 + 1, sha256: "a".repeat(64) }] } }, { requestedOutputs: Array(11).fill(extras().stageRuns[0].requestedOutputs[0]) }, { requestedOutputs: [{ ...extras().stageRuns[0].requestedOutputs[0], args: JSON.stringify("文".repeat(11000)) }] }, { requestedOutputs: [{ ...extras().stageRuns[0].requestedOutputs[0], summary: "s".repeat(401) }] }, { outputExecutions: Array(11).fill({ id: "out", status: "pending" }) }].map(patch => ({ stageRuns: [{ ...stage, ...patch }] })),
])("bounds persisted workspace and output declarations %j", async patch => {
  const path = join(dir, "board.json"); await writeFile(path, JSON.stringify({ version: 1, nextId: 2, items: [{ ...item(), ...patch }] })); const store = new WorkBoardStore(path); expect(await store.get(1)).toMatchObject({ status: "found", item: { templateRunError: "invalid-template-run" } }); await expect(store.beginRun(1, "new-run", "2026-01-01")).rejects.toMatchObject({ code: "invalid-template-run" });
});
it("accepts schedule authority only with its attachment and matching pin", async () => {
  const path = join(dir, "board.json"); const runStartedBy = { kind: "schedule-attachment", attachmentId: "attachment", pin, firedAt: "2026-01-01" }; await writeFile(path, JSON.stringify({ version: 1, nextId: 2, items: [{ ...item(), runStartedBy }] })); expect(await new WorkBoardStore(path).get(1)).toMatchObject({ status: "found", item: { runStartedBy } });
});
