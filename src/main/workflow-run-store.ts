import { join } from "node:path";
import { openFeatureNamespace, writeFileAtomicAtPath } from "./storage/feature-namespace.js";
import { AveHomeInputSizeLimitError, readAveHomeInput } from "../shared/ave-home-trust.js";
import { withInProcessFileQueue } from "../lib/with-file-lock.js";
import { isRecord } from "../shared/is-record.js";
import { canonicalWorkflowJson } from "../shared/workflow-template-output.js";
import { requireTemplate, WorkflowTemplateError } from "../work-board/template-graph.js";
import { assertWorkflowRunRecord } from "../work-board/template-run-fields.js";
import type { WorkflowRunReadResult, WorkflowRunRecord, WorkflowRunWriteResult } from "../shared/workflow-template-types.js";

interface RunsFile { version: 1; runs: unknown[] }
/** One read of the run file, for a caller that looks up several runs. */
export interface WorkflowRunView { readonly pendingReview: boolean; get(runId: string): WorkflowRunReadResult }

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
    if (input.status === "absent") return { version: 1, runs: [] };
    if (input.status === "untrusted") return undefined;
    let raw: unknown;
    try { raw = JSON.parse(input.bytes.toString("utf8")); } catch { throw new WorkflowTemplateError("invalid-template-run"); }
    requireTemplate(isRecord(raw) && raw.version === 1 && Array.isArray(raw.runs), "invalid-template-run");
    return { version: 1, runs: raw.runs };
  }

  async view(): Promise<WorkflowRunView> {
    const file = await this.read();
    if (file === undefined) return { pendingReview: true, get: () => ({ status: "pending-review" }) };
    return { pendingReview: false, get: runId => lookup(file, runId).result };
  }

  async get(runId: string): Promise<WorkflowRunReadResult> {
    return (await this.view()).get(runId);
  }

  /** Store a new run, or replace one whose item, pin and start authority are unchanged. */
  async put(record: WorkflowRunRecord): Promise<WorkflowRunWriteResult> {
    assertWorkflowRunRecord(record);
    return this.write(record.runId, prior => prior ?? record, () => record);
  }

  /** Change a stored run under the file lock. `mutate` returns null to refuse; it never runs for a missing or unreadable run. */
  async update(runId: string, mutate: (run: WorkflowRunRecord) => WorkflowRunRecord | null): Promise<WorkflowRunWriteResult> {
    return this.write(runId, prior => prior, mutate);
  }

  private write(
    runId: string,
    base: (prior: WorkflowRunRecord | undefined) => WorkflowRunRecord | undefined,
    next: (run: WorkflowRunRecord) => WorkflowRunRecord | null,
  ): Promise<WorkflowRunWriteResult> {
    return withInProcessFileQueue(this.filePath, async (): Promise<WorkflowRunWriteResult> => {
      const file = await this.read();
      if (file === undefined) return { status: "pending-review" };
      const { result, index } = lookup(file, runId);
      if (result.status === "invalid" || result.status === "pending-review") return result;
      const prior = base(result.status === "found" ? result.run : undefined);
      if (prior === undefined) return { status: "not-found" };
      const run = next(structuredClone(prior));
      if (run === null) return { status: "refused" };
      assertWorkflowRunRecord(run);
      requireTemplate(bindingOf(run) === bindingOf(prior), "invalid-template-run");
      if (index === -1) file.runs.push(run); else file.runs[index] = run;
      await writeFileAtomicAtPath(this.filePath, `${JSON.stringify(file, null, 2)}\n`);
      return { status: "stored", run: structuredClone(run) };
    });
  }
}
