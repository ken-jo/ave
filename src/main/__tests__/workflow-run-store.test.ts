import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WorkflowRunStore } from "../workflow-run-store.js";
import * as homeTrust from "../../shared/ave-home-trust.js";
import type { WorkflowRunRecord } from "../../shared/workflow-template-types.js";

let dir: string;
let file: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "workflow-runs-")); file = join(dir, "workflow-runs.json"); });
afterEach(async () => { vi.restoreAllMocks(); await rm(dir, { recursive: true, force: true }); });

const pin = { templateId: "template-1", version: 1, graphHash: "b".repeat(64) };
const run = (patch: Partial<WorkflowRunRecord> = {}): WorkflowRunRecord => ({
  runId: "run-1", itemId: 1, pin, runStartedBy: { kind: "local-create-and-run", pin }, startedAt: "2026-01-01T00:00:00.000Z",
  stageRuns: [{ stageId: "plan", attempt: 1, status: "awaiting_gate", output: "result", resultHash: "a".repeat(64), outputHash: "c".repeat(64), gate: { type: "human", status: "pending", revision: 0 } }],
  ...patch,
});
const stored = async (): Promise<{ version: number; runs: unknown[] }> => JSON.parse(await readFile(file, "utf8"));

it("stores a run by runId and returns copies", async () => {
  const store = new WorkflowRunStore(file);
  expect(await store.get("run-1")).toEqual({ status: "not-found" });
  expect(await store.put(run())).toEqual({ status: "stored", run: run() });
  expect(await stored()).toEqual({ version: 1, runs: [run()] });
  const read = await store.get("run-1");
  if (read.status !== "found") throw new Error("Missing run");
  for (const entry of read.run.stageRuns) entry.attempt = 3;
  expect(await store.get("run-1")).toEqual({ status: "found", run: run() });
  expect(await store.put(run({ runId: "run-2", itemId: 2 }))).toMatchObject({ status: "stored" });
  expect((await stored()).runs).toHaveLength(2);
});

it("carries the complete run state through a write", async () => {
  const store = new WorkflowRunStore(file);
  const full = run({
    runStartedBy: { kind: "schedule-attachment", attachmentId: "attachment", pin, firedAt: "2026-01-01T00:00:00.000Z" },
    runWorkspace: { kind: "folder", runRoot: "/runs/example", outputDir: "/runs/example/_out" },
    stageJoins: [{ joinId: "join-a", stageIds: ["plan"], status: "conflict", conflict: { conflictHash: "a".repeat(64), reason: "same-path", files: [{ path: "report.txt", stageIds: ["plan"] }] } }],
  });
  expect(await store.put(full)).toEqual({ status: "stored", run: full });
  expect(await store.get("run-1")).toEqual({ status: "found", run: full });
});

it.each([
  { itemId: 2 },
  { pin: { ...pin, version: 2 }, runStartedBy: { kind: "local-create-and-run" as const, pin: { ...pin, version: 2 } } },
  { runStartedBy: { kind: "schedule-attachment" as const, attachmentId: "attachment", pin, firedAt: "2026-01-01T00:00:00.000Z" } },
])("refuses to rebind a stored run %j", async patch => {
  const store = new WorkflowRunStore(file);
  await store.put(run());
  const before = await readFile(file, "utf8");
  await expect(store.put(run(patch))).rejects.toMatchObject({ code: "invalid-template-run" });
  await expect(store.update("run-1", value => ({ ...value, ...patch }))).rejects.toMatchObject({ code: "invalid-template-run" });
  await expect(store.update("run-1", value => ({ ...value, runId: "run-9" }))).rejects.toMatchObject({ code: "invalid-template-run" });
  expect(await readFile(file, "utf8")).toBe(before);
});

it.each([
  { runStartedBy: { kind: "local-create-and-run", pin: { ...pin, version: 2 } } },
  { runStartedBy: { kind: "schedule-attachment", pin, firedAt: "2026-01-01T00:00:00.000Z" } },
  { pin: { ...pin, graphHash: "bad" } }, { itemId: 0 }, { runId: "" }, { startedAt: "never" }, { templateId: "template-1" },
  { runWorkspace: { kind: "folder" } }, { stageJoins: [{ joinId: "join-a", stageIds: ["other"], status: "integrated" }] },
  ...[{ attempt: 4 }, { status: "future" }, { resultHash: "bad" }, { outputHash: "bad" }, { gate: { type: "human", status: "approved", revision: -1 } }, { output: "x".repeat(48_001) }]
    .map(patch => ({ stageRuns: [{ ...run().stageRuns[0], ...patch }] })),
])("refuses to store a malformed run %j", async patch => {
  const store = new WorkflowRunStore(file);
  await expect(store.put({ ...run(), ...patch } as WorkflowRunRecord)).rejects.toMatchObject({ code: "invalid-template-run" });
  await expect(readFile(file, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
});

it("updates under one lock and never calls the mutation for a missing run", async () => {
  const store = new WorkflowRunStore(file);
  await store.put(run());
  const mutate = vi.fn((value: WorkflowRunRecord) => value);
  expect(await store.update("other-run", mutate)).toEqual({ status: "not-found" });
  expect(mutate).not.toHaveBeenCalled();
  const bump = (value: WorkflowRunRecord): WorkflowRunRecord => ({ ...value, stageRuns: value.stageRuns.map(stage => ({ ...stage, attempt: stage.attempt + 1 })) });
  await Promise.all([store.update("run-1", bump), store.update("run-1", bump)]);
  expect(await store.get("run-1")).toMatchObject({ status: "found", run: { stageRuns: [{ attempt: 3 }] } });
  const before = await readFile(file, "utf8");
  expect(await store.update("run-1", () => null)).toEqual({ status: "refused" });
  expect(await readFile(file, "utf8")).toBe(before);
});

it.each([
  ["a malformed stage", { ...run({ runId: "run-bad" }), stageRuns: [{ stageId: "plan", attempt: 4, status: "running" }] }],
  ["an unknown key", { ...run({ runId: "run-bad" }), approvedBy: "user" }],
])("refuses only the entry with %s and keeps its stored value", async (_name, bad) => {
  await writeFile(file, JSON.stringify({ version: 1, runs: [run(), bad, "stray"] }));
  const store = new WorkflowRunStore(file);
  expect(await store.get("run-bad")).toEqual({ status: "invalid" });
  const mutate = vi.fn((value: WorkflowRunRecord) => value);
  expect(await store.update("run-bad", mutate)).toEqual({ status: "invalid" });
  expect(mutate).not.toHaveBeenCalled();
  expect(await store.put(run({ runId: "run-bad" }))).toEqual({ status: "invalid" });
  expect(await store.update("run-1", value => ({ ...value, stageRuns: [] }))).toMatchObject({ status: "stored" });
  expect(await store.put(run({ runId: "run-2", itemId: 2 }))).toMatchObject({ status: "stored" });
  expect((await stored()).runs).toEqual([run({ stageRuns: [] }), bad, "stray", run({ runId: "run-2", itemId: 2 })]);
  expect(await new WorkflowRunStore(file).get("run-bad")).toEqual({ status: "invalid" });
});

it("refuses every entry that shares a runId", async () => {
  await writeFile(file, JSON.stringify({ version: 1, runs: [run(), run({ itemId: 2 })] }));
  const store = new WorkflowRunStore(file);
  expect(await store.get("run-1")).toEqual({ status: "invalid" });
  expect(await store.put(run())).toEqual({ status: "invalid" });
});

it.each(["not json", JSON.stringify({ version: 2, runs: [] }), JSON.stringify({ version: 1, runs: {} })])("fails clearly on an unreadable run file %j", async bytes => {
  await writeFile(file, bytes);
  const store = new WorkflowRunStore(file);
  await expect(store.get("run-1")).rejects.toMatchObject({ code: "invalid-template-run" });
  await expect(store.put(run())).rejects.toMatchObject({ code: "invalid-template-run" });
  expect(await readFile(file, "utf8")).toBe(bytes);
});

it("reports a size-limit refusal as pending review and lets other read errors throw", async () => {
  const store = new WorkflowRunStore(file);
  await store.put(run());
  const before = await readFile(file, "utf8");
  const read = vi.spyOn(homeTrust, "readAveHomeInput");
  read.mockRejectedValue(new homeTrust.AveHomeInputSizeLimitError("too large"));
  expect(await store.get("run-1")).toEqual({ status: "pending-review" });
  expect((await store.view()).pendingReview).toBe(true);
  const mutate = vi.fn((value: WorkflowRunRecord) => value);
  expect(await store.update("run-1", mutate)).toEqual({ status: "pending-review" });
  expect(await store.put(run({ runId: "run-2", itemId: 2 }))).toEqual({ status: "pending-review" });
  expect(mutate).not.toHaveBeenCalled();
  read.mockRejectedValue(Object.assign(new Error("read failed"), { code: "EIO" }));
  await expect(store.get("run-1")).rejects.toMatchObject({ code: "EIO" });
  await expect(store.view()).rejects.toMatchObject({ code: "EIO" });
  await expect(store.put(run({ runId: "run-2", itemId: 2 }))).rejects.toMatchObject({ code: "EIO" });
  read.mockRestore();
  expect(await readFile(file, "utf8")).toBe(before);
});

it("stores how a run ended and refuses a malformed end", async () => {
  const store = new WorkflowRunStore(file);
  const settled = { status: "cancelled", at: "2026-01-02T00:00:00.000Z" } as const;
  expect(await store.put(run())).toMatchObject({ status: "stored" });
  expect(await store.update("run-1", value => ({ ...value, settled }))).toMatchObject({ status: "stored", run: { settled } });
  expect(await store.get("run-1")).toMatchObject({ status: "found", run: { settled } });
  for (const bad of [{ status: "idle", at: settled.at }, { status: "error", at: "never" }, { status: "error" }, { ...settled, by: "user" }]) {
    await expect(store.update("run-1", value => ({ ...value, settled: bad as never }))).rejects.toMatchObject({ code: "invalid-template-run" });
  }
});
