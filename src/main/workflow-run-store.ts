import { join } from "node:path";
import { openFeatureNamespace, writeFileAtomicAtPath } from "./storage/feature-namespace.js";
import { AVE_HOME_INPUT_MAX_BYTES, AveHomeInputSizeLimitError, readAveHomeInput } from "../shared/ave-home-trust.js";
import { withInProcessFileQueue } from "../lib/with-file-lock.js";
import { isRecord } from "../shared/is-record.js";
import { canonicalWorkflowJson } from "../shared/workflow-template-output.js";
import { requireTemplate, WorkflowTemplateError } from "../work-board/template-graph.js";
import { assertWorkflowRunRecord } from "../work-board/template-run-fields.js";
import type { WorkflowRunListResult, WorkflowRunReadResult, WorkflowRunRecord, WorkflowRunWriteResult } from "../shared/workflow-template-types.js";

/** `rowIdFloor`: the highest board row id ever issued or seen. A file without it reads as 0; the floor read is never below any stored run's
 * itemId, and every write stores it, so it never goes down. */
interface RunsFile { version: 1; rowIdFloor: number; runs: unknown[] }
/** One read of the run file, for a caller that looks up several runs. */
export interface WorkflowRunView { readonly pendingReview: boolean; get(runId: string): WorkflowRunReadResult }
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

const isRowId = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const floorOver = (runs: readonly unknown[], floor: number): number =>
  runs.reduce<number>((highest, entry) => isRecord(entry) && isRowId(entry.itemId) ? Math.max(highest, entry.itemId) : highest, floor);

// Which item a run belongs to and what authorised it never change after the first write.
function bindingOf(run: WorkflowRunRecord): string {
  return canonicalWorkflowJson({ runId: run.runId, itemId: run.itemId, pin: run.pin, runStartedBy: run.runStartedBy });
}

/** Template-run state in the covered `work-board/workflow-runs.json`, keyed by runId. */
export class WorkflowRunStore {
  constructor(private readonly filePath = join(openFeatureNamespace("work-board").dir, "workflow-runs.json")) {}

  /** The file, or undefined while it awaits home content review. Any other read failure throws. */
  private async read(): Promise<RunsFile | undefined> {
    let input: Awaited<ReturnType<typeof readAveHomeInput>>;
    try { input = await readAveHomeInput(this.filePath); }
    catch (error) { if (error instanceof AveHomeInputSizeLimitError) return undefined; throw error; }
    if (input.status === "absent") return { version: 1, rowIdFloor: 0, runs: [] };
    if (input.status === "untrusted") return undefined;
    let raw: unknown;
    try { raw = JSON.parse(input.bytes.toString("utf8")); } catch { throw new WorkflowTemplateError("invalid-template-run"); }
    requireTemplate(isRecord(raw) && raw.version === 1 && Array.isArray(raw.runs) && (raw.rowIdFloor === undefined || isRowId(raw.rowIdFloor)), "invalid-template-run");
    const runs: unknown[] = raw.runs;
    return { version: 1, rowIdFloor: floorOver(runs, (raw.rowIdFloor as number | undefined) ?? 0), runs };
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
    return { pendingReview: false, get: runId => lookup(file, runId).result };
  }

  async get(runId: string): Promise<WorkflowRunReadResult> {
    return (await this.view()).get(runId);
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
  private async commit(file: RunsFile): Promise<boolean> {
    file.rowIdFloor = floorOver(file.runs, file.rowIdFloor);
    const text = `${JSON.stringify(file, null, 2)}\n`;
    if (Buffer.byteLength(text, "utf8") > AVE_HOME_INPUT_MAX_BYTES) return false;
    await writeFileAtomicAtPath(this.filePath, text);
    return true;
  }
}
