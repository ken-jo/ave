import { describe, expect, it } from "vitest";
import { type BoardFacts, classifyRun, type RunClass, type RunFileFacts, type RunRowStanding } from "../run-classification.js";

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
