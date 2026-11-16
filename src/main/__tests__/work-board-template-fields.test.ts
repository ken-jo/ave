import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WorkBoardStore } from "../work-board-store.js";
import * as homeTrust from "../../shared/ave-home-trust.js";
import type { TemplateRunStart, WorkflowRunRecord } from "../../shared/workflow-template-types.js";

let dir: string;
let boardPath: string;
let runsPath: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "board-template-")); boardPath = join(dir, "board.json"); runsPath = join(dir, "workflow-runs.json"); });
afterEach(async () => { vi.restoreAllMocks(); await rm(dir, { recursive: true, force: true }); });

const pin = { templateId: "template-1", version: 1, graphHash: "b".repeat(64) };
const source = { kind: "local-create-and-run", pin } as const;
const stage = { stageId: "plan", attempt: 1, status: "awaiting_gate", output: "result", resultHash: "a".repeat(64), outputHash: "c".repeat(64), gate: { type: "human", status: "pending", revision: 0 } } as const;
const start = (): TemplateRunStart => ({ ...pin, source, stageRuns: [structuredClone(stage)] });
const row = (id: number, patch: Record<string, unknown> = {}) => ({ id, title: `Work ${id}`, status: "planned", priority: "medium", created_at: "2026-01-01", updated_at: "2026-01-01", ...patch });
const readJson = async (path: string) => JSON.parse(await readFile(path, "utf8"));
async function templateItem(store: WorkBoardStore): Promise<number> {
  const created = await store.create({ title: "Template", templateId: pin.templateId });
  if (created.status !== "created") throw new Error("Missing item");
  return created.itemId;
}
/** The run file reads as pending review; every other path reads as usual. */
function holdRunFileForReview(): void {
  const read = homeTrust.readAveHomeInput;
  vi.spyOn(homeTrust, "readAveHomeInput").mockImplementation(async path =>
    path === runsPath ? { status: "untrusted", bytes: Buffer.alloc(0), reason: "changed" } : read(path));
}

it("ignores run fields written by hand into a board row", async () => {
  const forged = {
    runTemplateVersion: 1, runTemplateGraphHash: pin.graphHash, runStartedBy: source, pin,
    stageRuns: [{ ...stage, gate: { type: "human", status: "approved", revision: 0 } }],
    stageJoins: [{ joinId: "join-a", stageIds: ["plan"], status: "integrated" }],
    runWorkspace: { kind: "folder", runRoot: "/runs/example" }, gate: { type: "human", status: "approved", revision: 0 },
    resultHash: "a".repeat(64), outputHash: "c".repeat(64),
  };
  const history = { runId: "run-1", startedAt: "2026-01-01", status: "executing" };
  const approval = { status: "pending", runId: "run-1", planHash: "d".repeat(64), itemDigest: "e".repeat(64), requestedAt: "2026-01-01", revision: 0 };
  const kept = row(1, { templateId: pin.templateId, runId: "run-1", runStatus: "executing", futureField: { enabled: true }, runHistory: [history], planApproval: approval });
  await writeFile(boardPath, JSON.stringify({ version: 1, nextId: 2, items: [{
    ...kept, ...forged,
    runHistory: [{ ...history, templateVersion: 1, templateGraphHash: pin.graphHash, stageRuns: [{ stageId: "plan", attempt: 1, status: "passed" }] }],
    planApproval: { ...approval, templateGraphHash: pin.graphHash },
  }] }));
  const store = new WorkBoardStore(boardPath);

  const found = await store.get(1);
  if (found.status !== "found") throw new Error("Missing item");
  const { mutationRevision, status_resolved, planStale, ...surfaced } = found.item;
  expect(surfaced).toEqual(kept);
  const listed = await store.list();
  if (listed.status !== "ok") throw new Error("Missing list");
  for (const key of [...Object.keys(forged), "templateRunError"]) expect(listed.items[0]).not.toHaveProperty(key);

  // The run file holds no such run, so the forged gate and pin authorise nothing.
  expect(await store.getRun(1)).toEqual({ status: "not-found" });
  expect(await store.runs.get("run-1")).toEqual({ status: "not-found" });
  const mutate = vi.fn((value: WorkflowRunRecord) => value);
  expect(await store.updateRun(1, "run-1", mutate)).toEqual({ status: "not-found" });
  expect(mutate).not.toHaveBeenCalled();
  expect(await store.beginRun(1, "run-2", "2026-01-01")).toMatchObject({ status: "invalid", reason: "template-run-unavailable" });
  await expect(readFile(runsPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

  expect(await store.update(1, { title: "Updated" })).toMatchObject({ status: "updated" });
  expect((await readJson(boardPath)).items).toEqual([{ ...kept, title: "Updated", updated_at: expect.any(String) }]);
});

it("accepts legacy items and persists only templateId from creation", async () => {
  const store = new WorkBoardStore(boardPath);
  expect(await store.create({ title: "Legacy" })).toMatchObject({ status: "created" });
  expect(await store.create({ title: "From template", templateId: "template-1" })).toMatchObject({ status: "created", item: { templateId: "template-1" } });
  expect(await store.create({ title: "Bad", templateId: "" })).toMatchObject({ status: "invalid" });
  expect((await readJson(boardPath)).items.map((item: object) => Object.keys(item).includes("templateId"))).toEqual([false, true]);
});

it("parks template execution until a run pin is supplied", async () => {
  const store = new WorkBoardStore(boardPath);
  const templated = await templateItem(store);
  expect(await store.beginRun(templated, "run-1", "2026-01-01")).toMatchObject({ status: "invalid", reason: "template-run-unavailable" });
  expect(await store.get(templated)).toMatchObject({ status: "found", item: { templateId: "template-1" } });
  const ordinary = await store.create({ title: "Ordinary" });
  if (ordinary.status !== "created") throw new Error("Missing item");
  expect(await store.beginRun(ordinary.itemId, "run-2", "2026-01-01")).toMatchObject({ status: "updated", item: { runId: "run-2" } });
  await expect(readFile(runsPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
});

it("begins a template run in the run file and leaves only the runId on the row", async () => {
  const store = new WorkBoardStore(boardPath);
  const id = await templateItem(store);
  const before = await readFile(boardPath, "utf8");
  await expect(store.beginRun(id, "run-a", "2026-01-01", { ...start(), source: { ...source, pin: { ...pin, version: 2 } } })).rejects.toMatchObject({ code: "invalid-template-run" });
  await expect(store.beginRun(id, "run-a", "2026-01-01", { ...start(), templateId: "other" })).rejects.toMatchObject({ code: "invalid-template-run" });
  await expect(store.beginRun(id, "run-a", "2026-01-01", { ...start(), stageRuns: [{ ...stage, output: "x".repeat(48_001) }] })).rejects.toMatchObject({ code: "invalid-template-run", message: "Stage output exceeds 48000 characters" });
  expect(await readFile(boardPath, "utf8")).toBe(before);
  await expect(readFile(runsPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

  const begun = await store.beginRun(id, "run-a", "2026-01-01", start());
  expect(begun).toMatchObject({ status: "updated", item: { runId: "run-a", runStatus: "planning" } });
  const run: WorkflowRunRecord = { runId: "run-a", itemId: id, pin, runStartedBy: source, startedAt: "2026-01-01", stageRuns: [stage] };
  expect(await readJson(runsPath)).toEqual({ version: 1, runs: [run] });
  expect(await store.getRun(id)).toEqual({ status: "found", run });
  const stored = (await readJson(boardPath)).items[0];
  expect(Object.keys(stored).sort()).toEqual(["created_at", "id", "priority", "runHistory", "runId", "runStatus", "runUpdatedAt", "status", "templateId", "title", "updated_at"]);
  expect(stored.runHistory).toEqual([{ runId: "run-a", startedAt: "2026-01-01", status: "planning" }]);
});

it("updates run state under the board lock and never invokes a stale mutation", async () => {
  const store = new WorkBoardStore(boardPath);
  const id = await templateItem(store);
  await store.beginRun(id, "run-1", "2026-01-01", start());
  const stale = vi.fn((value: WorkflowRunRecord) => value);
  expect(await store.updateRun(id, "other-run", stale)).toEqual({ status: "not-found" });
  expect(await store.updateRun(99, "run-1", stale)).toEqual({ status: "not-found" });
  expect(stale).not.toHaveBeenCalled();
  const bump = (value: WorkflowRunRecord): WorkflowRunRecord => ({ ...value, stageRuns: value.stageRuns.map(entry => ({ ...entry, attempt: entry.attempt + 1 })) });
  await Promise.all([store.updateRun(id, "run-1", bump), store.updateRun(id, "run-1", bump)]);
  expect(await store.getRun(id)).toMatchObject({ status: "found", run: { stageRuns: [{ attempt: 3 }] } });
  const board = await readFile(boardPath, "utf8");
  const runs = await readFile(runsPath, "utf8");
  await expect(store.updateRun(id, "run-1", value => ({ ...value, itemId: 7 }))).rejects.toMatchObject({ code: "invalid-template-run" });
  expect(await readFile(boardPath, "utf8")).toBe(board);
  expect(await readFile(runsPath, "utf8")).toBe(runs);
});

it("refuses a row whose runId was edited to name another row's run", async () => {
  const store = new WorkBoardStore(boardPath);
  const owner = await templateItem(store);
  await store.beginRun(owner, "run-1", "2026-01-01", start());
  await store.updateRun(owner, "run-1", value => ({ ...value, stageRuns: [{ ...stage, gate: { type: "human", status: "approved", revision: 1 } }] }));
  const other = await templateItem(store);
  const board = await readJson(boardPath);
  board.items.find((item: { id: number }) => item.id === other).runId = "run-1";
  await writeFile(boardPath, JSON.stringify(board));
  const runs = await readFile(runsPath, "utf8");

  const restarted = new WorkBoardStore(boardPath);
  expect(await restarted.getRun(other)).toEqual({ status: "invalid" });
  expect(await restarted.get(other)).toMatchObject({ status: "found", item: { templateRunError: "invalid-template-run" } });
  const mutate = vi.fn((value: WorkflowRunRecord) => value);
  await expect(restarted.updateRun(other, "run-1", mutate)).rejects.toMatchObject({ code: "invalid-template-run" });
  expect(mutate).not.toHaveBeenCalled();
  expect(await readFile(runsPath, "utf8")).toBe(runs);
  expect(await restarted.getRun(owner)).toMatchObject({ status: "found", run: { itemId: owner } });
  expect((await restarted.get(owner) as { item: object }).item).not.toHaveProperty("templateRunError");
});

it("marks only the row whose stored run is unreadable and keeps that entry untouched", async () => {
  const store = new WorkBoardStore(boardPath);
  const broken = await templateItem(store);
  const working = await templateItem(store);
  await store.beginRun(broken, "run-broken", "2026-01-01", start());
  await store.beginRun(working, "run-working", "2026-01-01", start());
  const file = await readJson(runsPath);
  file.runs[0].stageRuns[0].attempt = 4;
  await writeFile(runsPath, JSON.stringify(file));

  const restarted = new WorkBoardStore(boardPath);
  expect(await restarted.list()).toMatchObject({ status: "ok", items: [expect.not.objectContaining({ templateRunError: expect.anything() }), expect.objectContaining({ id: broken, templateRunError: "invalid-template-run" })] });
  expect(await restarted.getRun(broken)).toEqual({ status: "invalid" });
  const mutate = vi.fn((value: WorkflowRunRecord) => value);
  expect(await restarted.updateRun(broken, "run-broken", mutate)).toEqual({ status: "invalid" });
  expect(mutate).not.toHaveBeenCalled();
  expect(await restarted.updateRun(working, "run-working", value => ({ ...value, stageRuns: [] }))).toMatchObject({ status: "stored" });
  expect(await restarted.update(broken, { title: "Renamed" })).toMatchObject({ status: "updated" });
  expect((await readJson(runsPath)).runs[0]).toEqual(file.runs[0]);
});

it("keeps every row listed, marks only started template rows and starts no template run while the run file awaits review", async () => {
  const store = new WorkBoardStore(boardPath);
  const ordinary = await store.create({ title: "Ordinary" });
  if (ordinary.status !== "created") throw new Error("Missing item");
  const id = await templateItem(store);
  const ran = await templateItem(store);
  await store.beginRun(ran, "run-1", "2026-01-01", start());
  const board = await readFile(boardPath, "utf8");
  const runs = await readFile(runsPath, "utf8");
  holdRunFileForReview();
  const listed = await store.list();
  if (listed.status !== "ok") throw new Error("Missing list");
  expect(listed.items.map(item => [item.id, item.templateRunError])).toEqual([[ran, "template-runs-pending-review"], [id, undefined], [ordinary.itemId, undefined]]);
  for (const unmarked of [ordinary.itemId, id]) expect((await store.get(unmarked) as { item: object }).item).not.toHaveProperty("templateRunError");
  expect(await store.getRun(ran)).toEqual({ status: "pending-review" });
  expect(await store.get(ran)).toMatchObject({ status: "found", item: { templateRunError: "template-runs-pending-review" } });
  expect(await store.beginRun(id, "run-2", "2026-01-01", start())).toMatchObject({ status: "invalid", reason: "template-runs-pending-review" });
  const mutate = vi.fn((value: WorkflowRunRecord) => value);
  expect(await store.updateRun(ran, "run-1", mutate)).toEqual({ status: "pending-review" });
  expect(mutate).not.toHaveBeenCalled();
  await expect(store.load()).resolves.toBeUndefined();
  await expect(store.reconcileInterruptedRuns()).resolves.toBe(0);
  vi.restoreAllMocks();
  expect(await readFile(runsPath, "utf8")).toBe(runs);
  expect((await readJson(boardPath)).items.find((item: { id: number }) => item.id === id)).toEqual(JSON.parse(board).items.find((item: { id: number }) => item.id === id));
  const recovered = await store.list();
  if (recovered.status !== "ok") throw new Error("Missing list");
  expect(recovered.items.map(item => item.templateRunError)).toEqual([undefined, undefined, undefined]);
});
