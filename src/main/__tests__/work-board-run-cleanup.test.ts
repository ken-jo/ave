import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WorkBoardStore } from "../work-board-store.js";
import * as storage from "../storage/feature-namespace.js";
import * as homeTrust from "../../shared/ave-home-trust.js";
import type { TemplateRunStart } from "../../shared/workflow-template-types.js";

let dir: string;
let boardPath: string;
let runsPath: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "board-run-cleanup-")); boardPath = join(dir, "board.json"); runsPath = join(dir, "workflow-runs.json"); });
afterEach(async () => { vi.restoreAllMocks(); await rm(dir, { recursive: true, force: true }); });

const pinOf = (templateId: string) => ({ templateId, version: 1, graphHash: "b".repeat(64) });
function start(templateId = "template-1"): TemplateRunStart {
  const pin = pinOf(templateId);
  return { ...pin, source: { kind: "local-create-and-run", pin }, stageRuns: [{ stageId: "plan", attempt: 1, status: "waiting" }] };
}
async function templateItem(store: WorkBoardStore, templateId = "template-1"): Promise<number> {
  const created = await store.create({ title: "Template", templateId });
  if (created.status !== "created") throw new Error("Missing item");
  return created.itemId;
}
async function begin(store: WorkBoardStore, id: number, runId: string, templateId?: string): Promise<void> {
  expect(await store.beginRun(id, runId, "2026-01-01T00:00:00.000Z", start(templateId))).toMatchObject({ status: "updated" });
}
/** A whole run: started, then ended. */
async function settled(store: WorkBoardStore, id: number, runId: string, templateId?: string): Promise<void> {
  await begin(store, id, runId, templateId);
  expect(await store.setRunResult(id, { runStatus: "completed" })).toMatchObject({ status: "updated" });
}
const entries = async (): Promise<{ runId: string }[]> => JSON.parse(await readFile(runsPath, "utf8")).runs;
const runIds = async (): Promise<string[]> => (await entries()).map(entry => entry.runId);

it("removes a deleted row's settled runs and leaves every other row's runs", async () => {
  const store = new WorkBoardStore(boardPath);
  const gone = await templateItem(store);
  const kept = await templateItem(store);
  await settled(store, gone, "gone-1");
  await settled(store, gone, "gone-2");
  await settled(store, kept, "kept-1");
  await begin(store, kept, "kept-2");

  expect(await store.remove(gone)).toMatchObject({ status: "deleted" });
  expect(await runIds()).toEqual(["kept-1", "kept-2"]);
  expect(await store.getRun(kept)).toMatchObject({ status: "found", run: { runId: "kept-2" } });
});

it("keeps the run of a deleted row while it executes, until the engine releases it", async () => {
  const store = new WorkBoardStore(boardPath);
  const gone = await templateItem(store);
  const other = await templateItem(store);
  await settled(store, gone, "gone-settled");
  await begin(store, gone, "gone-live");

  expect(await store.remove(gone)).toMatchObject({ status: "deleted" });
  expect(await runIds()).toEqual(["gone-live"]);
  await settled(store, other, "other-1");
  expect(await runIds()).toEqual(["gone-live", "other-1"]);

  await store.releaseRun("gone-live");
  expect(await runIds()).toEqual(["other-1"]);
});

it("prunes on a later write what an earlier cleanup could not remove", async () => {
  const store = new WorkBoardStore(boardPath);
  const gone = await templateItem(store);
  const other = await templateItem(store);
  await settled(store, gone, "gone-1");
  const read = homeTrust.readAveHomeInput;
  vi.spyOn(homeTrust, "readAveHomeInput").mockImplementation(async path =>
    path === runsPath ? { status: "untrusted", bytes: Buffer.alloc(0), reason: "changed" } : read(path));
  const before = await readFile(runsPath, "utf8");
  expect(await store.remove(gone)).toMatchObject({ status: "deleted" });
  expect(await readFile(runsPath, "utf8")).toBe(before);
  vi.restoreAllMocks();

  await begin(store, other, "other-1");
  expect(await runIds()).toEqual(["other-1"]);
});

it("treats a run left executing by an earlier process as settled once its row is gone", async () => {
  const first = new WorkBoardStore(boardPath);
  const gone = await templateItem(first);
  const other = await templateItem(first);
  await begin(first, gone, "gone-live");
  await first.remove(gone);
  expect(await runIds()).toEqual(["gone-live"]);

  const restarted = new WorkBoardStore(boardPath);
  await begin(restarted, other, "other-1");
  expect(await runIds()).toEqual(["other-1"]);
});

it("never removes or rewrites an entry it cannot read", async () => {
  const store = new WorkBoardStore(boardPath);
  const gone = await templateItem(store);
  const other = await templateItem(store);
  await settled(store, gone, "gone-broken");
  await settled(store, gone, "gone-twice");
  await settled(store, gone, "gone-1");
  const file = JSON.parse(await readFile(runsPath, "utf8"));
  file.runs[0].stageRuns[0].attempt = 4;
  file.runs.push({ ...file.runs[1], startedAt: "2026-02-02T00:00:00.000Z" });
  const quarantined = [file.runs[0], file.runs[1], file.runs[3]];
  await writeFile(runsPath, JSON.stringify(file));

  const restarted = new WorkBoardStore(boardPath);
  expect(await restarted.remove(gone)).toMatchObject({ status: "deleted" });
  expect(await entries()).toEqual(quarantined);
  await begin(restarted, other, "other-1");
  expect((await entries()).slice(0, 3)).toEqual(quarantined);
  expect(await runIds()).toEqual(["gone-broken", "gone-twice", "gone-twice", "other-1"]);
});

it("keeps the runs a row lists in its history and drops the ones it no longer lists", async () => {
  const store = new WorkBoardStore(boardPath);
  const id = await templateItem(store);
  for (let run = 1; run <= 23; run++) await settled(store, id, `run-${run}`);
  const found = await store.get(id);
  if (found.status !== "found") throw new Error("Missing item");
  const listed = (found.item.runHistory ?? []).map(entry => entry.runId);
  expect(listed).toHaveLength(20);
  // The newest write judged the board before its own row write, so the run that write evicted goes with the next one.
  expect(await runIds()).toEqual(["run-3", ...listed]);
  await store.releaseRun("none");
  expect(await runIds()).toEqual(listed);
});

it("keeps every run when the board file was emptied, since no row id was issued by it", async () => {
  const store = new WorkBoardStore(boardPath);
  await settled(store, await templateItem(store), "run-1");
  await settled(store, await templateItem(store), "run-2");
  await writeFile(boardPath, "{");

  const restarted = new WorkBoardStore(boardPath);
  await restarted.releaseRun("none");
  expect(await runIds()).toEqual(["run-1", "run-2"]);
});

it("removes the run record when the row write after it fails", async () => {
  const store = new WorkBoardStore(boardPath);
  const id = await templateItem(store);
  await settled(store, id, "run-1");
  const write = storage.writeFileAtomicAtPath;
  vi.spyOn(storage, "writeFileAtomicAtPath").mockImplementation(async (path, data) => {
    if (path === boardPath) throw Object.assign(new Error("EIO: i/o error, write"), { code: "EIO" });
    return write(path, data);
  });
  await expect(store.beginRun(id, "run-orphan", "2026-01-01T00:00:00.000Z", start())).rejects.toMatchObject({ code: "EIO" });
  vi.restoreAllMocks();

  expect(await runIds()).toEqual(["run-1"]);
  expect(await new WorkBoardStore(boardPath).getRun(id)).toMatchObject({ status: "found", run: { runId: "run-1" } });
  await begin(store, id, "run-retry");
  expect(await runIds()).toEqual(["run-1", "run-retry"]);
});

it("removes on the next start a run record whose row write never happened", async () => {
  const store = new WorkBoardStore(boardPath);
  const id = await templateItem(store);
  const pin = pinOf("template-1");
  // What a process that stopped between the two writes leaves behind.
  expect(await store.runs.put({ runId: "run-orphan", itemId: id, pin, runStartedBy: { kind: "local-create-and-run", pin }, startedAt: "2026-01-01T00:00:00.000Z", stageRuns: [] })).toMatchObject({ status: "stored" });

  const restarted = new WorkBoardStore(boardPath);
  expect(await restarted.getRun(id)).toEqual({ status: "not-found" });
  await begin(restarted, id, "run-retry");
  expect(await runIds()).toEqual(["run-retry"]);
});

it("removes a template's settled runs and keeps the ones still executing or awaited by their row", async () => {
  const first = new WorkBoardStore(boardPath);
  const waiting = await templateItem(first);
  await begin(first, waiting, "waiting-1");

  const store = new WorkBoardStore(boardPath);
  const done = await templateItem(store);
  const live = await templateItem(store);
  const elsewhere = await templateItem(store, "template-2");
  await settled(store, done, "done-1");
  await settled(store, done, "done-2");
  await begin(store, live, "live-1");
  await settled(store, elsewhere, "elsewhere-1", "template-2");

  await store.removeTemplateRuns("template-1");
  expect(await runIds()).toEqual(["waiting-1", "live-1", "elsewhere-1"]);
  expect(await store.getRun(done)).toEqual({ status: "not-found" });
  expect((await store.get(done) as { item: object }).item).not.toHaveProperty("templateRunError");
});
