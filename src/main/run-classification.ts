/** How a template run stands, from what the run file and the board file on disk say of it: the one rule every consumer reads
 * (work-board-run-ending.md). Pure: it reads nothing. */

/** Where a stored run's row stands on a readable board. named: the row names the run. moved: it names another run and holds this one in its
 * history. unnamed: it neither names nor holds the run. lost: the board lists no row with its id, and the id is below the board's
 * `unknownBelow`: the board was written over one that showed none of its rows, so the row may have been there. gone: the board lists no
 * row with its id, at or above `unknownBelow`. unreadable: whatever could still be the run's row: a row with its id that does not
 * validate, or, where the run would otherwise read unnamed, lost or gone, a board file holding the run's id as a string value anywhere,
 * or (with its row absent) any entry without a usable id. Every stored run's itemId is at or below the run file's row-id floor, which no
 * new row is issued under, so a gone row is gone for good. */
export type RunRowStanding = "named" | "moved" | "unnamed" | "gone" | "lost" | "unreadable";

export type RunClass = "live" | "due-delete" | "waiting-delete" | "unreadable" | "orphan" | "lost";

/** What the run file says of one unsettled run: it cannot be read, or it is read with whether the intent of the user's delete of its row
 * is open and whether a step of that delete has an outcome not known yet (a marker in the file, or one the store keeps in memory). */
export type RunFileFacts = { readable: false } | { readable: true; intent: boolean; unknown: boolean };

/** What board.json on disk shows of one run, read off its parsed items and its raw text: where its row stands, whether a string value
 * holds the run's id (every id, past the escape cap), whether a listed row has the run's row id, and whether an entry of the items list
 * that does not validate has that id. */
export interface BoardFacts { standing: RunRowStanding; held: boolean; listed: boolean; sameIdEntry: boolean }

/** What a marker says of the delete step it stands for: a listed row's delete (`row`) or an invalid card's (`card`), whether that delete
 * stored the intent itself, and `entrySha`, the raw stored identity of the entry it deleted. Undefined for a marker that does not say
 * (a legacy one of the pair alone, or any other shape). */
export interface MarkerOp { op: "row" | "card"; ownIntent: boolean; entrySha?: string }

/** What a readable board file on disk shows of a marker's delete: whether it lists a row with the marker's row id, whether any entry of
 * its items list has that id (valid or not), whether a string value holds the run id, and whether an entry whose identity is the marker's `entrySha` is there (undefined when
 * the marker has none or the entries have no identity). */
export interface MarkerBoard extends Pick<BoardFacts, "listed" | "held"> { sameId: boolean; entryPresent: boolean | undefined }

/** How a marker resolves on a readable board (work-board-run-ending.md, Failure lifecycle): `unlanded` withdraws the intent with the
 * marker, `landed` drops only the marker, `held` keeps both. Pure and total. */
export function markerOutcome(marker: MarkerOp | undefined, board: MarkerBoard): "unlanded" | "landed" | "held" {
  if (!board.sameId && !board.held) return "landed";
  if (marker === undefined || !marker.ownIntent) return "held";
  if (marker.op === "row") return board.listed ? "unlanded" : "landed";
  return board.entryPresent === true ? "unlanded" : "held";
}

/** The class of one unsettled run. `board` is undefined while the board file shows nothing (absent, awaiting review, not parsing, or
 * without an items list). A run with an open intent or an unknown delete step is never an orphan or lost. */
export function classifyRun(run: RunFileFacts, board: BoardFacts | undefined): RunClass {
  if (!run.readable || board === undefined || run.unknown) return "unreadable";
  if (run.intent) return board.held || board.listed || board.sameIdEntry ? "waiting-delete" : "due-delete";
  switch (board.standing) {
    case "named": return "live";
    case "gone":
    case "moved": return "orphan";
    case "unnamed":
    case "lost": return "lost";
    case "unreadable": return "unreadable";
  }
}
