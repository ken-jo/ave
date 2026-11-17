import { createHash } from "node:crypto";
import { join } from "node:path";
import { openFeatureNamespace } from "./storage/feature-namespace.js";
import { rewriteKeepingBytes } from "./storage/rewrite-keeping-bytes.js";
import { AVE_HOME_INPUT_MAX_BYTES, AveHomeInputSizeLimitError, readAveHomeInput } from "../shared/ave-home-trust.js";
import { withInProcessFileQueue } from "../lib/with-file-lock.js";
import { isRecord } from "../shared/is-record.js";
import { canonicalWorkflowJson } from "../shared/workflow-template-output.js";
import { requireTemplate, WorkflowTemplateError } from "../work-board/template-graph.js";
import { assertWorkflowRunRecord } from "../work-board/template-run-fields.js";
import type { WorkflowRunListResult, WorkflowRunReadResult, WorkflowRunRecord, WorkflowRunWriteResult } from "../shared/workflow-template-types.js";

/** `rowIdFloor`: the highest board row id ever issued or seen. A file without it reads as 0; the floor read is never below any stored run's
 * itemId, and every write stores it, so it never goes down. */
// `legacyBoardCopy`: the copy of a legacy board, as stored; it is only read by the copy and the board writes that wait on it, and written
// back as it is. `raw`, the file's top-level object as read: a write writes its other keys back as they were, in their place; `unchanged`,
// the text a write writes for the file as read.
interface RunsFile { version: 1; rowIdFloor: number; runs: unknown[]; legacyBoardCopy?: unknown; raw?: Record<string, unknown>; unchanged?: string }
/** An entry of the run file that get() refuses: `position`, its index among the file's runs; `hash`, the sha-256 of its JSON; `itemId`, the
 * row it names when that reads as a row id. */
interface WorkflowRunUnreadable { position: number; hash: string; itemId?: number }
/** One read of the run file, for a caller that looks up several runs; `unreadable`, every entry of it that does not read as a run;
 * `missing`, true only when the file read holds no entry under that run id and no entry without a string runId that could be it. */
export interface WorkflowRunView {
  readonly pendingReview: boolean;
  readonly unreadable?: readonly WorkflowRunUnreadable[];
  get(runId: string): WorkflowRunReadResult;
  missing?(runId: string): boolean;
}
/** What a write does with another readable run: null removes it, a record replaces it (same item, pin and start authority). */
export type WorkflowRunRetention = (run: WorkflowRunRecord) => WorkflowRunRecord | null;

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
function retainRuns(file: RunsFile, retain: WorkflowRunRetention): boolean {
  const count = new Map<unknown, number>();
  for (const entry of file.runs) if (isRecord(entry)) count.set(entry.runId, (count.get(entry.runId) ?? 0) + 1);
  let changed = false;
  const kept: unknown[] = [];
  for (const entry of file.runs) {
    if (!isRecord(entry) || count.get(entry.runId) !== 1) { kept.push(entry); continue; }
    try { assertWorkflowRunRecord(entry); }
    catch (error) { if (error instanceof WorkflowTemplateError) { kept.push(entry); continue; } throw error; }
    const next = retain(structuredClone(entry));
    if (next === null) { changed = true; continue; }
    assertWorkflowRunRecord(next);
    requireTemplate(bindingOf(next) === bindingOf(entry), "invalid-template-run");
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
  constructor(private readonly filePath = join(openFeatureNamespace("work-board").dir, "workflow-runs.json")) {}

  /** The file, or undefined while it awaits home content review. Any other read failure throws. */
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
    let raw: unknown;
    try { raw = JSON.parse(input.bytes.toString("utf8")); } catch { throw new WorkflowTemplateError("invalid-template-run"); }
    requireTemplate(isRecord(raw) && raw.version === 1 && Array.isArray(raw.runs) && (raw.rowIdFloor === undefined || isRowId(raw.rowIdFloor)), "invalid-template-run");
    const runs: unknown[] = raw.runs;
    const copy = raw.legacyBoardCopy === undefined ? {} : { legacyBoardCopy: raw.legacyBoardCopy };
    const file: RunsFile = { version: 1, rowIdFloor: floorOver(runs, (raw.rowIdFloor as number | undefined) ?? 0), runs, ...copy, raw };
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

  async get(runId: string): Promise<WorkflowRunReadResult> {
    return (await this.view()).get(runId);
  }

  /** Every string run id an entry of the file holds, readable or not; undefined while the file awaits review, is past its read limit or
   * cannot be read. */
  async runIds(): Promise<ReadonlySet<string> | undefined> {
    const file = await this.read().catch(() => undefined);
    return file && new Set(file.runs.flatMap(entry => isRecord(entry) && typeof entry.runId === "string" ? [entry.runId] : []));
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

  /** Store a new run, or replace one whose item, pin and start authority are unchanged. The same write applies `retain` to the other runs. */
  async put(record: WorkflowRunRecord, retain?: WorkflowRunRetention): Promise<WorkflowRunWriteResult> {
    assertWorkflowRunRecord(record);
    return this.write(record.runId, prior => prior ?? record, () => record, retain && (run => run.runId === record.runId ? run : retain(run)));
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

  /** Apply `retain` to every readable run. Nothing is written while the file awaits review or when no run changes. */
  async prune(retain: WorkflowRunRetention): Promise<void> {
    return withInProcessFileQueue(this.filePath, async () => {
      const file = await this.read();
      if (file !== undefined && retainRuns(file, retain)) await this.commit(file);
    });
  }

  /** Change a stored run under the file lock. `mutate` returns null to refuse; it never runs for a missing or unreadable run. */
  async update(runId: string, mutate: (run: WorkflowRunRecord) => WorkflowRunRecord | null): Promise<WorkflowRunWriteResult> {
    return this.write(runId, prior => prior, mutate);
  }

  private write(
    runId: string,
    base: (prior: WorkflowRunRecord | undefined) => WorkflowRunRecord | undefined,
    next: (run: WorkflowRunRecord) => WorkflowRunRecord | null,
    retain?: WorkflowRunRetention,
  ): Promise<WorkflowRunWriteResult> {
    return withInProcessFileQueue(this.filePath, async (): Promise<WorkflowRunWriteResult> => {
      const file = await this.read();
      if (file === undefined) return { status: "pending-review" };
      if (retain) retainRuns(file, retain);
      const { result, index } = lookup(file, runId);
      if (result.status === "invalid" || result.status === "pending-review") return result;
      const prior = base(result.status === "found" ? result.run : undefined);
      if (prior === undefined) return { status: "not-found" };
      const run = next(structuredClone(prior));
      if (run === null) return { status: "refused" };
      assertWorkflowRunRecord(run);
      requireTemplate(bindingOf(run) === bindingOf(prior), "invalid-template-run");
      if (index === -1) file.runs.push(run); else file.runs[index] = run;
      if (!(await this.commit(file))) return { status: "too-large" };
      return { status: "stored", run: structuredClone(run) };
    });
  }

  // A file past the read limit could not be read again, so nothing could shrink it afterwards: such a write is refused and the file stays as it is.
  // Bytes it would not give back, and the file before a discard, are copied beside it first.
  private async commit(file: RunsFile, discard = false): Promise<boolean> {
    file.rowIdFloor = floorOver(file.runs, file.rowIdFloor);
    const text = fileText(file);
    if (Buffer.byteLength(text, "utf8") > AVE_HOME_INPUT_MAX_BYTES) return false;
    await rewriteKeepingBytes(this.filePath, text, { tag: "invalid-runs", ...(discard ? {} : { unchanged: file.unchanged }) });
    return true;
  }
}
