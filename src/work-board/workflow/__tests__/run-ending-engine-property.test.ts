/** How a template run ends, as a property of the real engine (work-board-run-ending.md): every consumer, over every state the board file and
 * the run file can leave a run in, with and without its delete intent and an unknown marker, and in each failure window. The oracle is this
 * file's own: it derives the class from how the cell built the two files, and the end from the design's consumer table. Each end must come
 * through `settleRun`, and each consumer must have read the oracle's class from `classifyRun`. Boot adoption is a new engine over the same
 * files; live adoption is the running engine adopting again after its boot adoption could not read the run file. */
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { deferred } from "../../../__tests__/support/deferred.js";
import type { RunEndCause } from "../../../main/workflow-run-store.js";
import * as classification from "../../../main/run-classification.js";
import * as homeTrust from "../../../shared/ave-home-trust.js";
import type { TemplateVersion } from "../../../shared/workflow-template-types.js";
import type { RunRecord } from "../run-state.js";
import { stageOf } from "./stage-fixtures.js";
import { stageRunHarness } from "./stage-run-harness.js";

type Harness = Awaited<ReturnType<typeof stageRunHarness>>;
type Class = "live" | "due-delete" | "waiting-delete" | "unreadable" | "orphan" | "lost";
type Ending = "open" | "item-removed" | "orphan" | "lost";
const CONSUMERS = ["boot adoption", "live adoption", "board write", "run write", "reader"] as const;
type Consumer = (typeof CONSUMERS)[number];
const BOARDS = ["named", "gone", "moved", "unnamed", "held elsewhere", "same-id invalid", "written over", "corrupt"] as const;
type BoardState = (typeof BOARDS)[number];
const WINDOWS = ["none", "settle write fails", "run file unreadable"] as const;
type FailureWindow = (typeof WINDOWS)[number];
interface Cell { consumer: Consumer; board: BoardState; intent: boolean; marker: boolean; window: FailureWindow; record?: "unreadable" | "repeated" }

const classifications = new AsyncLocalStorage<Class[]>();
const heldInputs = new Map<string, boolean>();
beforeEach(() => {
  const read = homeTrust.readAveHomeInput;
  vi.spyOn(homeTrust, "readAveHomeInput").mockImplementation(async path => {
    const io = heldInputs.get(path);
    if (io === undefined) return read(path);
    if (io) throw Object.assign(new Error("run file unreadable"), { code: "EIO" });
    return { status: "untrusted", bytes: Buffer.alloc(0), reason: "changed" };
  });
  const classify = classification.classifyRun;
  vi.spyOn(classification, "classifyRun").mockImplementation((...args) => {
    const result = classify(...args);
    classifications.getStore()?.push(result);
    return result;
  });
});
afterEach(() => { vi.restoreAllMocks(); });

/** The design's consumer table, row by row. */
const END: Record<Consumer, Record<Class, Ending>> = {
  "boot adoption": { live: "open", "due-delete": "item-removed", "waiting-delete": "open", unreadable: "open", orphan: "orphan", lost: "lost" },
  "live adoption": { live: "open", "due-delete": "item-removed", "waiting-delete": "open", unreadable: "open", orphan: "orphan", lost: "lost" },
  "board write": { live: "open", "due-delete": "item-removed", "waiting-delete": "open", unreadable: "open", orphan: "orphan", lost: "lost" },
  "run write": { live: "open", "due-delete": "item-removed", "waiting-delete": "open", unreadable: "open", orphan: "orphan", lost: "lost" },
  reader: { live: "open", "due-delete": "item-removed", "waiting-delete": "open", unreadable: "open", orphan: "open", lost: "open" },
};
const STATUS: Record<Exclude<Ending, "open">, string> = { "item-removed": "cancelled", orphan: "cancelled", lost: "error" };

/** What the cell's board file shows of the run's row, from how the cell built it. */
function boardFacts(board: BoardState): { readable: boolean; listed: boolean; names: boolean; inHistory: boolean; held: boolean; sameIdInvalid: boolean; writtenOver: boolean } {
  const none = { readable: true, listed: false, names: false, inHistory: false, held: false, sameIdInvalid: false, writtenOver: false };
  switch (board) {
    case "named": return { ...none, listed: true, names: true, held: true };
    case "gone": return none;
    case "moved": return { ...none, listed: true, inHistory: true, held: true };
    case "unnamed": return { ...none, listed: true };
    case "held elsewhere": return { ...none, held: true };
    case "same-id invalid": return { ...none, sameIdInvalid: true };
    case "written over": return { ...none, writtenOver: true };
    case "corrupt": return { ...none, readable: false };
  }
}

/** The class, by the design: a marker is decided first (the board lists the row: the delete did not land, intent and marker go; a readable
 * board without it: only the marker goes; a board that shows nothing keeps it), then the classifier table is read in its order. */
function oracle(cell: Cell): { cls: Class; intent: boolean; marker: boolean } {
  const b = boardFacts(cell.board);
  let { intent, marker } = cell;
  if (marker && b.readable) {
    if (b.listed) intent = false;
    marker = false;
  }
  if (cell.record) return { cls: "unreadable", intent: false, marker };
  if (!b.readable || marker) return { cls: "unreadable", intent, marker };
  if (intent) return { cls: b.held || b.listed || b.sameIdInvalid ? "waiting-delete" : "due-delete", intent, marker };
  if (b.listed) return { cls: b.names ? "live" : b.inHistory ? "orphan" : "lost", intent, marker };
  if (b.sameIdInvalid || b.held) return { cls: "unreadable", intent, marker };
  return { cls: b.writtenOver ? "lost" : "orphan", intent, marker };
}

const runsPath = (h: Harness) => join(h.dir, "workflow-runs.json");
/** The run's row and the run file as the cell leaves them, written by hand. */
function leave(h: Harness, cell: Cell, at: { id: number; runId: string; holder: number }): void {
  const file = JSON.parse(readFileSync(h.boardPath, "utf8")) as { items: Record<string, unknown>[]; unknownBelow?: number };
  const row = file.items.find(r => r.id === at.id) as Record<string, unknown>;
  const others = file.items.filter(r => r !== row);
  const holder = others.find(r => r.id === at.holder) as Record<string, unknown>;
  switch (cell.board) {
    case "named": break;
    case "gone": file.items = others; break;
    // The row's history already holds the run: its start wrote it there.
    case "moved": row.runId = "run-elsewhere"; break;
    case "unnamed":
      delete row.runId;
      row.runHistory = (row.runHistory as { runId?: unknown }[] | undefined)?.filter(entry => entry.runId !== at.runId);
      break;
    case "held elsewhere": file.items = others; holder.detail = at.runId; break;
    case "same-id invalid": file.items = [...others, { id: at.id, title: 7 }]; break;
    case "written over": file.items = others; file.unknownBelow = at.id + 1; break;
    case "corrupt": break;
  }
  writeFileSync(h.boardPath, cell.board === "corrupt" ? "{" : JSON.stringify(file));
  const runs = JSON.parse(readFileSync(runsPath(h), "utf8")) as Record<string, unknown>;
  if (cell.record) {
    const records = runs.runs as Record<string, unknown>[];
    const record = records.find(run => run.runId === at.runId);
    if (!record) throw new Error("Missing record");
    if (cell.record === "unreadable") record.runStartedBy = null;
    else records.push(structuredClone(record));
  }
  if (cell.intent) runs.deleteIntents = [{ itemId: at.id, runId: at.runId }];
  if (cell.marker) runs.unknownDeletes = [{ itemId: at.id, runId: at.runId, op: "row", ownIntent: true }];
  writeFileSync(runsPath(h), JSON.stringify(runs));
}

/** While held, the run file reads as awaiting review. */
function holdRunFile(h: Harness, io = false): { release(): void } {
  const path = runsPath(h);
  heldInputs.set(path, io);
  return { release: () => { heldInputs.delete(path); } };
}

/** Every settle the store was asked for, with what it stored; while `failing`, each one that would end a run throws, until released. */
function watchSettles(h: Harness, failing: boolean) {
  const runs = h.board.runs;
  const settle = runs.settleRun.bind(runs);
  let fail = failing;
  let failed = false;
  const stored: { runId: string; status: string; cause: RunEndCause }[] = [];
  const spy = vi.spyOn(runs, "settleRun").mockImplementation(async (runId, step, allowed) => {
    let cause: RunEndCause | undefined;
    const result = await settle(runId, run => {
      const next = step(run);
      if (next !== null && "ends" in next) cause = next.ends;
      if (fail && next !== null && "ends" in next) {
        failed = true;
        throw new Error("settle write failed");
      }
      return next;
    }, allowed);
    if (result.status === "stored" && result.run.settled !== undefined) {
      expect(cause).toBeDefined();
      stored.push({ runId, status: result.run.settled.status, cause: cause as RunEndCause });
    }
    return result;
  });
  return { stored, failed: () => failed, release: () => { fail = false; }, restore: () => spy.mockRestore() };
}

async function reader(h: Harness): Promise<void> {
  const listed = await h.board.list().catch(() => null);
  if (listed?.status === "ok") await h.engine.projectTemplateRuns(listed.items);
}

async function startLinked(h: Harness, id: number, version: TemplateVersion) {
  const running = h.start(id, h.local(version)).catch(() => undefined);
  const [child] = await h.waitForLive(1);
  await h.drainRunWork();
  return { running, child };
}

async function prepareBoard() {
  const h = await stageRunHarness({ observeRunWork: true });
  try {
    const holder = await h.board.create({ title: "Holder" });
    const bystander = await h.board.create({ title: "Bystander" });
    if (holder.status !== "created" || bystander.status !== "created") throw new Error("no rows");
    const version = await h.confirm([stageOf("a"), stageOf("b", { inputs: ["a"] })]);
    const id = await h.addItem(version);
    const files = ["board.json", "workflow-runs.json", "templates.json"].map(name => ({ name, bytes: readFileSync(join(h.dir, name)) }));
    // A restart observes the saved run after the first engine drains. Capture that state once.
    const { running, child } = await startLinked(h, id, version);
    child.finish();
    await running;
    await h.drainRunWork();
    const parked = {
      dir: h.dir, childSessionId: child.sessionId, board: readFileSync(h.boardPath),
      runFile: JSON.parse(readFileSync(runsPath(h), "utf8")) as { runs: RunRecord[] },
    };
    return { holder: holder.itemId, bystander: bystander.itemId, version, id, files, parked };
  } finally {
    for (const child of h.children) child.finish();
    await h.drainRunWork();
    await h.cleanup();
  }
}

function copyParkedRun(h: Harness, parked: Awaited<ReturnType<typeof prepareBoard>>["parked"]): void {
  const runFile = structuredClone(parked.runFile);
  for (const run of runFile.runs) {
    if (run.runWorkspace) run.runWorkspace.runRoot = join(h.dir, relative(parked.dir, run.runWorkspace.runRoot));
    for (const stage of run.stageRuns) {
      if (!stage.workspace) continue;
      stage.workspace.root = join(h.dir, relative(parked.dir, stage.workspace.root));
      mkdirSync(stage.workspace.root, { recursive: true });
    }
  }
  writeFileSync(h.boardPath, parked.board);
  writeFileSync(runsPath(h), `${JSON.stringify(runFile, null, 2)}\n`);
}

/** One cell on its own home: the run, the files as the cell leaves them, the consumer's event, and the checks. */
async function runCell(cell: Cell, fixture: Awaited<ReturnType<typeof prepareBoard>>, classes: Class[], tally: (key: string) => void): Promise<void> {
  const h = await stageRunHarness({ observeRunWork: true });
  const context = JSON.stringify(cell);
  let restoreSettleSpy: (() => void) | undefined;
  try {
    const { holder, bystander, version, id, files, parked } = fixture;
    const boot = cell.consumer === "boot adoption" || cell.consumer === "live adoption";
    for (const file of files) writeFileSync(join(h.dir, file.name), file.bytes);
    const liveRun = boot ? undefined : await startLinked(h, id, version);
    if (boot) copyParkedRun(h, parked);
    const initial = await h.item(id);
    expect(initial.stageRuns[0]?.childSessionId, context).toBe(liveRun?.child.sessionId ?? parked.childSessionId);
    // The live engine drains its own writes before the hand edit. Only the run-write consumer needs a live child.
    if (liveRun && cell.consumer !== "run write") {
      liveRun.child.finish();
      await liveRun.running;
      await h.drainRunWork();
    }
    const runId = initial.runId ?? "";
    expect((await h.stageRun(id, "a")).status, context).toBe(cell.consumer === "run write" ? "running" : "awaiting_gate");
    leave(h, cell, { id, runId, holder });
    const resolved = oracle(cell);
    const { cls } = resolved;
    const ending = END[cell.consumer][cls];
    // A settle that never comes cannot fail. A one-shot write failure is recovered by a later permitted event.
    const window: FailureWindow = (cell.consumer === "run write" && cell.window === "run file unreadable")
      || (cell.window === "settle write fails" && ending === "open") ? "none" : cell.window;
    const pair = `${cell.consumer}:intent ${cell.intent} marker ${cell.marker}`;
    tally(`${cell.consumer}:${cls}`);
    tally(`${pair}:${cell.board}`);
    tally(`${cell.consumer}:${window}`);
    if (ending !== "open") tally(`${pair} ends:${window}`);
    if (boot) h.makeEngine();
    const settles = watchSettles(h, window === "settle write fails" && ending !== "open");
    restoreSettleSpy = settles.restore;
    classes.length = 0;
    let booted = false;
    let boardWrites = 0;
    const event = async (): Promise<void> => {
      switch (cell.consumer) {
        case "boot adoption":
        case "live adoption":
          if (!booted) await h.board.reconcileInterruptedRuns().catch(() => undefined);
          booted = true;
          await h.engine.adoptParkedTemplateRuns();
          break;
        case "board write": await h.board.update(bystander, { title: `Bystander edit ${++boardWrites}` }).catch(() => undefined); break;
        case "run write":
          if (!liveRun) throw new Error("No live run for the run-write consumer");
          liveRun.child.finish();
          await liveRun.running;
          break;
        case "reader": await reader(h); break;
      }
      await h.drainRunWork();
    };
    const ended = () => settles.stored.some(end => end.runId === runId);
    const onDisk = async () => (await h.board.runs.get(runId).catch(() => null)) ?? null;

    // A run file that cannot be read holds every run: nothing ends, and the event is repeated once it reads.
    if (window === "run file unreadable" || cell.consumer === "live adoption") {
      const held = holdRunFile(h, cell.consumer === "run write");
      await event();
      expect(ended(), context).toBe(false);
      expect(classes.every(result => result === "unreadable"), context).toBe(true);
      held.release();
      classes.length = 0;
    }
    await event();

    // A settle whose write failed leaves the run unconfirmed: its record stays, unsettled, and retention keeps it; the next reader, once
    // the run file takes writes again, ends it.
    if (settles.failed()) {
      expect(ended(), context).toBe(false);
      await h.board.pruneSettledRuns().catch(() => undefined);
      const kept = await onDisk();
      expect(kept?.status === "found" ? kept.run.settled : "absent", context).toBeUndefined();
      tally(`${cell.consumer}:unconfirmed kept`);
      settles.release();
      await reader(h);
      await h.drainRunWork();
    }

    // The consumer read the oracle's class. Not asked: any consumer over a board file that shows nothing (the store answers every run
    // unreadable, `template-runs-board-unread`, before a classifier call), a
    // run write whose row's standing on disk decides it first (the row names the run, or the board shows it unreadable), and a reader with
    // no intent to read.
    const asks = cell.board !== "corrupt" && (boot ? true
      : cell.consumer === "run write" ? !["named", "held elsewhere", "same-id invalid"].includes(cell.board)
      : cell.consumer === "board write" || resolved.intent);
    if (asks && !cell.record) expect(classes, context).toContain(cls);
    const ends = settles.stored.filter(end => end.runId === runId);
    if (ending === "open") {
      expect(ends, context).toEqual([]);
      const stored = await onDisk();
      if (cell.record) expect(stored?.status, context).toBe("invalid");
      else expect(stored?.status === "found" ? stored.run.settled : "absent", context).toBeUndefined();
    } else {
      expect(ends, context).toEqual([{ runId, status: STATUS[ending], cause: ending }]);
      // Whatever the run file holds of it now is that end (or nothing, once retention pruned it).
      const stored = await onDisk();
      if (stored?.status === "found") expect(stored.run.settled?.status, context).toBe(STATUS[ending]);
      // The end's event, where its consumer tells one: a removed row's end always, an orphan's or a lost run's from the live engine (an
      // adoption ends those without one). An orphan's end is never told as an error, nor a lost run's as cancelled.
      const live = cell.consumer === "board write" || cell.consumer === "run write";
      const told = (): typeof h.events => h.events.filter(e => e.itemId === id && (e.phase === "cancelled" || e.phase === "error"));
      if (ending === "item-removed") expect(told(), context).toContainEqual(expect.objectContaining({ phase: "cancelled", message: "item-removed" }));
      if (ending === "orphan" && live) expect(told(), context).not.toEqual([]);
      if (ending === "lost" && live) expect(told(), context).toContainEqual(expect.objectContaining({ phase: "error", reasonCode: "template-run-lost" }));
      expect(told().filter(e => e.phase === (ending === "lost" ? "cancelled" : "error")), context).toEqual([]);
    }
    // An intent or a marker still open once the marker is decided never ends a run as an orphan or lost. A confirmed end's note is no end.
    if (resolved.intent || resolved.marker) {
      const wrong = h.events.filter(e => e.itemId === id
        && ((e.phase === "cancelled" && e.message !== "item-removed" && e.reasonCode !== "run-end-confirmed") || e.reasonCode === "template-run-lost"));
      expect(wrong, context).toEqual([]);
    }
  } finally {
    for (const c of h.children) c.finish();
    // Booted cells replace the engine; drain both engines' work.
    await h.drainAllRunWork();
    heldInputs.delete(runsPath(h));
    restoreSettleSpy?.();
    await h.cleanup();
  }
}

async function runCells(cells: Cell[], tally: (key: string) => void): Promise<void> {
  const fixture = await prepareBoard();
  const concurrency = 4;
  for (let index = 0; index < cells.length; index += concurrency) {
    const results = await Promise.allSettled(cells.slice(index, index + concurrency).map(cell => {
      const classes: Class[] = [];
      return classifications.run(classes, () => runCell(cell, fixture, classes, tally));
    }));
    for (const result of results) if (result.status === "rejected") throw result.reason;
  }
}

it("waits for a posted run end before checking for an absent settlement", async () => {
  const h = await stageRunHarness({ observeRunWork: true });
  const entered = deferred<void>();
  const release = deferred<void>();
  try {
    const holder = await h.board.create({ title: "Holder" });
    if (holder.status !== "created") throw new Error("no holder");
    const version = await h.confirm([stageOf("a")]);
    const id = await h.addItem(version);
    const { running, child } = await startLinked(h, id, version);
    child.finish();
    await running;
    await h.drainRunWork();
    const { runId = "" } = await h.item(id);
    leave(h, { consumer: "board write", board: "unnamed", intent: false, marker: false, window: "none" }, { id, runId, holder: holder.itemId });
    const resolveVersion = h.templates.resolveVersion.bind(h.templates);
    vi.spyOn(h.templates, "resolveVersion").mockImplementation(async pin => {
      entered.resolve();
      await release.promise;
      return resolveVersion(pin);
    });
    await h.board.update(holder.itemId, { title: "Holder edited" });
    await entered.promise;

    let checked = false;
    const lost = h.drainRunWork().then(() => {
      checked = true;
      return h.events.some(event => event.itemId === id && event.reasonCode === "template-run-lost");
    });
    await new Promise<void>(resolve => setImmediate(resolve));
    const checkedWhileHeld = checked;
    release.resolve();
    expect(await lost).toBe(true);
    expect(checkedWhileHeld).toBe(false);
  } finally {
    release.resolve();
    for (const child of h.children) child.finish();
    await h.drainRunWork();
    await h.cleanup();
  }
});

// One-shot unreadable events have positive retention and recovery checks below for every intent and marker pair.
const windowsOf = (consumer: Consumer): FailureWindow[] => WINDOWS.filter(window => consumer !== "run write" || window !== "run file unreadable");
const HELD_WINDOWS = ["none", "run file unreadable"] as const;
const ends = (cell: Omit<Cell, "window">): boolean => END[cell.consumer][oracle({ ...cell, window: "none" }).cls] !== "open";

it("every consumer ends a run as its class says, through settleRun, over every board state, intent, marker and failure window", { timeout: 600_000 }, async () => {
  const counts: Record<string, number> = {};
  const tally = (key: string) => { counts[key] = (counts[key] ?? 0) + 1; };
  const cells: Cell[] = [];
  // Every consumer meets every board state with and without an intent and a marker. A cell whose run ends meets every failure window
  // that applies to its consumer; a cell whose run is held, where no settle comes, rotates between none and an unreadable run file.
  for (const consumer of CONSUMERS) {
    let turn = 0;
    for (const board of BOARDS) {
      for (const intent of [false, true]) {
        for (const marker of [false, true]) {
          const cell = { consumer, board, intent, marker };
          const windows = ends(cell) ? windowsOf(consumer) : [HELD_WINDOWS[turn++ % HELD_WINDOWS.length]];
          for (const window of windows) cells.push({ ...cell, window });
        }
      }
    }
  }
  await runCells(cells, tally);
  // Every class, every board state under every intent and marker pair, and every failure window that applies was reached under every
  // consumer; where a pair's run ends, it ended in each of those windows; and a failed settle was kept unconfirmed.
  for (const consumer of CONSUMERS) {
    for (const intent of [false, true]) {
      for (const marker of [false, true]) {
        const pair = `${consumer}:intent ${intent} marker ${marker}`;
        for (const board of BOARDS) expect(counts[`${pair}:${board}`] ?? 0, `${pair} ${board}`).toBeGreaterThan(0);
        if (!BOARDS.some(board => ends({ consumer, board, intent, marker }))) continue;
        for (const window of windowsOf(consumer)) expect(counts[`${pair} ends:${window}`] ?? 0, `${pair} ends ${window}`).toBeGreaterThan(0);
      }
    }
    for (const cls of ["live", "due-delete", "waiting-delete", "unreadable", "orphan", "lost"] as const) expect(counts[`${consumer}:${cls}`], `${consumer} ${cls}`).toBeGreaterThan(0);
    for (const window of windowsOf(consumer)) expect(counts[`${consumer}:${window}`], `${consumer} ${window}`).toBeGreaterThan(0);
    expect(counts[`${consumer}:unconfirmed kept`], `${consumer} unconfirmed`).toBeGreaterThan(0);
  }
});

it("unreadable and repeated individual records stay unconfirmed under every consumer and delete-state pair", { timeout: 600_000 }, async () => {
  const cells: Cell[] = [];
  for (const consumer of CONSUMERS) {
    for (const record of ["unreadable", "repeated"] as const) {
      for (const board of ["named", "gone"] as const) {
        for (const intent of [false, true]) {
          for (const marker of [false, true]) cells.push({ consumer, record, board, intent, marker, window: "none" });
        }
      }
    }
  }
  await runCells(cells, () => undefined);
});

it("one-shot run-file I/O failures retain a completion and recover its output under every intent and marker pair", { timeout: 120_000 }, async () => {
  for (const intent of [false, true]) {
    for (const marker of [false, true]) {
      const h = await stageRunHarness({ observeRunWork: true });
      let restoreSpies: (() => void) | undefined;
      try {
        const version = await h.confirm([stageOf("a")]);
        const id = await h.addItem(version);
        const running = h.start(id, h.local(version)).catch(() => undefined);
        const [child] = await h.waitForLive(1);
        await h.drainRunWork();
        const initial = await h.item(id);
        expect(initial.stageRuns[0]?.childSessionId).toBe(child.sessionId);
        const runId = initial.runId ?? "";
        leave(h, { consumer: "run write", board: "named", intent, marker, window: "none" }, { id, runId, holder: -1 });
        const settles = watchSettles(h, false);
        const retain = vi.spyOn(h.board.runs, "holdEvent");
        restoreSpies = () => { retain.mockRestore(); settles.restore(); };
        const identity = { itemId: id, runId, stage: "a", attempt: 1, kind: "stage_ended" };
        const held = holdRunFile(h, true);
        child.finish();
        await running;
        await h.drainRunWork();
        expect(retain).toHaveBeenCalledWith(identity);
        expect(settles.stored).toEqual([]);
        const raw = JSON.parse(readFileSync(runsPath(h), "utf8")) as {
          runs: { runId: string; settled?: unknown; stageRuns: { status: string }[] }[];
          deleteIntents?: unknown[]; unknownDeletes?: unknown[];
        };
        expect(raw.runs.find(run => run.runId === runId)).toMatchObject({ stageRuns: [{ status: "running" }] });
        expect(raw.runs.find(run => run.runId === runId)?.settled).toBeUndefined();
        expect(raw.deleteIntents ?? []).toEqual(intent ? [{ itemId: id, runId }] : []);
        expect(raw.unknownDeletes ?? []).toEqual(marker ? [{ itemId: id, runId, op: "row", ownIntent: true }] : []);
        held.release();
        // An open delete intent with its row still present keeps the event until the intent is withdrawn.
        if (intent && !marker) expect(await h.board.runs.withdrawIntent({ itemId: id, runId })).toBe(true);
        await reader(h);
        await h.engine.adoptParkedTemplateRuns();
        await h.drainRunWork();
        const recovered = await h.stageRun(id, "a");
        expect(recovered).toMatchObject({ status: "awaiting_gate", attempt: 1, output: `output of ${child.sessionId}` });
        expect(await h.board.runs.heldEvents({ itemId: id, runId })).toEqual([]);
        expect(settles.stored).toEqual([]);
        expect(h.events.filter(event => event.phase === "error" || event.phase === "cancelled")).toEqual([]);
        await h.board.runs.prune(() => null);
        expect((await h.board.runs.get(runId)).status).toBe("found");
      } finally {
        for (const child of h.children) child.finish();
        await h.drainRunWork();
        heldInputs.delete(runsPath(h));
        restoreSpies?.();
        await h.cleanup();
      }
    }
  }
});
