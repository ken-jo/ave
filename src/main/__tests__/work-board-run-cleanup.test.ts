import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
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
const over = { status: "completed", at: "2026-01-02T00:00:00.000Z" } as const;
/** A whole run: started, ended on its row, and marked over in its record. */
async function settled(store: WorkBoardStore, id: number, runId: string, templateId?: string): Promise<void> {
  await begin(store, id, runId, templateId);
  expect(await store.setRunResult(id, { runStatus: "completed" })).toMatchObject({ status: "updated" });
  expect(await store.updateRun(id, runId, run => ({ ...run, settled: over }))).toMatchObject({ status: "stored" });
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

it("keeps the unsettled run of a deleted row until its record says it is over", async () => {
  const store = new WorkBoardStore(boardPath);
  const gone = await templateItem(store);
  const other = await templateItem(store);
  await settled(store, gone, "gone-settled");
  await begin(store, gone, "gone-live");

  expect(await store.remove(gone)).toMatchObject({ status: "deleted" });
  expect(await runIds()).toEqual(["gone-live"]);
  await settled(store, other, "other-1");
  expect(await runIds()).toEqual(["gone-live", "other-1"]);

  expect(await store.runs.update("gone-live", run => ({ ...run, settled: { status: "cancelled", at: over.at } }))).toMatchObject({ status: "stored" });
  await store.pruneSettledRuns();
  expect(await runIds()).toEqual(["other-1"]);
});

it("shows where a run's row stands on the readable board on disk, and nothing while that file shows nothing", async () => {
  const store = new WorkBoardStore(boardPath);
  const deleted = await templateItem(store);
  const listed = await templateItem(store);
  await begin(store, listed, "run-listed");
  await begin(store, listed, "run-newer");
  expect(await store.remove(deleted)).toMatchObject({ status: "deleted" });
  const standing = await store.runRowsOnDisk();
  expect(standing?.({ itemId: deleted, runId: "run-deleted" })).toBe("gone");
  expect(standing?.({ itemId: listed, runId: "run-newer" })).toBe("named");
  expect(standing?.({ itemId: listed, runId: "run-listed" })).toBe("moved");
  expect(standing?.({ itemId: listed, runId: "run-other" })).toBe("unnamed");
  const file = JSON.parse(await readFile(boardPath, "utf8"));
  file.items.push({ id: deleted, title: "", status: "planned" });
  await writeFile(boardPath, JSON.stringify(file));
  expect((await store.runRowsOnDisk())?.({ itemId: deleted, runId: "run-deleted" })).toBe("unreadable");
  await writeFile(boardPath, "{");
  expect(await store.runRowsOnDisk()).toBeUndefined();
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

it("never removes a run whose record is not settled, whatever its row showed and whichever process started it", async () => {
  const first = new WorkBoardStore(boardPath);
  const gone = await templateItem(first);
  const other = await templateItem(first);
  await begin(first, gone, "gone-unsettled");
  expect(await first.setRunResult(gone, { runStatus: "completed" })).toMatchObject({ status: "updated" });
  await first.remove(gone);
  expect(await runIds()).toEqual(["gone-unsettled"]);

  const restarted = new WorkBoardStore(boardPath);
  await begin(restarted, other, "other-1");
  await restarted.pruneSettledRuns();
  expect(await runIds()).toEqual(["gone-unsettled", "other-1"]);
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
  expect(await runIds()).toEqual(listed);
});

it("keeps every run while the board file cannot be read", async () => {
  const store = new WorkBoardStore(boardPath);
  await settled(store, await templateItem(store), "run-1");
  await settled(store, await templateItem(store), "run-2");
  await writeFile(boardPath, "{");

  const restarted = new WorkBoardStore(boardPath);
  await restarted.pruneSettledRuns();
  expect(await runIds()).toEqual(["run-1", "run-2"]);
});

/** Records each run the prune removes, with whether its record was settled at that point. */
function watchRemovals(store: WorkBoardStore): { runId: string; settled: boolean }[] {
  const removed: { runId: string; settled: boolean }[] = [];
  const prune = store.runs.prune.bind(store.runs);
  vi.spyOn(store.runs, "prune").mockImplementation(retain => prune(run => {
    const next = retain(run);
    if (next === null) removed.push({ runId: run.runId, settled: run.settled !== undefined });
    return next;
  }));
  return removed;
}
/** The board write fails with EIO, after the real write when `landed`. */
function failBoardWrite(landed: boolean): void {
  const write = storage.writeFileAtomicAtPath;
  vi.spyOn(storage, "writeFileAtomicAtPath").mockImplementation(async (path, data) => {
    if (path !== boardPath) return write(path, data);
    if (landed) await write(path, data);
    throw Object.assign(new Error("EIO: i/o error, write"), { code: "EIO" });
  });
}

it("settles and then removes the run record when the row write before the replacement fails", async () => {
  const store = new WorkBoardStore(boardPath);
  const id = await templateItem(store);
  await settled(store, id, "run-1");
  const removed = watchRemovals(store);
  failBoardWrite(false);
  await expect(store.beginRun(id, "run-orphan", "2026-01-01T00:00:00.000Z", start())).rejects.toMatchObject({ code: "EIO" });
  vi.restoreAllMocks();

  expect(removed).toEqual([{ runId: "run-orphan", settled: true }]);
  expect(await runIds()).toEqual(["run-1"]);
  expect(await new WorkBoardStore(boardPath).getRun(id)).toMatchObject({ status: "found", run: { runId: "run-1" } });
  await begin(store, id, "run-retry");
  expect(await runIds()).toEqual(["run-1", "run-retry"]);
});

it("keeps the run record when the row write fails after the board was replaced", async () => {
  const store = new WorkBoardStore(boardPath);
  const id = await templateItem(store);
  const removed = watchRemovals(store);
  failBoardWrite(true);
  await expect(store.beginRun(id, "run-landed", "2026-01-01T00:00:00.000Z", start())).rejects.toMatchObject({ code: "EIO" });
  vi.restoreAllMocks();

  expect(removed).toEqual([]);
  const reopened = new WorkBoardStore(boardPath);
  expect(await reopened.getRun(id)).toMatchObject({ status: "found", run: { runId: "run-landed" } });
  expect(await reopened.runs.list()).toMatchObject({ status: "found", runs: [{ runId: "run-landed" }] });
  expect((await reopened.runs.get("run-landed") as { run: object }).run).not.toHaveProperty("settled");
});

it("keeps the run record unsettled when the board cannot be read back after a failed row write", async () => {
  const store = new WorkBoardStore(boardPath);
  const id = await templateItem(store);
  const write = storage.writeFileAtomicAtPath;
  const read = homeTrust.readAveHomeInput;
  let failed = false;
  vi.spyOn(storage, "writeFileAtomicAtPath").mockImplementation(async (path, data) => {
    if (path !== boardPath) return write(path, data);
    failed = true;
    throw Object.assign(new Error("EIO: i/o error, write"), { code: "EIO" });
  });
  vi.spyOn(homeTrust, "readAveHomeInput").mockImplementation(async path => {
    if (failed && path === boardPath) throw Object.assign(new Error("EIO: i/o error, read"), { code: "EIO" });
    return read(path);
  });
  await expect(store.beginRun(id, "run-unknown", "2026-01-01T00:00:00.000Z", start())).rejects.toMatchObject({ message: "EIO: i/o error, write" });
  vi.restoreAllMocks();

  expect(await store.runs.list()).toMatchObject({ status: "found", runs: [{ runId: "run-unknown" }] });
  expect((await store.runs.get("run-unknown") as { run: object }).run).not.toHaveProperty("settled");
});

it("keeps a run record whose row write never happened until it is settled", async () => {
  const store = new WorkBoardStore(boardPath);
  const id = await templateItem(store);
  const pin = pinOf("template-1");
  // What a process that stopped between the two writes leaves behind.
  expect(await store.runs.put({ runId: "run-orphan", itemId: id, pin, runStartedBy: { kind: "local-create-and-run", pin }, startedAt: "2026-01-01T00:00:00.000Z", stageRuns: [] })).toMatchObject({ status: "stored" });

  const restarted = new WorkBoardStore(boardPath);
  expect(await restarted.getRun(id)).toEqual({ status: "not-found" });
  await begin(restarted, id, "run-retry");
  expect(await runIds()).toEqual(["run-orphan", "run-retry"]);
  expect(await restarted.runs.update("run-orphan", run => ({ ...run, settled: { status: "error", at: over.at } }))).toMatchObject({ status: "stored" });
  await restarted.pruneSettledRuns();
  expect(await runIds()).toEqual(["run-retry"]);
});

const stageRunsOf = (char: string) => Array.from({ length: 12 }, (_, index) => ({
  stageId: `stage-${index}`, attempt: 1, status: "passed" as const, startedAt: over.at, endedAt: over.at, output: char.repeat(48_000), resultHash: "a".repeat(64), outputHash: "c".repeat(64),
  requestedOutputs: [{ id: "report", decl: { kind: "upload" as const, toolName: "deliver", owner: "plugin" as const, ownerId: "media" }, args: "{}", summary: "s".repeat(400) }],
}));

it("keeps the full record only for each row's current run and a summary for its history", async () => {
  const store = new WorkBoardStore(boardPath);
  const id = await templateItem(store);
  const stageRuns = stageRunsOf("x");
  for (let run = 1; run <= 20; run++) {
    await begin(store, id, `run-${run}`);
    expect(await store.updateRun(id, `run-${run}`, value => ({ ...value, stageRuns, settled: over }))).toMatchObject({ status: "stored" });
    expect(await store.setRunResult(id, { runStatus: "completed" })).toMatchObject({ status: "updated" });
  }
  expect((await store.get(id) as { item: { runHistory: unknown[] } }).item.runHistory).toHaveLength(20);
  expect((await stat(runsPath)).size).toBeLessThan(1024 * 1024);
  const all = await entries() as unknown as { runId: string; settled: object; stageRuns: object[] }[];
  expect(all.map(entry => entry.runId)).toEqual(Array.from({ length: 20 }, (_, index) => `run-${index + 1}`));
  expect(all[0]).toEqual({ ...all[0], settled: over, stageRuns: stageRuns.map(({ stageId, attempt, status, startedAt, endedAt, resultHash, outputHash }) => ({ stageId, attempt, status, startedAt, endedAt, resultHash, outputHash })) });
  expect(all[0].stageRuns.every(stage => (stage as { outputHash?: string }).outputHash === "c".repeat(64))).toBe(true);
  expect(Object.keys(all[0]).sort()).toEqual(["itemId", "pin", "runId", "runStartedBy", "settled", "stageRuns", "startedAt"]);
  expect(await store.getRun(id)).toMatchObject({ status: "found", run: { runId: "run-20", stageRuns } });
});

it("refuses a run write that would pass the read limit, and a new run or a deleted row makes room", async () => {
  const store = new WorkBoardStore(boardPath);
  const stageRuns = stageRunsOf("가");
  const fill = async (id: number, runId: string) => (await store.updateRun(id, runId, value => ({ ...value, stageRuns }))).status;
  const rows: number[] = [];
  const filled: string[] = [];
  // Every run here is its row's current run, so none shrinks: ten of this size do not fit.
  for (let row = 1; row <= 10; row++) {
    const id = await templateItem(store);
    rows.push(id);
    await settled(store, id, `run-${id}`);
    filled.push(await fill(id, `run-${id}`));
  }
  expect(filled).toEqual([...Array<string>(9).fill("stored"), "too-large"]);
  expect((await stat(runsPath)).size).toBeLessThanOrEqual(16 * 1024 * 1024);
  const last = rows[9];

  await settled(store, rows[0], "newer");
  expect(await fill(last, `run-${last}`)).toBe("stored");
  expect(await fill(rows[0], "newer")).toBe("too-large");
  expect(await store.remove(rows[1])).toMatchObject({ status: "deleted" });
  expect(await fill(rows[0], "newer")).toBe("stored");
}, 180_000);

it("reports a template start the run file has no room for", async () => {
  const store = new WorkBoardStore(boardPath);
  const id = await templateItem(store);
  vi.spyOn(store.runs, "put").mockResolvedValue({ status: "too-large" });
  expect(await store.beginRun(id, "run-1", "2026-01-01T00:00:00.000Z", start())).toMatchObject({ status: "invalid", reason: "template-runs-too-large" });
  expect((await store.get(id) as { item: object }).item).not.toHaveProperty("runId");
});

it("rejects an engine prune when the run file cannot be read", async () => {
  const store = new WorkBoardStore(boardPath);
  await settled(store, await templateItem(store), "run-1");
  const before = await readFile(runsPath, "utf8");
  const read = homeTrust.readAveHomeInput;
  vi.spyOn(homeTrust, "readAveHomeInput").mockImplementation(async path => {
    if (path === runsPath) throw Object.assign(new Error("EIO: i/o error, read"), { code: "EIO" });
    return read(path);
  });
  await expect(store.pruneSettledRuns()).rejects.toMatchObject({ code: "EIO" });
  vi.restoreAllMocks();
  expect(await readFile(runsPath, "utf8")).toBe(before);
});

it("rejects an engine prune when the run file does not parse, and leaves it as it is", async () => {
  const store = new WorkBoardStore(boardPath);
  await settled(store, await templateItem(store), "run-1");
  await writeFile(runsPath, "{");
  await expect(new WorkBoardStore(boardPath).pruneSettledRuns()).rejects.toThrow();
  expect(await readFile(runsPath, "utf8")).toBe("{");
});

it("leaves a run file pending review as it is on an engine prune", async () => {
  const store = new WorkBoardStore(boardPath);
  const gone = await templateItem(store);
  await settled(store, gone, "gone-1");
  const before = await readFile(runsPath, "utf8");
  const read = homeTrust.readAveHomeInput;
  vi.spyOn(homeTrust, "readAveHomeInput").mockImplementation(async path =>
    path === runsPath ? { status: "untrusted", bytes: Buffer.alloc(0), reason: "changed" } : read(path));
  expect(await store.remove(gone)).toMatchObject({ status: "deleted" });
  await expect(store.pruneSettledRuns()).resolves.toBeUndefined();
  vi.restoreAllMocks();
  expect(await readFile(runsPath, "utf8")).toBe(before);
});
