import { resultHashOf } from "../../shared/workflow-template-output.js";
import type { RunAuthoritySource, RunWorkspace, StageJoin, WorkItemStageRun } from "../../shared/workflow-template-types.js";
import type { RunPin } from "./shipped-shapes.js";

/** Everything a template run is decided from. It lives in the covered run file, keyed by `runId`; a board row names a run only by that id
 * and nothing on a board row is ever read as one of these fields. */
export interface RunRecord {
  runId: string;
  itemId: number;
  pin: RunPin;
  startedBy: RunAuthoritySource;
  /** The project the run was started on; the run authority compares it at every spawn. */
  projectRoot?: string;
  status: "executing" | "completed" | "denied" | "error" | "cancelled";
  stageRuns: WorkItemStageRun[];
  stageJoins: StageJoin[];
  workspace?: RunWorkspace;
  startedAt: string;
  updatedAt: string;
}

/** The one reader and writer of run state the stage scheduler uses. */
export interface WorkflowRunState {
  /** Stores a new run; rejects when the id is already known. */
  begin(run: RunRecord): Promise<void>;
  get(runId: string): Promise<RunRecord | null>;
  /** One atomic read-modify-write. Null when no such run exists. */
  update(runId: string, mutate: (run: RunRecord) => RunRecord): Promise<RunRecord | null>;
  /** Every run whose status is `executing`. */
  listUnsettled(): Promise<RunRecord[]>;
}

/** The default until the run file is wired: nothing is stored, so no template run can start. */
export const unavailableRunState: WorkflowRunState = {
  begin: async () => { throw new Error("run state is not available"); },
  get: async () => null,
  update: async () => null,
  listUnsettled: async () => [],
};

/** A template run waits for the user: a stage is at its gate, or a join could not be collected. The run itself stays `executing`. */
export function isAwaitingStageReview(run: Pick<RunRecord, "status" | "stageRuns" | "stageJoins">): boolean {
  if (run.status !== "executing") return false;
  return run.stageRuns.some(stage => stage.status === "awaiting_gate") || run.stageJoins.some(join => join.status === "conflict");
}

/** What a restart leaves of an unsettled run: a run that waits for the user, and nothing starts. A stage that was running lost its child
 * and fails as interrupted; a gate stays only while its stored output still matches its hash; a join that was being collected becomes a
 * conflict the user decides; a kept stage whose workspace folder is gone fails as workspace-lost. Null when nothing changes. */
export async function reconcileRunRecord(run: RunRecord, now: string, folderExists: (root: string) => Promise<boolean>): Promise<RunRecord | null> {
  let changed = false;
  const collected = new Set(run.stageJoins.filter(join => join.status === "integrated").flatMap(join => join.stageIds));
  const stageRuns: WorkItemStageRun[] = [];
  for (const stage of run.stageRuns) {
    const gateWhole = stage.status === "awaiting_gate" && typeof stage.output === "string" && stage.resultHash === resultHashOf(stage.output);
    const kept = gateWhole || (stage.status === "passed" && !collected.has(stage.stageId));
    let failure: WorkItemStageRun["failure"];
    if (stage.status === "running" || (stage.status === "awaiting_gate" && !gateWhole)) failure = "interrupted";
    else if (kept && stage.workspace && !(await folderExists(stage.workspace.root))) failure = "workspace-lost";
    if (failure === undefined) {
      stageRuns.push(stage);
      continue;
    }
    changed = true;
    const failed: WorkItemStageRun = { ...stage, status: "failed", failure, endedAt: stage.endedAt ?? now };
    delete failed.resultHash;
    stageRuns.push(failed);
  }
  const stageJoins = run.stageJoins.map((join): StageJoin => {
    if (join.status !== "integrating") return join;
    changed = true;
    return { ...join, status: "conflict", conflict: { conflictHash: resultHashOf(`${run.runId}:${join.joinId}:interrupted`), reason: "interrupted", files: [] } };
  });
  return changed ? { ...run, stageRuns, stageJoins, updatedAt: now } : null;
}
