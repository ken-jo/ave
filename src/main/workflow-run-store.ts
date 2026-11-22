import { createHash } from "node:crypto";
import { join } from "node:path";
import { openFeatureNamespace } from "./storage/feature-namespace.js";
import { repeatsKey, rewriteKeepingBytes, WorkBoardWriteRefusal } from "./storage/rewrite-keeping-bytes.js";
import { AVE_HOME_INPUT_MAX_BYTES, AveHomeInputSizeLimitError, readAveHomeInput } from "../shared/ave-home-trust.js";
import { createLogger } from "../lib/logger.js";
import { withInProcessFileQueue } from "../lib/with-file-lock.js";
import { isRecord } from "../shared/is-record.js";
import { canonicalWorkflowJson } from "../shared/workflow-template-output.js";
import { requireTemplate, WorkflowTemplateError } from "../work-board/template-graph.js";
import { assertWorkflowRunRecord } from "../work-board/template-run-fields.js";
import type { WorkflowRunListResult, WorkflowRunReadResult, WorkflowRunRecord, WorkflowRunWriteResult } from "../shared/workflow-template-types.js";
import type { MarkerOp, RunClass, RunFileFacts } from "./run-classification.js";

const log = createLogger("ave");

/** `rowIdFloor`: the highest board row id ever issued or seen. A file without it reads as 0; the floor read is never below any stored run's
 * itemId, and every write stores it, so it never goes down. */
// `legacyBoardCopy`: the copy of a legacy board, as stored; it is only read by the copy and the board writes that wait on it, and written
// back as it is. `deleteIntents`: see markDeleted; `unknownDeletes`: see markUnknown; `heldEvents`: see holdEvent. `raw`, the file's
// top-level object as read: a write writes its other keys back as they were, in their place; `unchanged`, the text a write writes for the
// file as read.
interface RunsFile {
  version: 1; rowIdFloor: number; runs: unknown[]; legacyBoardCopy?: unknown; deleteIntents?: unknown[]; unknownDeletes?: unknown[]; heldEvents?: unknown[];
  raw?: Record<string, unknown>; unchanged?: string;
}
/** A user's delete of row `itemId`, which named the unsettled run `runId` of that row. */
export interface DeleteIntent { itemId: number; runId: string }
/** A delete step whose outcome is not known (see markUnknown): its run, and its operation unless the marker does not say. */
export interface DeleteMarker extends DeleteIntent { operation?: MarkerOp }
/** What identifies a scheduler event a run write held (work-board-run-ending.md, Held events): its stage or join (null for a run-wide
 * event), its attempt (0 where none applies) and its kind. */
export interface HeldIdentity { stage: string | null; attempt: number; kind: string }
/** A held event as the run file stores it: its run and its identity. */
export interface HeldEvent extends DeleteIntent, HeldIdentity {}
/** An entry of the run file that get() refuses: `position`, its index among the file's runs; `hash`, the sha-256 of its JSON; `itemId`, the
 * row it names when that reads as a row id. */
interface WorkflowRunUnreadable { position: number; hash: string; itemId?: number }
/** One read of the run file, for a caller that looks up several runs; `unreadable`, every entry of it that does not read as a run;
 * `missing`, true only when the file read holds no entry under that run id and no entry without a string runId that could be it. */
export interface WorkflowRunView {
  readonly pendingReview: boolean;
  readonly unreadable?: readonly WorkflowRunUnreadable[];
  /** All workspace identities not confirmed settled; undefined when any identity cannot be read safely. */
  readonly keepWorkspaces?: readonly string[];
  get(runId: string): WorkflowRunReadResult;
  missing?(runId: string): boolean;
}
/** What a write does with another readable run: null removes it, a record replaces it (same item, pin, start authority and end). */
export type WorkflowRunRetention = (run: WorkflowRunRecord) => WorkflowRunRecord | null;

/** Why a template run ends (work-board-run-ending.md, One settle point). */
export type RunEndCause = "completed" | "denied" | "failed" | "stopped" | "unstarted" | "item-removed" | "orphan" | "lost";
/** The causes a row's removal or loss gives, each with the class a run must still have for it to end so. */
export type RunRemovalCause = "item-removed" | "orphan" | "lost";
export const REMOVAL_CLASS: Readonly<Record<RunRemovalCause, RunClass>> = { "item-removed": "due-delete", orphan: "orphan", lost: "lost" };
const SETTLED_AS: Readonly<Record<RunEndCause, NonNullable<WorkflowRunRecord["settled"]>["status"]>> = {
  completed: "completed", denied: "denied", failed: "error", stopped: "cancelled", unstarted: "error", "item-removed": "cancelled", orphan: "cancelled", lost: "error",
};
/** A write that ends the run: its final state (every stage as it ends) and why, at `at`. */
export interface RunEnd { run: WorkflowRunRecord; ends: RunEndCause; at: string }
const isRunEnd = (next: WorkflowRunRecord | RunEnd): next is RunEnd => "ends" in next && "run" in next;
const sameEnd = (a: WorkflowRunRecord["settled"], b: WorkflowRunRecord["settled"]): boolean => canonicalWorkflowJson(a ?? null) === canonicalWorkflowJson(b ?? null);

// An unreadable or repeated entry is refused on its own: the other runs stay usable and its stored value is never rewritten.
function lookup(file: RunsFile, runId: string): { result: WorkflowRunReadResult; index: number } {
  const index = file.runs.findIndex(entry => isRecord(entry) && entry.runId === runId);
  if (index === -1) return { result: { status: "not-found" }, index };
  if (file.runs.some((entry, other) => other !== index && isRecord(entry) && entry.runId === runId)) return { result: { status: "invalid" }, index };
  const entry = file.runs[index];
  try { assertWorkflowRunRecord(entry); }
  catch (error) { if (error instanceof WorkflowTemplateError) return { result: { status: "invalid" }, index }; throw error; }
  return { result: { status: "found", run: structuredClone(entry) }, index };
}

// Applies `retain` to every readable entry. An unreadable or repeated entry is never offered and always stays as it is.
function retainRuns(file: RunsFile, retain: WorkflowRunRetention, removed: string[] = []): boolean {
  const count = new Map<unknown, number>();
  for (const entry of file.runs) if (isRecord(entry)) count.set(entry.runId, (count.get(entry.runId) ?? 0) + 1);
  let changed = false;
  const kept: unknown[] = [];
  for (const entry of file.runs) {
    if (!isRecord(entry) || count.get(entry.runId) !== 1) { kept.push(entry); continue; }
    try { assertWorkflowRunRecord(entry); }
    catch (error) { if (error instanceof WorkflowTemplateError) { kept.push(entry); continue; } throw error; }
    const next = retain(structuredClone(entry));
    if (next === null) {
      if (entry.settled === undefined) kept.push(entry); else { changed = true; removed.push(entry.runId); }
      continue;
    }
    assertWorkflowRunRecord(next);
    requireTemplate(bindingOf(next) === bindingOf(entry) && sameEnd(next.settled, entry.settled), "invalid-template-run");
    if (canonicalWorkflowJson(next) !== canonicalWorkflowJson(entry)) changed = true;
    kept.push(next);
  }
  file.runs = kept;
  return changed;
}

// Every entry get() refuses: one that is not a run, does not validate, or shares its runId with another entry.
function unreadableEntries(file: RunsFile): WorkflowRunUnreadable[] {
  return file.runs.flatMap((entry, position) => {
    if (isRecord(entry) && typeof entry.runId === "string" && lookup(file, entry.runId).result.status === "found") return [];
    const itemId = isRecord(entry) && isRowId(entry.itemId) ? entry.itemId : undefined;
    return [{ position, hash: createHash("sha256").update(JSON.stringify(entry)).digest("hex"), ...(itemId === undefined ? {} : { itemId }) }];
  });
}

const isIntent = (entry: unknown): entry is DeleteIntent =>
  isRecord(entry) && Object.keys(entry).length === 2 && isRowId(entry.itemId) && typeof entry.runId === "string";

// Whether the intent's run is still to end: the file holds it readable, unsettled and of that row.
function openIntent(file: RunsFile, intent: DeleteIntent): boolean {
  const { result } = lookup(file, intent.runId);
  return result.status === "found" && result.run.settled === undefined && result.run.itemId === intent.itemId;
}

const openIntents = (file: RunsFile): DeleteIntent[] =>
  (file.deleteIntents ?? []).filter((entry): entry is DeleteIntent => isIntent(entry) && openIntent(file, entry));

const sameIntent = (a: DeleteIntent) => (b: unknown): boolean => isIntent(b) && b.itemId === a.itemId && b.runId === a.runId;
const samePair = (a: DeleteIntent) => (b: DeleteIntent): boolean => b.itemId === a.itemId && b.runId === a.runId;

const MARKER_KEYS: ReadonlySet<string> = new Set(["itemId", "runId", "op", "ownIntent", "entrySha"]);
// A stored marker: the pair it is about, with its operation only when it is whole; undefined for an entry about no pair.
function markerOf(entry: unknown): DeleteMarker | undefined {
  if (!isRecord(entry) || !isRowId(entry.itemId) || typeof entry.runId !== "string") return undefined;
  const pair = { itemId: entry.itemId, runId: entry.runId };
  const { op, ownIntent, entrySha } = entry;
  const keys = Object.keys(entry);
  const whole = (op === "row" || op === "card") && typeof ownIntent === "boolean" && keys.every(key => MARKER_KEYS.has(key))
    && (entrySha === undefined ? keys.length === 4 : typeof entrySha === "string" && /^[0-9a-f]{64}$/.test(entrySha) && keys.length === 5);
  if (!whole) return pair;
  return { ...pair, operation: { op: op as MarkerOp["op"], ownIntent: ownIntent as boolean, ...(entrySha === undefined ? {} : { entrySha: entrySha as string }) } };
}
const sameMarker = (a: DeleteMarker) => (b: DeleteMarker): boolean =>
  samePair(a)(b) && canonicalWorkflowJson(a.operation ?? null) === canonicalWorkflowJson(b.operation ?? null);
const markerEntry = ({ itemId, runId, operation }: DeleteMarker): Record<string, unknown> => ({ itemId, runId, ...operation });
const markersIn = (file: RunsFile): DeleteMarker[] => (file.unknownDeletes ?? []).flatMap(entry => markerOf(entry) ?? []);
// Whether a stored entry is a marker about the pair, whatever its shape.
const aboutPair = (pair: DeleteIntent) => (entry: unknown): boolean => { const marker = markerOf(entry); return marker !== undefined && samePair(pair)(marker); };
const dropFrom = (entries: unknown[] | undefined, drop: (entry: unknown) => boolean): unknown[] | undefined => {
  const kept = (entries ?? []).filter(entry => !drop(entry));
  return kept.length > 0 ? kept : undefined;
};
// A stored held event; undefined for an entry of any other shape.
function heldOf(entry: unknown): HeldEvent | undefined {
  if (!isRecord(entry) || Object.keys(entry).length !== 5 || !isRowId(entry.itemId) || typeof entry.runId !== "string") return undefined;
  const { stage, attempt, kind } = entry;
  if ((stage !== null && typeof stage !== "string") || !isRowId(attempt) || typeof kind !== "string") return undefined;
  return { itemId: entry.itemId, runId: entry.runId, stage, attempt, kind };
}
const sameHeld = (run: DeleteIntent, identity?: HeldIdentity) => (entry: unknown): boolean => {
  const held = heldOf(entry);
  return held !== undefined && samePair(run)(held)
    && (identity === undefined || (held.stage === identity.stage && held.attempt === identity.attempt && held.kind === identity.kind));
};
// Whether the file still holds the intent or a marker of that delete.
const holdsDelete = (file: RunsFile, intent: DeleteIntent): boolean =>
  (file.deleteIntents ?? []).some(sameIntent(intent)) || (file.unknownDeletes ?? []).some(aboutPair(intent));

// What the file says of one run, for classifyRun (see runFacts): `unknown` for a marker in the file or one the store holds in memory.
function factsIn(file: RunsFile, held: readonly DeleteMarker[]): (run: DeleteIntent) => RunFileFacts {
  const intents = openIntents(file);
  const unknown = [...markersIn(file), ...held];
  return (run) => {
    const { result } = lookup(file, run.runId);
    if (result.status === "invalid" || (result.status === "found" && result.run.itemId !== run.itemId)) return { readable: false };
    return { readable: true, intent: intents.some(sameIntent(run)), unknown: unknown.some(samePair(run)) };
  };
}

// An intent, marker or held event goes with the write that ends its run, or once the file holds no such run; one whose run entry does not
// read, or that does not read as an intent (a marker: about no pair; a held event: of no known shape), stays as it is.
function keepOpenIntents(file: RunsFile): void {
  const open = (pair: DeleteIntent | undefined): boolean => pair === undefined || lookup(file, pair.runId).result.status === "invalid" || openIntent(file, pair);
  file.deleteIntents = dropFrom(file.deleteIntents, entry => !open(isIntent(entry) ? entry : undefined));
  file.unknownDeletes = dropFrom(file.unknownDeletes, entry => !open(markerOf(entry)));
  file.heldEvents = dropFrom(file.heldEvents, entry => !open(heldOf(entry)));
}

function fileText({ raw, unchanged: _, ...known }: RunsFile): string {
  return `${JSON.stringify({ ...raw, ...known }, null, 2)}\n`;
}

const isRowId = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const floorOver = (runs: readonly unknown[], floor: number): number =>
  runs.reduce<number>((highest, entry) => isRecord(entry) && isRowId(entry.itemId) ? Math.max(highest, entry.itemId) : highest, floor);

/** A legacy board copy started and not done: every id it holds and the sha256 of the board bytes it writes. */
interface StartedLegacyBoardCopy { through: number; board: string }

// Undefined for a copy done, one whose mark does not read (one without the hash among them) and none.
function startedCopy(copy: unknown): StartedLegacyBoardCopy | undefined {
  return isRecord(copy) && isRowId(copy.through) && typeof copy.board === "string" && /^[0-9a-f]{64}$/.test(copy.board) && Object.keys(copy).length === 2
    ? { through: copy.through, board: copy.board }
    : undefined;
}

// Which item a run belongs to and what authorised it never change after the first write.
function bindingOf(run: WorkflowRunRecord): string {
  return canonicalWorkflowJson({ runId: run.runId, itemId: run.itemId, pin: run.pin, runStartedBy: run.runStartedBy });
}

/** Template-run state in the covered `work-board/workflow-runs.json`, keyed by runId. */
export class WorkflowRunStore {
  // Deletes whose outcome is unknown and whose marker the file may not hold: a write or read of it failed (see markUnknown).
  private unknown: DeleteMarker[] = [];
  /** Told which settled runs a write removed, once that write is on disk: what a run keeps for its item's lifetime goes then. */
  onRunsRemoved: ((runIds: readonly string[]) => void) | undefined;

  constructor(private readonly filePath = join(openFeatureNamespace("work-board").dir, "workflow-runs.json")) {}

  /** The file, or undefined while it awaits home content review. Any other read failure throws; a file that holds a key twice throws
   * `workflow-runs-duplicate-key`, so nothing reads it or writes over it until it is fixed by hand. */
  private async read(): Promise<RunsFile | undefined> {
    return (await this.load())?.file;
  }

  // The file with the bytes it was read from; no bytes for a file that is not there.
  private async load(): Promise<{ file: RunsFile; bytes?: Buffer } | undefined> {
    let input: Awaited<ReturnType<typeof readAveHomeInput>>;
    try { input = await readAveHomeInput(this.filePath); }
    catch (error) { if (error instanceof AveHomeInputSizeLimitError) return undefined; throw error; }
    if (input.status === "absent") return { file: { version: 1, rowIdFloor: 0, runs: [] } };
    if (input.status === "untrusted") return undefined;
    const text = input.bytes.toString("utf8");
    let raw: unknown;
    try { raw = JSON.parse(text); } catch { throw new WorkflowTemplateError("invalid-template-run"); }
    if (repeatsKey(text)) throw new WorkBoardWriteRefusal("workflow-runs-duplicate-key", this.filePath);
    requireTemplate(isRecord(raw) && raw.version === 1 && Array.isArray(raw.runs) && (raw.rowIdFloor === undefined || isRowId(raw.rowIdFloor))
      && (raw.deleteIntents === undefined || Array.isArray(raw.deleteIntents)) && (raw.unknownDeletes === undefined || Array.isArray(raw.unknownDeletes))
      && (raw.heldEvents === undefined || Array.isArray(raw.heldEvents)),
      "invalid-template-run");
    const runs: unknown[] = raw.runs;
    const copy = raw.legacyBoardCopy === undefined ? {} : { legacyBoardCopy: raw.legacyBoardCopy };
    const intents = raw.deleteIntents === undefined ? {} : { deleteIntents: raw.deleteIntents as unknown[] };
    const markers = raw.unknownDeletes === undefined ? {} : { unknownDeletes: raw.unknownDeletes as unknown[] };
    const held = raw.heldEvents === undefined ? {} : { heldEvents: raw.heldEvents as unknown[] };
    const file: RunsFile = { version: 1, rowIdFloor: floorOver(runs, (raw.rowIdFloor as number | undefined) ?? 0), runs, ...copy, ...intents, ...markers, ...held, raw };
    file.unchanged = fileText(file);
    return { file, bytes: input.bytes };
  }

  /** The id for a new board row: above the floor and above `seen` (every id the board file shows), stored as the new floor before the row
   * is written. `exhausted` once that id would pass the safe-integer limit; undefined while the file awaits review, is past its read
   * limit, or has no room; a file that cannot be read throws. */
  async issueRowId(seen: number): Promise<number | "exhausted" | undefined> {
    return withInProcessFileQueue(this.filePath, async () => {
      const file = await this.read();
      if (file === undefined) return undefined;
      const id = Math.max(file.rowIdFloor, seen) + 1;
      if (!Number.isSafeInteger(id)) return "exhausted";
      file.rowIdFloor = id;
      return (await this.commit(file)) ? id : undefined;
    });
  }

  /** The floor as stored. Undefined while the file awaits review or is past its read limit; a file that cannot be read throws. */
  async rowIdFloor(): Promise<number | undefined> {
    return withInProcessFileQueue(this.filePath, async () => (await this.read())?.rowIdFloor);
  }

  /** Start the copy of a legacy board: one write marks it started, with `board` (the sha256 of the bytes it writes), and raises the floor
   * over `through`, every id the copy holds, before the board is written. False, with nothing written, once the copy is done (or its mark
   * does not read), once row ids were issued on this home with no copy started or since one was, and while the file awaits review or is
   * past its read limit or room: an id issued since could be a row the copy does not hold. A copy started and never finished with no id
   * issued since starts again. A file that cannot be read throws. */
  async startLegacyBoardCopy(through: number, board: string): Promise<boolean> {
    return withInProcessFileQueue(this.filePath, async () => {
      const file = await this.read();
      if (file === undefined || !isRowId(through)) return false;
      const started = startedCopy(file.legacyBoardCopy);
      if (started === undefined ? file.legacyBoardCopy !== undefined || file.rowIdFloor !== 0 : file.rowIdFloor > started.through) return false;
      file.legacyBoardCopy = { through: Math.max(started?.through ?? 0, through), board };
      file.rowIdFloor = Math.max(file.rowIdFloor, through);
      return this.commit(file);
    });
  }

  /** The legacy board copy started and not done that can still be made or marked done; null for none, one done, one whose mark does not
   * read and one with an id issued above it (it is never made again). Undefined while the file awaits review or is past its read limit;
   * a file that cannot be read throws. */
  async pendingLegacyBoardCopy(): Promise<StartedLegacyBoardCopy | null | undefined> {
    return withInProcessFileQueue(this.filePath, async () => {
      const file = await this.read();
      if (file === undefined) return undefined;
      const started = startedCopy(file.legacyBoardCopy);
      return started !== undefined && file.rowIdFloor <= started.through ? started : null;
    });
  }

  /** Mark a started legacy board copy done once the board file is read back holding its bytes (`board`, their sha256): it is never copied
   * again. False, with nothing written, for none started, a board that is not its bytes, and a mark that cannot be stored now. A file that
   * cannot be read throws. */
  async finishLegacyBoardCopy(board: string): Promise<boolean> {
    return withInProcessFileQueue(this.filePath, async () => {
      const file = await this.read();
      const started = file && startedCopy(file.legacyBoardCopy);
      if (file === undefined || started === undefined || started.board !== board) return false;
      file.legacyBoardCopy = { ...started, done: true };
      return this.commit(file);
    });
  }

  /** Raise the floor to `seen` when it is lower. A file that awaits review is left as it is. */
  async raiseRowIdFloor(seen: number): Promise<void> {
    return withInProcessFileQueue(this.filePath, async () => {
      const file = await this.read();
      if (file === undefined || !isRowId(seen) || seen <= file.rowIdFloor) return;
      file.rowIdFloor = seen;
      await this.commit(file);
    });
  }

  async view(): Promise<WorkflowRunView> {
    const file = await this.read();
    if (file === undefined) return { pendingReview: true, get: () => ({ status: "pending-review" }) };
    return {
      pendingReview: false, unreadable: unreadableEntries(file), get: runId => lookup(file, runId).result,
      keepWorkspaces: file.runs.every(entry => isRecord(entry) && typeof entry.runId === "string" && entry.runId.length > 0 && entry.runId.length <= 256)
        ? file.runs.flatMap(entry => {
          const runId = (entry as Record<string, unknown>).runId as string;
          const { result } = lookup(file, runId);
          return result.status === "found" && result.run.settled !== undefined ? [] : [runId];
        }) : undefined,
      missing: runId => lookup(file, runId).result.status === "not-found" && file.runs.every(entry => isRecord(entry) && typeof entry.runId === "string"),
    };
  }

  /** Remove the entry at `position` that does not read as a run, only while its hash is `hash` and it passes `allowed`; the file as it
   * was is kept beside it first. `changed` when no such entry is there or the file awaits review or is past its read limit; `refused`
   * when it does not pass; `too-large` when the file left would be past it. A file that cannot be read throws. */
  async discardUnreadable(target: { position: number; hash: string }, allowed: (entry: unknown) => boolean | Promise<boolean>): Promise<"discarded" | "changed" | "refused" | "too-large"> {
    return withInProcessFileQueue(this.filePath, async () => {
      const read = await this.load();
      if (!read?.bytes || !unreadableEntries(read.file).some(entry => entry.position === target.position && entry.hash === target.hash)) return "changed";
      if (!(await allowed(read.file.runs[target.position]))) return "refused";
      read.file.runs.splice(target.position, 1);
      return (await this.commit(read.file, true)) ? "discarded" : "too-large";
    });
  }

  /** A found run always carries `settled`, undefined while it has not ended. */
  async get(runId: string): Promise<WorkflowRunReadResult> {
    const read = (await this.view()).get(runId);
    if (read.status !== "found") return read;
    const { settled } = read.run;
    return { ...read, run: { ...read.run, settled } };
  }

  /** Store, before the board write that deletes row `intent.itemId`, that the user deletes it: the engine ends its run as its row removed,
   * after a crash too, and the intent goes with the write that ends the run. `none`, with nothing written, when the file holds no
   * readable unsettled run of that row under that id; `pending-review` while the file awaits review or is past its read limit;
   * `too-large` when the file would be. A file that cannot be read throws. A delete of what holds an earlier delete's marker (`held`, the
   * markers the board just read leaves held) publishes the intent afresh: the same write drops those markers, in the file and in memory. */
  async markDeleted(intent: DeleteIntent, held: (marker: DeleteMarker) => boolean = () => false): Promise<"marked" | "none" | "pending-review" | "too-large"> {
    return withInProcessFileQueue(this.filePath, async () => {
      const file = await this.read();
      if (file === undefined) return "pending-review";
      if (!openIntent(file, intent)) return "none";
      const intents = file.deleteIntents ?? [];
      const stale = (marker: DeleteMarker | undefined): boolean => marker !== undefined && samePair(intent)(marker) && held(marker);
      const dropping = (file.unknownDeletes ?? []).some(entry => stale(markerOf(entry))) || this.unknown.some(stale);
      if (intents.some(sameIntent(intent)) && !dropping) return "marked";
      if (!intents.some(sameIntent(intent))) file.deleteIntents = [...intents, { itemId: intent.itemId, runId: intent.runId }];
      file.unknownDeletes = dropFrom(file.unknownDeletes, entry => stale(markerOf(entry)));
      if (!(await this.commit(file))) return "too-large";
      this.unknown = this.unknown.filter(marker => !stale(marker));
      return "marked";
    });
  }

  /** The markers of the delete of that pair: in the file and in memory. Empty while the file cannot be read. */
  async markersOf(intent: DeleteIntent): Promise<DeleteMarker[]> {
    const file = await this.read().catch(() => undefined);
    return [...(file === undefined ? [] : markersIn(file)), ...this.unknown].filter(samePair(intent));
  }

  /** Take back the intent of a delete that did not land, with every marker of that pair. It counts once a read of the file again holds
   * neither, whatever the write reported: true then. Otherwise the delete stays unknown as `operation` (see markUnknown), never read as not
   * landed, and false. */
  async withdrawIntent(intent: DeleteIntent, operation?: MarkerOp): Promise<boolean> {
    await withInProcessFileQueue(this.filePath, async () => {
      const file = await this.read();
      if (file === undefined || !holdsDelete(file, intent)) return;
      file.deleteIntents = dropFrom(file.deleteIntents, sameIntent(intent));
      file.unknownDeletes = dropFrom(file.unknownDeletes, aboutPair(intent));
      await this.commit(file);
    }).catch(() => undefined);
    const file = await this.read().catch(() => undefined);
    if (file !== undefined && !holdsDelete(file, intent)) {
      this.unknown = this.unknown.filter(marker => !samePair(intent)(marker));
      return true;
    }
    await this.markUnknown(intent, operation);
    return false;
  }

  /** A delete step whose outcome is not known, as `operation`: the store holds it in memory, and stores it as a marker beside the intents
   * so it outlives a restart; while either holds it the run classifies as unreadable. It goes once resolveUnknown decides it. A marker
   * that cannot be written stays in memory only. Given the pair alone (only tests do), it is a row's delete that stored its intent. */
  async markUnknown(intent: DeleteIntent, operation: MarkerOp = { op: "row", ownIntent: true }): Promise<void> {
    const marker: DeleteMarker = { itemId: intent.itemId, runId: intent.runId, operation };
    if (!this.unknown.some(sameMarker(marker))) this.unknown = [...this.unknown, marker];
    await withInProcessFileQueue(this.filePath, async () => {
      const file = await this.read();
      if (file === undefined || markersIn(file).some(sameMarker(marker))) return;
      file.unknownDeletes = [...(file.unknownDeletes ?? []), markerEntry(marker)];
      await this.commit(file);
    }).catch(() => undefined);
  }

  /** Whether a delete's outcome is unknown: a marker in the file, or one held in memory. False while the file cannot be read. */
  async hasUnknown(): Promise<boolean> {
    if (this.unknown.length > 0) return true;
    const file = await this.read().catch(() => undefined);
    return file !== undefined && markersIn(file).length > 0;
  }

  /** Resolve every delete whose outcome is unknown (see markerOutcome): `unlanded` takes back its intent with the marker, `landed` drops
   * only the marker, `held` keeps both. Each decided one counts once a read of the file again holds no such marker (and, not landed, no
   * intent); the rest stay unknown. */
  async resolveUnknown(outcome: (marker: DeleteMarker) => "unlanded" | "landed" | "held"): Promise<void> {
    let back: DeleteMarker[] = [];
    let decided = new Set<DeleteMarker>();
    await withInProcessFileQueue(this.filePath, async () => {
      const file = await this.read();
      if (file === undefined) return;
      for (const marker of markersIn(file)) {
        if (!this.unknown.some(sameMarker(marker))) this.unknown = [...this.unknown, marker];
      }
      const memory = this.unknown;
      const outcomes = new Map(memory.map(marker => [marker, outcome(marker)]));
      decided = new Set(memory.filter(marker => outcomes.get(marker) !== "held"));
      if (decided.size === 0) return;
      back = memory.filter(marker => outcomes.get(marker) === "unlanded");
      file.deleteIntents = dropFrom(file.deleteIntents, entry => back.some(marker => sameIntent(marker)(entry)));
      file.unknownDeletes = dropFrom(file.unknownDeletes, (entry) => {
        const marker = markerOf(entry);
        return marker !== undefined && [...decided].some(sameMarker(marker));
      });
      await this.commit(file);
    }).catch(() => undefined);
    if (decided.size === 0) return;
    const file = await this.read().catch(() => undefined);
    if (file === undefined) return;
    const stored = markersIn(file);
    this.unknown = this.unknown.filter(marker => !decided.has(marker) || stored.some(sameMarker(marker))
      || (back.includes(marker) && (file.deleteIntents ?? []).some(sameIntent(marker))));
  }

  /** Holds a scheduler event of a run (work-board-run-ending.md, Held events), stored once by its identity; one of a run that is not open
   * goes at once, as for an intent. False while the file awaits review or has no room; a file that cannot be read or written throws. */
  async holdEvent(held: HeldEvent): Promise<boolean> {
    return withInProcessFileQueue(this.filePath, async () => {
      const file = await this.read();
      if (file === undefined) return false;
      if ((file.heldEvents ?? []).some(sameHeld(held, held))) return true;
      const { itemId, runId, stage, attempt, kind } = held;
      file.heldEvents = [...(file.heldEvents ?? []), { itemId, runId, stage, attempt, kind }];
      return this.commit(file);
    });
  }

  /** Drops the held event of that identity of a run, or, without one, every held event of the run. */
  async dropHeld(run: DeleteIntent, identity?: HeldIdentity): Promise<void> {
    return withInProcessFileQueue(this.filePath, async () => {
      const file = await this.read();
      if (file === undefined || !(file.heldEvents ?? []).some(sameHeld(run, identity))) return;
      file.heldEvents = dropFrom(file.heldEvents, sameHeld(run, identity));
      await this.commit(file);
    });
  }

  /** The held events of a run, in the order they were held. A file that cannot be read throws. */
  async heldEvents(run: DeleteIntent): Promise<HeldEvent[]> {
    const file = await this.read();
    return (file?.heldEvents ?? []).flatMap((entry) => {
      const held = heldOf(entry);
      return held !== undefined && samePair(run)(held) ? [held] : [];
    });
  }

  /** The delete intents whose run is still to end. Undefined while the file awaits review or is past its read limit; a file that cannot
   * be read throws. */
  async deleteIntents(): Promise<DeleteIntent[] | undefined> {
    const file = await this.read();
    return file && openIntents(file);
  }

  /** One read of the file for classifyRun: the open delete intents, and what the file says of a run (a record under its id that does not
   * validate, is stored twice or belongs to another row reads as unreadable; an intent is open only for a readable, unsettled record of
   * that row). Undefined while the file awaits review or is past its read limit; a file that cannot be read throws. */
  async runFacts(): Promise<{ intents: DeleteIntent[]; of: (run: DeleteIntent) => RunFileFacts } | undefined> {
    const file = await this.read();
    if (file === undefined) return undefined;
    return { intents: openIntents(file), of: factsIn(file, this.unknown) };
  }

  /** What a board write must keep: `held`, the run id of every entry that is not a settled run (an unsettled run, or an entry that does
   * not read as one and could be), and the delete intents of unsettled runs, which alone let a delete take a held id out. Undefined while
   * the file awaits review, is past its read limit or cannot be read. */
  async heldRuns(): Promise<{ held: ReadonlySet<string>; intents: readonly DeleteIntent[] } | undefined> {
    const file = await this.read().catch(() => undefined);
    if (file === undefined) return undefined;
    const held = new Set<string>();
    for (const entry of file.runs) {
      if (!isRecord(entry) || typeof entry.runId !== "string") continue;
      const { result } = lookup(file, entry.runId);
      if (result.status !== "found" || result.run.settled === undefined) held.add(entry.runId);
    }
    return { held, intents: openIntents(file) };
  }

  /** Every readable run, whether or not a row names it: what the engine adopts back at boot. Unreadable and repeated entries are left
   * out, as get() refuses them; nothing is listed while the file awaits review. */
  async list(): Promise<WorkflowRunListResult> {
    const file = await this.read();
    if (file === undefined) return { status: "pending-review" };
    const runs: WorkflowRunRecord[] = [];
    for (const entry of file.runs) {
      if (!isRecord(entry) || typeof entry.runId !== "string") continue;
      const { result } = lookup(file, entry.runId);
      if (result.status === "found") runs.push(result.run);
    }
    return { status: "found", runs };
  }

  /** Store a new run that is not over, or replace one whose item, pin, start authority and end are unchanged. The same write applies
   * `retain` to the other runs. */
  async put(record: WorkflowRunRecord, retain?: WorkflowRunRetention): Promise<WorkflowRunWriteResult> {
    assertWorkflowRunRecord(record);
    return this.write(record.runId, prior => prior ?? record, () => record, retain && (run => run.runId === record.runId ? run : retain(run))) as Promise<WorkflowRunWriteResult>;
  }

  /** Whether a run that is not over may be on a row below `id`: true for a readable one, and while the file awaits review, is past its read
   * limit or holds an entry that does not read as a run, since that could be one. A file that cannot be read throws. */
  async openRunBelow(id: number): Promise<boolean> {
    const file = await this.read();
    if (file === undefined) return true;
    return file.runs.some((entry) => {
      if (!isRecord(entry) || typeof entry.runId !== "string") return true;
      const { result } = lookup(file, entry.runId);
      return result.status !== "found" || (result.run.settled === undefined && result.run.itemId < id);
    });
  }

  // The listener's failure is its own: the removal is already stored.
  private runsRemoved(runIds: readonly string[]): void {
    if (runIds.length === 0) return;
    try { this.onRunsRemoved?.(runIds); }
    catch (error) { log.warn("[workflow-run-store] removed runs were not announced: %s", (error as Error).message); }
  }

  /** Apply `retain` to every readable run. Nothing is written while the file awaits review or when no run changes. */
  async prune(retain: WorkflowRunRetention): Promise<void> {
    return withInProcessFileQueue(this.filePath, async () => {
      const file = await this.read();
      const removed: string[] = [];
      if (file !== undefined && retainRuns(file, retain, removed) && await this.commit(file)) this.runsRemoved(removed);
    });
  }

  /** Change a stored run under the file lock, never how it ended: a change of `settled` is refused (see settleRun). `mutate` returns null
   * to refuse; it never runs for a missing or unreadable run. */
  async update(runId: string, mutate: (run: WorkflowRunRecord) => WorkflowRunRecord | null): Promise<WorkflowRunWriteResult> {
    return this.write(runId, prior => prior, mutate) as Promise<WorkflowRunWriteResult>;
  }

  /** The one write that ends a run, and so the only one that sets `settled`. `step`, from the run as stored now, returns its next state,
   * or a RunEnd: its final state and why it ends; `settled` is then set from that cause in the same write, and the run's delete intent
   * goes with it. A cause `allowed` refuses on what the file holds of the run, read inside the lock, writes nothing (`cause-refused`); so
   * does an end of a run already over (`refused`). */
  async settleRun(runId: string, step: (run: WorkflowRunRecord) => WorkflowRunRecord | RunEnd | null, allowed: (cause: RunEndCause, run: RunFileFacts) => boolean): Promise<WorkflowRunWriteResult | { status: "cause-refused" }> {
    return this.write(runId, prior => prior, step, undefined, allowed);
  }

  // Without `allowed` no write may end a run; a run's end, once stored, never changes.
  private write(
    runId: string,
    base: (prior: WorkflowRunRecord | undefined) => WorkflowRunRecord | undefined,
    next: (run: WorkflowRunRecord) => WorkflowRunRecord | RunEnd | null,
    retain?: WorkflowRunRetention,
    allowed?: (cause: RunEndCause, run: RunFileFacts) => boolean,
  ): Promise<WorkflowRunWriteResult | { status: "cause-refused" }> {
    return withInProcessFileQueue(this.filePath, async (): Promise<WorkflowRunWriteResult | { status: "cause-refused" }> => {
      const file = await this.read();
      if (file === undefined) return { status: "pending-review" };
      const removed: string[] = [];
      if (retain) retainRuns(file, retain, removed);
      const { result, index } = lookup(file, runId);
      if (result.status === "invalid" || result.status === "pending-review") return result;
      const stored = result.status === "found" ? result.run.settled : undefined;
      const prior = base(result.status === "found" ? result.run : undefined);
      if (prior === undefined) return { status: "not-found" };
      const step = next(structuredClone(prior));
      if (step === null) return { status: "refused" };
      const end = isRunEnd(step) ? step : undefined;
      let run = end ? end.run : step as WorkflowRunRecord;
      assertWorkflowRunRecord(run);
      requireTemplate(bindingOf(run) === bindingOf(prior) && sameEnd(run.settled, stored), "invalid-template-run");
      if (end) {
        if (allowed === undefined) throw new WorkflowTemplateError("invalid-template-run");
        if (stored !== undefined) return { status: "refused" };
        if (!allowed(end.ends, factsIn(file, this.unknown)(run))) return { status: "cause-refused" };
        run = { ...run, settled: { status: SETTLED_AS[end.ends], at: end.at } };
        assertWorkflowRunRecord(run);
      }
      if (index === -1) file.runs.push(run); else file.runs[index] = run;
      if (!(await this.commit(file))) return { status: "too-large" };
      this.runsRemoved(removed);
      return { status: "stored", run: structuredClone(run) };
    });
  }

  // A file past the read limit could not be read again, so nothing could shrink it afterwards: such a write is refused and the file stays as it is.
  // Bytes it would not give back, and the file before a discard, are copied beside it first.
  private async commit(file: RunsFile, discard = false): Promise<boolean> {
    file.rowIdFloor = floorOver(file.runs, file.rowIdFloor);
    keepOpenIntents(file);
    const text = fileText(file);
    if (Buffer.byteLength(text, "utf8") > AVE_HOME_INPUT_MAX_BYTES) return false;
    await rewriteKeepingBytes(this.filePath, text, { tag: "invalid-runs", ...(discard ? {} : { unchanged: file.unchanged }) });
    return true;
  }
}
