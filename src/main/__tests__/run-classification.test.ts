import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type BoardFacts, classifyRun, type MarkerBoard, type MarkerOp, markerOutcome, type RunClass, type RunFileFacts, type RunRowStanding,
} from "../run-classification.js";
import { WorkflowRunStore } from "../workflow-run-store.js";

const runFiles: RunFileFacts[] = [
  { readable: false },
  ...[false, true].flatMap(intent => [false, true].map(unknown => ({ readable: true as const, intent, unknown }))),
];
const standings: RunRowStanding[] = ["named", "moved", "unnamed", "gone", "lost", "unreadable"];
const flags = [false, true];
const boards: (BoardFacts | undefined)[] = [
  undefined,
  ...standings.flatMap(standing => flags.flatMap(held => flags.flatMap(listed => flags.map(sameIdEntry => ({ standing, held, listed, sameIdEntry }))))),
];

// The table of work-board-run-ending.md, row by row: the first row that matches gives the class.
const table: [string, (run: RunFileFacts, board: BoardFacts | undefined) => boolean, RunClass][] = [
  ["run file cannot be read", run => !run.readable, "unreadable"],
  ["board shows nothing", (_, board) => board === undefined, "unreadable"],
  ["unknown marker", run => run.readable && run.unknown, "unreadable"],
  ["open intent, held, listed or a same-id entry", (run, board) => run.readable && run.intent && (board?.held === true || board?.listed === true || board?.sameIdEntry === true), "waiting-delete"],
  ["open intent", run => run.readable && run.intent, "due-delete"],
  ["row names the run", (_, board) => board?.standing === "named", "live"],
  ["no row, or only in run history", (_, board) => board?.standing === "gone" || board?.standing === "moved", "orphan"],
  ["neither names nor holds it, or written over", (_, board) => board?.standing === "unnamed" || board?.standing === "lost", "lost"],
  ["row does not validate", (_, board) => board?.standing === "unreadable", "unreadable"],
];
const expected = (run: RunFileFacts, board: BoardFacts | undefined): RunClass => {
  const match = table.find(([, applies]) => applies(run, board));
  if (!match) throw new Error("the table does not cover this input");
  return match[2];
};
const combinations = runFiles.flatMap(run => boards.map(board => ({ run, board })));

describe("classifyRun", () => {
  it.each(combinations.map(({ run, board }) => [JSON.stringify(run), JSON.stringify(board) ?? "nothing", run, board] as const))(
    "run file %s, board %s",
    (_, __, run, board) => {
      expect(classifyRun(run, board)).toBe(expected(run, board));
    },
  );

  it("reaches every class, and a run with an open intent or an unknown step is never an orphan or lost", () => {
    expect(combinations).toHaveLength(5 * (1 + 6 * 8));
    const reached = new Set(combinations.map(({ run, board }) => classifyRun(run, board)));
    expect([...reached].sort()).toEqual(["due-delete", "live", "lost", "orphan", "unreadable", "waiting-delete"]);
    for (const { run, board } of combinations) {
      if (run.readable && (run.intent || run.unknown)) expect(["orphan", "lost", "live"]).not.toContain(classifyRun(run, board));
    }
  });
});

const sha = "c".repeat(64);
const markers: (MarkerOp | undefined)[] = [
  undefined,
  ...(["row", "card"] as const).flatMap(op => flags.flatMap(ownIntent => [{ op, ownIntent }, { op, ownIntent, entrySha: sha }])),
];
const markerBoards: MarkerBoard[] = flags.flatMap(listed => flags.flatMap(sameId => [true, false, undefined].map(entryPresent => ({ listed, sameId, entryPresent }))));

// The marker bullets of work-board-run-ending.md (Failure lifecycle), in order: the first that matches gives the outcome.
const markerTable: [string, (marker: MarkerOp | undefined, board: MarkerBoard) => boolean, "unlanded" | "landed" | "held"][] = [
  ["no entry has its id", (_, board) => !board.sameId, "landed"],
  ["a legacy marker, or one of any other shape", marker => marker === undefined, "held"],
  ["its delete went through another delete's intent", marker => marker?.ownIntent === false, "held"],
  ["a row op with a listed row of that id", (marker, board) => marker?.op === "row" && board.listed, "unlanded"],
  ["a row op without one", marker => marker?.op === "row", "landed"],
  ["a card op whose entry is still there", (marker, board) => marker?.op === "card" && board.entryPresent === true, "unlanded"],
  ["a card op otherwise", marker => marker?.op === "card", "held"],
];
const outcome = (marker: MarkerOp | undefined, board: MarkerBoard): "unlanded" | "landed" | "held" => {
  const match = markerTable.find(([, applies]) => applies(marker, board));
  if (!match) throw new Error("the table does not cover this input");
  return match[2];
};
const markerCases = markers.flatMap(marker => markerBoards.map(board => ({ marker, board })));

describe("markerOutcome", () => {
  it.each(markerCases.map(({ marker, board }) => [JSON.stringify(marker) ?? "legacy", JSON.stringify(board), marker, board] as const))(
    "marker %s, board %s",
    (_, __, marker, board) => {
      expect(markerOutcome(marker, board)).toBe(outcome(marker, board));
    },
  );

  it("withdraws only a delete that owns its intent and left what it deleted, and never wedges a run whose id is gone", () => {
    expect(markerCases).toHaveLength(9 * 12);
    for (const { marker, board } of markerCases) {
      const result = markerOutcome(marker, board);
      if (result === "unlanded") expect(marker?.ownIntent).toBe(true);
      if (!board.sameId) expect(result).toBe("landed");
      if (marker === undefined && board.sameId) expect(result).toBe("held");
    }
  });

  it("reads every marker shape about a run as an unknown step of its delete, and one about no pair as none", async () => {
    const dir = await mkdtemp(join(tmpdir(), "marker-shapes-"));
    try {
      const path = join(dir, "runs.json");
      const store = new WorkflowRunStore(path);
      const pin = { templateId: "template", version: 1, graphHash: "a".repeat(64) };
      const shapes: Record<string, object> = {
        row: { op: "row", ownIntent: true },
        card: { op: "card", ownIntent: true, entrySha: sha },
        "another intent": { op: "card", ownIntent: false },
        legacy: {},
        "an extra key": { op: "row", ownIntent: true, note: 1 },
        "a malformed sha": { op: "card", ownIntent: true, entrySha: "C".repeat(64) },
        "no op": { ownIntent: true },
      };
      const runs = Object.keys(shapes).map((name, at) => ({ itemId: at + 1, runId: `run-${at + 1}`, name }));
      for (const { itemId, runId } of runs) {
        await store.put({ itemId, runId, pin, runStartedBy: { kind: "local-create-and-run", pin }, startedAt: "2026-01-01T00:00:00.000Z", stageRuns: [] });
      }
      const file = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
      file.unknownDeletes = [...runs.map(({ itemId, runId, name }) => ({ itemId, runId, ...shapes[name] })), { runId: "run-other" }, { itemId: 99 }];
      await writeFile(path, `${JSON.stringify(file, null, 2)}\n`);
      const facts = await new WorkflowRunStore(path).runFacts();
      for (const { itemId, runId } of runs) expect(facts?.of({ itemId, runId })).toEqual({ readable: true, intent: false, unknown: true });
      expect(facts?.of({ itemId: 99, runId: "run-other" })).toEqual({ readable: true, intent: false, unknown: false });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
