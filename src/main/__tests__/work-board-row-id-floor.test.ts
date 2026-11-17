import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
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

it("a floor at the safe-integer limit refuses every create with its own code and adds no row", async () => {
  await writeFile(runsPath, `${JSON.stringify({ version: 1, rowIdFloor: Number.MAX_SAFE_INTEGER, runs: [] })}\n`);
  const store = new WorkBoardStore(boardPath);
  expect(await store.create({ title: "Work" })).toEqual({ status: "invalid", reason: "work-item-ids-exhausted" });
  expect(existsSync(boardPath)).toBe(false);
});

it("a board row at the safe-integer limit refuses the next create with its own code, and removing it does not lower the floor", async () => {
  await writeFile(boardPath, JSON.stringify({ version: 1, nextId: 2, items: [row(1), row(Number.MAX_SAFE_INTEGER)] }));
  const store = new WorkBoardStore(boardPath);
  expect(await store.create({ title: "Work" })).toEqual({ status: "invalid", reason: "work-item-ids-exhausted" });
  expect(await store.remove(Number.MAX_SAFE_INTEGER)).toMatchObject({ status: "deleted" });
  expect(await new WorkBoardStore(boardPath).create({ title: "Work" })).toEqual({ status: "invalid", reason: "work-item-ids-exhausted" });
  expect((await runFile()).rowIdFloor).toBe(Number.MAX_SAFE_INTEGER);
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

const unreadBoards: [string, () => Promise<void>][] = [
  ["does not parse", () => writeFile(boardPath, "{ not json")],
  ["is missing", () => rm(boardPath)],
  ["has no items list", () => writeFile(boardPath, JSON.stringify({ version: 1, nextId: 9, items: {} }))],
  ["is null", () => writeFile(boardPath, "null")],
];
for (const [how, spoil] of unreadBoards) {
  it(`a create over a board file that ${how} marks every id below its row unknown: a run on one is lost, never gone, and the mark stays until that run is over`, async () => {
    const pin = { templateId: "template-1", version: 1, graphHash: "b".repeat(64) };
    const start: TemplateRunStart = { ...pin, source: { kind: "local-create-and-run", pin }, stageRuns: [{ stageId: "plan", attempt: 1, status: "waiting" }] };
    const store = new WorkBoardStore(boardPath);
    const id = await add(store, pin.templateId);
    await add(store);
    await add(store);
    expect(await store.beginRun(id, "run-1", "2026-01-01T00:00:00.000Z", start)).toMatchObject({ status: "updated" });
    await spoil();
    expect(await add(store)).toBe(4);
    expect(JSON.parse(await readFile(boardPath, "utf8")).unknownBelow).toBe(4);
    for (const reader of [store, new WorkBoardStore(boardPath)]) {
      const standing = await reader.runRowsOnDisk();
      expect([1, 2, 3].map(itemId => standing?.({ itemId, runId: "run-1" }))).toEqual(["lost", "lost", "lost"]);
    }
    expect(await store.updateRun(id, "run-1", run => ({ ...run, settled: { status: "error", at: "2026-01-02T00:00:00.000Z" } }))).toEqual({ status: "row-lost" });
    // While that run is not over, every write and prune keeps the mark; a row at or above it the board no longer lists is gone.
    await add(store);
    expect(await store.update(4, { title: "Renamed" })).toMatchObject({ status: "updated" });
    expect(await store.remove(4)).toMatchObject({ status: "deleted" });
    await store.pruneSettledRuns();
    expect(JSON.parse(await readFile(boardPath, "utf8")).unknownBelow).toBe(4);
    const standing = await store.runRowsOnDisk();
    expect(standing?.({ itemId: 2, runId: "run-1" })).toBe("lost");
    expect(standing?.({ itemId: 4, runId: "run-1" })).toBe("gone");
    // Once it is over, the next prune drops the mark, and the run's record goes as a gone row's run does.
    expect(await store.runs.update("run-1", run => ({ ...run, settled: { status: "error", at: "2026-01-02T00:00:00.000Z" } }))).toMatchObject({ status: "stored" });
    await store.pruneSettledRuns();
    expect(JSON.parse(await readFile(boardPath, "utf8"))).not.toHaveProperty("unknownBelow");
    expect((await runFile()).runs).toEqual([]);
    expect((await store.runRowsOnDisk())?.({ itemId: 2, runId: "run-1" })).toBe("gone");
  });
}

it("lost run records do not pile up over repeated damage: each mark is dropped once the runs below it are over, and their records with it", async () => {
  const pin = { templateId: "template-1", version: 1, graphHash: "b".repeat(64) };
  const start: TemplateRunStart = { ...pin, source: { kind: "local-create-and-run", pin }, stageRuns: [{ stageId: "plan", attempt: 1, status: "waiting" }] };
  const store = new WorkBoardStore(boardPath);
  for (const cycle of ["first", "second", "third"]) {
    const id = await add(store, pin.templateId);
    expect(await store.beginRun(id, `run-${cycle}`, "2026-01-01T00:00:00.000Z", start)).toMatchObject({ status: "updated" });
    await writeFile(boardPath, "{ not json");
    const after = await add(store);
    expect(JSON.parse(await readFile(boardPath, "utf8")).unknownBelow).toBe(after);
    expect((await store.runRowsOnDisk())?.({ itemId: id, runId: `run-${cycle}` })).toBe("lost");
    expect(await store.runs.update(`run-${cycle}`, run => ({ ...run, settled: { status: "error", at: "2026-01-02T00:00:00.000Z" } }))).toMatchObject({ status: "stored" });
    await store.pruneSettledRuns();
    expect(JSON.parse(await readFile(boardPath, "utf8"))).not.toHaveProperty("unknownBelow");
    expect((await runFile()).runs).toEqual([]);
  }
});

it("keeps the mark while the run file shows an entry that does not read as a run, awaits review or cannot be read", async () => {
  const mark = async () => JSON.parse(await readFile(boardPath, "utf8")).unknownBelow;
  await writeFile(boardPath, JSON.stringify({ version: 1, nextId: 6, unknownBelow: 5, items: [5].map(row) }));
  await writeFile(runsPath, JSON.stringify({ version: 1, rowIdFloor: 5, runs: [{ runId: "run-1", itemId: "two" }] }));
  const store = new WorkBoardStore(boardPath);
  await store.pruneSettledRuns();
  expect(await mark()).toBe(5);
  await writeFile(runsPath, JSON.stringify({ version: 1, rowIdFloor: 5, runs: [] }));
  for (const [, input] of runFileUnreadable) {
    const held = holdRunFile(input);
    await store.pruneSettledRuns().catch(() => undefined);
    expect(await mark()).toBe(5);
    held.mockRestore();
  }
  await store.pruneSettledRuns();
  expect(JSON.parse(await readFile(boardPath, "utf8"))).not.toHaveProperty("unknownBelow");
});

it("drops the mark once the user discards the last entry of the run file that does not read as a run, the run file kept as it was first", async () => {
  const mark = async () => JSON.parse(await readFile(boardPath, "utf8")).unknownBelow;
  const sha = (text: string) => createHash("sha256").update(text).digest("hex");
  await writeFile(boardPath, JSON.stringify({ version: 1, nextId: 6, unknownBelow: 5, items: [5].map(row) }));
  const entries = [{ runId: "run-3", itemId: 3 }, null];
  const text = JSON.stringify({ version: 1, rowIdFloor: 5, runs: entries });
  await writeFile(runsPath, text);
  const store = new WorkBoardStore(boardPath);
  const listed = await store.list();
  const cards = listed.status === "ok" ? listed.unreadableRuns ?? [] : [];
  expect(cards).toEqual([{ itemId: 3, position: 0, hash: sha(JSON.stringify(entries[0])) }, { position: 1, hash: sha("null") }]);
  expect(await store.discardUnreadableRun(cards[1], () => true)).toEqual({ status: "deleted" });
  expect(await mark()).toBe(5);
  expect(await store.discardUnreadableRun(cards[1], () => true)).toEqual({ status: "invalid", reason: "work-board-row-changed" });
  expect(await store.discardUnreadableRun(cards[0], () => true)).toEqual({ status: "deleted" });
  expect(JSON.parse(await readFile(boardPath, "utf8"))).not.toHaveProperty("unknownBelow");
  expect((await runFile()).runs).toEqual([]);
  expect(await readFile(`${runsPath}.invalid-runs-${sha(text)}.bak`, "utf8")).toBe(text);
  expect(await store.list()).not.toHaveProperty("unreadableRuns");
});

it("drops only the mark it judged: one raised while the runs were read stays until a prune judges it", async () => {
  await writeFile(boardPath, JSON.stringify({ version: 1, nextId: 6, unknownBelow: 5, items: [5].map(row) }));
  await writeFile(runsPath, JSON.stringify({ version: 1, rowIdFloor: 5, runs: [] }));
  const store = new WorkBoardStore(boardPath);
  const judge = store.runs.openRunBelow.bind(store.runs);
  vi.spyOn(store.runs, "openRunBelow").mockImplementationOnce(async id => {
    const open = await judge(id);
    await writeFile(boardPath, JSON.stringify({ version: 1, nextId: 9, unknownBelow: 8, items: [5, 8].map(row) }));
    return open;
  });
  await store.pruneSettledRuns();
  expect(JSON.parse(await readFile(boardPath, "utf8")).unknownBelow).toBe(8);
  await store.pruneSettledRuns();
  expect(JSON.parse(await readFile(boardPath, "utf8"))).not.toHaveProperty("unknownBelow");
});

it("a create on a home with neither file marks no id unknown: none was issued before", async () => {
  expect(await add(new WorkBoardStore(boardPath))).toBe(1);
  expect(JSON.parse(await readFile(boardPath, "utf8"))).not.toHaveProperty("unknownBelow");
});

it.each([["a string", "x"], ["zero", 0], ["a fraction", 2.5], ["past the safe-integer limit", 2 ** 53], ["negative", -3], ["null", null]])("a board whose unknownBelow is %s reads it as the largest safe integer: no row it does not list is gone, below or above its next id, and the file is kept as it was before the mark is rewritten", async (_, unknownBelow) => {
  const text = JSON.stringify({ version: 1, nextId: 6, unknownBelow, items: [1, 2, 4, 5].map(row) });
  await writeFile(boardPath, text);
  const store = new WorkBoardStore(boardPath);
  const standing = await store.runRowsOnDisk();
  expect([3, 6, 100, Number.MAX_SAFE_INTEGER - 1].map(itemId => standing?.({ itemId, runId: "run-1" }))).toEqual(["lost", "lost", "lost", "lost"]);
  expect(await add(store)).toBe(6);
  expect(JSON.parse(await readFile(boardPath, "utf8")).unknownBelow).toBe(Number.MAX_SAFE_INTEGER);
  expect(await readFile(`${boardPath}.invalid-rows-${createHash("sha256").update(text).digest("hex")}.bak`, "utf8")).toBe(text);
});
