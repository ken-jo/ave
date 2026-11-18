/** How a template run ends, as a property of the real engine (work-board-run-ending.md): every consumer, over every state the board file and
 * the run file can leave a run in, with and without its delete intent and an unknown marker, and in each failure window. The oracle is this
 * file's own: it derives the class from how the cell built the two files, and the end from the design's consumer table. Each end must come
 * through `settleRun`, and each consumer must have read the oracle's class from `classifyRun`. Boot adoption is a new engine over the same
 * files; live adoption is the running engine adopting again after its boot adoption could not read the run file. */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import * as classification from "../../../main/run-classification.js";
import * as homeTrust from "../../../shared/ave-home-trust.js";
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
interface Cell { consumer: Consumer; board: BoardState; intent: boolean; marker: boolean; window: FailureWindow }

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
  if (cell.intent) runs.deleteIntents = [{ itemId: at.id, runId: at.runId }];
  if (cell.marker) runs.unknownDeletes = [{ itemId: at.id, runId: at.runId }];
  writeFileSync(runsPath(h), JSON.stringify(runs));
}

/** While held, the run file reads as awaiting review. */
function holdRunFile(h: Harness): { release(): void } {
  const read = homeTrust.readAveHomeInput;
  const spy = vi.spyOn(homeTrust, "readAveHomeInput").mockImplementation(async path =>
    path === runsPath(h) ? { status: "untrusted", bytes: Buffer.alloc(0), reason: "changed" } : read(path));
  return { release: () => spy.mockRestore() };
}

/** Every settle the store was asked for, with what it stored; while `failing`, each one that would end a run throws, until released. */
function watchSettles(h: Harness, failing: boolean) {
  const runs = h.board.runs;
  const settle = runs.settleRun.bind(runs);
  let fail = failing;
  let failed = false;
  const stored: { runId: string; status: string }[] = [];
  vi.spyOn(runs, "settleRun").mockImplementation(async (runId, step, allowed) => {
    const result = await settle(runId, run => {
      const next = step(run);
      if (fail && next !== null && "ends" in next) {
        failed = true;
        throw new Error("settle write failed");
      }
      return next;
    }, allowed);
    if (result.status === "stored" && result.run.settled !== undefined) stored.push({ runId, status: result.run.settled.status });
    return result;
  });
  return { stored, failed: () => failed, release: () => { fail = false; } };
}

async function until(check: () => boolean | Promise<boolean>, polls = 60): Promise<boolean> {
  for (let i = 0; i < polls; i += 1) {
    if (await check()) return true;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  return check();
}

async function reader(h: Harness): Promise<void> {
  const listed = await h.board.list().catch(() => null);
  if (listed?.status === "ok") await h.engine.projectTemplateRuns(listed.items);
}

/** One cell on its own home: the run, the files as the cell leaves them, the consumer's event, and the checks. */
async function runCell(cell: Cell, tally: (key: string) => void): Promise<void> {
  const h = await stageRunHarness();
  const context = JSON.stringify(cell);
  try {
    const holderRow = await h.board.create({ title: `holder ${context}` });
    const bystanderRow = await h.board.create({ title: `bystander ${context}` });
    if (holderRow.status !== "created" || bystanderRow.status !== "created") throw new Error("no rows");
    const version = await h.confirm([stageOf("a"), stageOf("b", { inputs: ["a"] })]);
    const id = await h.addItem(version);
    void h.start(id, h.local(version)).catch(() => undefined);
    const [child] = await h.untilLive(1);
    const runId = (await h.item(id)).runId ?? "";
    // Every consumer but the run write works on a parked run: stage a waits at its gate. The engine's own writes land before the hand edit.
    if (cell.consumer !== "run write") {
      child.finish();
      await h.untilStage(id, "a", "awaiting_gate");
    } else await h.untilStage(id, "a", "running");
    await new Promise(resolve => setTimeout(resolve, 50));
    leave(h, cell, { id, runId, holder: holderRow.itemId });
    const resolved = oracle(cell);
    const { cls } = resolved;
    const ending = END[cell.consumer][cls];
    // A run write happens once, so it is never repeated after the run file reads again; a settle that never comes cannot fail.
    const window: FailureWindow = (cell.consumer === "run write" && cell.window === "run file unreadable") || (cell.window === "settle write fails" && ending === "open")
      ? "none" : cell.window;
    const pair = `${cell.consumer}:intent ${cell.intent} marker ${cell.marker}`;
    tally(`${cell.consumer}:${cls}`);
    tally(`${pair}:${cell.board}`);
    tally(`${cell.consumer}:${window}`);
    if (ending !== "open") tally(`${pair} ends:${window}`);
    const boot = cell.consumer === "boot adoption" || cell.consumer === "live adoption";
    if (boot) h.makeEngine();
    const settles = watchSettles(h, window === "settle write fails" && ending !== "open");
    const classify = vi.spyOn(classification, "classifyRun");
    let booted = false;
    const event = async (): Promise<void> => {
      switch (cell.consumer) {
        case "boot adoption":
        case "live adoption":
          if (!booted) await h.board.reconcileInterruptedRuns().catch(() => undefined);
          booted = true;
          await h.engine.adoptParkedTemplateRuns();
          break;
        case "board write": await h.board.update(bystanderRow.itemId, { title: `bystander edited ${Math.random()}` }).catch(() => undefined); break;
        case "run write": child.finish(); break;
        case "reader": await reader(h); break;
      }
    };
    const ended = () => settles.stored.some(end => end.runId === runId);
    const onDisk = async () => (await h.board.runs.get(runId).catch(() => null)) ?? null;

    // A run file that cannot be read holds every run: nothing ends, and the event is repeated once it reads.
    if (window === "run file unreadable" || cell.consumer === "live adoption") {
      const held = holdRunFile(h);
      await event();
      await until(ended, 10);
      expect(ended(), context).toBe(false);
      expect(classify.mock.results.every(result => result.value === "unreadable"), context).toBe(true);
      held.release();
      classify.mockClear();
    }
    await event();
    await until(() => ending === "open" ? false : ended() || settles.failed(), ending === "open" ? 20 : 400);

    // A settle whose write failed leaves the run unconfirmed: its record stays, unsettled, and retention keeps it; the next reader, once
    // the run file takes writes again, ends it.
    if (settles.failed()) {
      await until(() => false, 10);
      expect(ended(), context).toBe(false);
      await h.board.pruneSettledRuns().catch(() => undefined);
      const kept = await onDisk();
      expect(kept?.status === "found" ? kept.run.settled : "absent", context).toBeUndefined();
      tally(`${cell.consumer}:unconfirmed kept`);
      settles.release();
      await reader(h);
      await until(ended, 400);
    }

    const classes = classify.mock.results.map(result => result.value);
    // The consumer read the oracle's class. Not asked: any consumer over a board file that shows nothing (the store answers every run
    // unreadable, `template-runs-board-unread`, before a classifier call), an adoption over a row that names its run (adopted by name), a
    // run write whose row's standing on disk decides it first (the row names the run, or the board shows it unreadable), and a reader with
    // no intent to read.
    const asks = cell.board !== "corrupt" && (boot ? cell.board !== "named"
      : cell.consumer === "run write" ? !["named", "held elsewhere", "same-id invalid"].includes(cell.board)
      : cell.consumer === "board write" || resolved.intent);
    if (asks) expect(classes, context).toContain(cls);
    const ends = settles.stored.filter(end => end.runId === runId);
    if (ending === "open") {
      expect(ends, context).toEqual([]);
      const stored = await onDisk();
      expect(stored?.status === "found" ? stored.run.settled : "absent", context).toBeUndefined();
    } else {
      expect(ends, context).toEqual([{ runId, status: STATUS[ending] }]);
      // Whatever the run file holds of it now is that end (or nothing, once retention pruned it).
      const stored = await onDisk();
      if (stored?.status === "found") expect(stored.run.settled?.status, context).toBe(STATUS[ending]);
      // The end's event, where its consumer tells one: a removed row's end always, an orphan's or a lost run's from the live engine (an
      // adoption ends those without one). An orphan's end is never told as an error, nor a lost run's as cancelled.
      const live = cell.consumer === "board write" || cell.consumer === "run write";
      const told = (): typeof h.events => h.events.filter(e => e.itemId === id && (e.phase === "cancelled" || e.phase === "error"));
      if (ending === "item-removed" || live) await until(() => told().length > 0, 400);
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
    vi.restoreAllMocks();
    for (const c of h.children) c.finish();
    await h.cleanup();
  }
}

/** A run write happens once, so an unreadable run file is no window for it. */
const windowsOf = (consumer: Consumer): FailureWindow[] => WINDOWS.filter(w => consumer !== "run write" || w !== "run file unreadable");
const HELD_WINDOWS = ["none", "run file unreadable"] as const;
const ends = (cell: Omit<Cell, "window">): boolean => END[cell.consumer][oracle({ ...cell, window: "none" }).cls] !== "open";

it("every consumer ends a run as its class says, through settleRun, over every board state, intent, marker and failure window", { timeout: 600_000 }, async () => {
  const counts: Record<string, number> = {};
  const tally = (key: string) => { counts[key] = (counts[key] ?? 0) + 1; };
  // Every consumer meets every board state with and without an intent and a marker. A cell whose run ends meets every failure window
  // that applies to its consumer; a cell whose run is held, where no settle comes, rotates between none and an unreadable run file.
  for (const consumer of CONSUMERS) {
    let turn = 0;
    for (const board of BOARDS) {
      for (const intent of [false, true]) {
        for (const marker of [false, true]) {
          const cell = { consumer, board, intent, marker };
          const windows = ends(cell) ? windowsOf(consumer) : [HELD_WINDOWS[turn++ % HELD_WINDOWS.length]];
          for (const window of windows) await runCell({ ...cell, window }, tally);
        }
      }
    }
  }
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
