import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WorkBoardStore } from "../work-board-store.js";
import * as homeTrust from "../../shared/ave-home-trust.js";
import type { TemplateRunStart } from "../../shared/workflow-template-types.js";

let dir: string;
let boardPath: string;
let runsPath: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "board-row-id-floor-")); boardPath = join(dir, "board.json"); runsPath = join(dir, "workflow-runs.json"); });
afterEach(async () => { vi.restoreAllMocks(); await rm(dir, { recursive: true, force: true }); });

const row = (id: number) => ({ id, title: `Work ${id}`, status: "planned", priority: "medium", created_at: "2026-01-01", updated_at: "2026-01-01" });
const board = (nextId: number, ids: number[]) => JSON.stringify({ version: 1, nextId, items: ids.map(row) });
const runFile = async () => JSON.parse(await readFile(runsPath, "utf8"));
const refused = { status: "invalid", reason: "work-item-ids-unavailable" };
async function add(store: WorkBoardStore, templateId?: string): Promise<number> {
  const created = await store.create({ title: "Work", ...(templateId ? { templateId } : {}) });
  if (created.status !== "created") throw new Error(`no row was added: ${JSON.stringify(created)}`);
  return created.itemId;
}
/** Reads of the run file get `input`; every other path reads as usual. */
function holdRunFile(input: () => Promise<homeTrust.AveHomeInput>) {
  const read = homeTrust.readAveHomeInput;
  return vi.spyOn(homeTrust, "readAveHomeInput").mockImplementation(target => target === runsPath ? input() : read(target));
}
const runFileUnreadable: [string, () => Promise<homeTrust.AveHomeInput>][] = [
  ["cannot be read", async () => { throw Object.assign(new Error("EIO: i/o error, read"), { code: "EIO" }); }],
  ["awaits review", async () => ({ status: "untrusted", bytes: Buffer.alloc(0), reason: "changed" })],
  ["is past its read limit", async () => { throw new homeTrust.AveHomeInputSizeLimitError("too large"); }],
  ["does not parse", async () => ({ status: "trusted", bytes: Buffer.from("{") })],
];

for (const [how, input] of runFileUnreadable) {
  it(`while the run file ${how}, a board restored to an older copy adds no row and is left as it is; once it reads, the id is above every id issued`, async () => {
    const store = new WorkBoardStore(boardPath);
    await add(store);
    const older = await readFile(boardPath, "utf8");
    await add(store);
    await add(store);
    await writeFile(boardPath, older);
    const held = holdRunFile(input);
    const next = new WorkBoardStore(boardPath);
    expect(await next.create({ title: "Work" })).toEqual(refused);
    // The board's own counter is never used in its place.
    expect(await readFile(boardPath, "utf8")).toBe(older);
    held.mockRestore();
    expect(await add(next)).toBe(4);
  });

  it(`while the run file ${how}, a readable board with every row still on it adds no row either`, async () => {
    await writeFile(boardPath, board(6, [1, 2, 3, 4, 5]));
    const held = holdRunFile(input);
    const store = new WorkBoardStore(boardPath);
    await store.load();
    expect(await store.create({ title: "Work" })).toEqual(refused);
    expect(JSON.parse(await readFile(boardPath, "utf8"))).toEqual(JSON.parse(board(6, [1, 2, 3, 4, 5])));
    held.mockRestore();
    expect(await add(store)).toBe(6);
  });
}

it("a run file a create cannot store the new floor in adds no row", async () => {
  await writeFile(runsPath, `${JSON.stringify({ version: 1, rowIdFloor: Number.MAX_SAFE_INTEGER, runs: [] })}\n`);
  const store = new WorkBoardStore(boardPath);
  expect(await store.create({ title: "Work" })).toEqual(refused);
  expect(existsSync(boardPath)).toBe(false);
});

it("after five rows were added and the board deleted, a delete while the run list fails leaves the next row at 6", async () => {
  const store = new WorkBoardStore(boardPath);
  for (let i = 0; i < 5; i += 1) await add(store);
  expect((await runFile()).rowIdFloor).toBe(5);
  await rm(boardPath);
  const list = vi.spyOn(store.runs, "list").mockRejectedValue(new Error("EIO: i/o error, read"));
  expect((await store.remove(3)).status).not.toBe("deleted");
  list.mockRestore();
  expect(await add(store)).toBe(6);
  expect(await add(new WorkBoardStore(boardPath))).toBe(7);
});

it("a five-row board with no run file is read at load, so a new row after the board is deleted is 6", async () => {
  await writeFile(boardPath, board(6, [1, 2, 3, 4, 5]));
  await new WorkBoardStore(boardPath).load();
  await rm(boardPath);
  expect(await add(new WorkBoardStore(boardPath))).toBe(6);
});

it("a board whose nextId was set back by hand adds rows above every id it shows and every id issued", async () => {
  const store = new WorkBoardStore(boardPath);
  for (let i = 0; i < 5; i += 1) await add(store);
  expect(await store.remove(5)).toMatchObject({ status: "deleted" });
  await writeFile(boardPath, board(2, [1, 2, 3]));
  expect(await add(new WorkBoardStore(boardPath))).toBe(6);
  await writeFile(boardPath, board(1, [9]));
  expect(await add(new WorkBoardStore(boardPath))).toBe(10);
});

it("never issues again the id of a row that was added and then deleted", async () => {
  const store = new WorkBoardStore(boardPath);
  await add(store);
  const last = await add(store);
  expect(await store.remove(last)).toMatchObject({ status: "deleted" });
  expect(await add(store)).toBe(last + 1);
  expect(await add(new WorkBoardStore(boardPath))).toBe(last + 2);
});

it("a run file restored to an older copy takes the floor from the board's ids", async () => {
  const store = new WorkBoardStore(boardPath);
  await add(store);
  const older = await readFile(runsPath, "utf8");
  for (let i = 0; i < 4; i += 1) await add(store);
  await writeFile(runsPath, older);
  expect(await add(new WorkBoardStore(boardPath))).toBe(6);
});

it("starts ids again from 1 once both files are gone: nothing is left that shows an id was issued", async () => {
  const store = new WorkBoardStore(boardPath);
  await add(store);
  await add(store);
  await rm(boardPath);
  await rm(runsPath);
  expect(await add(new WorkBoardStore(boardPath))).toBe(1);
});

it("reads a run file without a floor as one at its highest run row, and stores the floor at the first load", async () => {
  const pin = { templateId: "template-1", version: 1, graphHash: "b".repeat(64) };
  const store = new WorkBoardStore(boardPath);
  const id = await add(store, pin.templateId);
  const start: TemplateRunStart = { ...pin, source: { kind: "local-create-and-run", pin }, stageRuns: [{ stageId: "plan", attempt: 1, status: "waiting" }] };
  expect(await store.beginRun(id, "run-1", "2026-01-01T00:00:00.000Z", start)).toMatchObject({ status: "updated" });
  const { rowIdFloor: _, ...legacy } = await runFile();
  await writeFile(runsPath, JSON.stringify(legacy));
  await rm(boardPath);
  expect(await add(new WorkBoardStore(boardPath))).toBe(id + 1);

  await writeFile(runsPath, JSON.stringify({ version: 1, runs: [] }));
  await writeFile(boardPath, board(4, [1, 2, 3]));
  await new WorkBoardStore(boardPath).load();
  expect(await runFile()).toEqual({ version: 1, rowIdFloor: 3, runs: [] });
});

for (const floor of [-1, "1", 1.5, null]) {
  it(`a run file whose floor is ${JSON.stringify(floor)} cannot be read: no row is added and the file is left as it is`, async () => {
    const text = JSON.stringify({ version: 1, rowIdFloor: floor, runs: [] });
    await writeFile(runsPath, text);
    const store = new WorkBoardStore(boardPath);
    await expect(store.runs.list()).rejects.toThrow("invalid-template-run");
    expect(await store.create({ title: "Work" })).toEqual(refused);
    expect(await readFile(runsPath, "utf8")).toBe(text);
    expect(existsSync(boardPath)).toBe(false);
  });
}

it("prunes the settled runs a readable board emptied by hand no longer lists, and none while the board does not parse", async () => {
  const pin = { templateId: "template-1", version: 1, graphHash: "b".repeat(64) };
  const start: TemplateRunStart = { ...pin, source: { kind: "local-create-and-run", pin }, stageRuns: [{ stageId: "plan", attempt: 1, status: "waiting" }] };
  const store = new WorkBoardStore(boardPath);
  const id = await add(store, pin.templateId);
  expect(await store.beginRun(id, "run-1", "2026-01-01T00:00:00.000Z", start)).toMatchObject({ status: "updated" });
  expect(await store.setRunResult(id, { runStatus: "completed" })).toMatchObject({ status: "updated" });
  expect(await store.updateRun(id, "run-1", run => ({ ...run, settled: { status: "completed", at: "2026-01-02T00:00:00.000Z" } }))).toMatchObject({ status: "stored" });
  await writeFile(boardPath, "{ not json");
  await store.pruneSettledRuns();
  expect((await runFile()).runs).toHaveLength(1);
  await writeFile(boardPath, board(1, []));
  await store.pruneSettledRuns();
  expect(await runFile()).toEqual({ version: 1, rowIdFloor: id, runs: [] });
  expect(await add(new WorkBoardStore(boardPath))).toBe(id + 1);
});
